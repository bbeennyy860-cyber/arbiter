"""Arbiter demo web server.

Serves the live demo the judges watch:

  GET  /state            -> the whole demo state as one JSON object (dashboard polls this)
  POST /run              -> start playing the scenario timeline
  POST /reset            -> rebuild a fresh agent/ledger so the demo can replay
  GET/POST /approve/{id} -> owner approves a parked escalation
  GET/POST /deny/{id}    -> owner denies a parked escalation

The escalation is the point. When the agent defers an ambiguous money decision,
the demo thread genuinely *blocks* until a real owner tap resolves it — the
human-in-the-loop trust beat is real here, not auto-approved. A phone hitting the
approve link (a GET) resolves the same gate the dashboard button (a POST) does.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from ..agent import ArbiterAgent
from ..agent.nim_nemotron import select_nemotron
from ..agent.spend_judge import select_spend_judge
from ..business_day import business_day_events
from ..ledger import EventLedger, reconcile
from ..models import AgentEvent, EventKind, DecisionKind
from ..policy import evaluate
from ..agent.agent import TRUST_MODES
from ..metrics import reinvest_improvement
from ..operator import BusinessOperator, demo_jobs
from ..procurement import ProcurementScout, demo_catalog
from ..policy.config import (
    PolicyConfigError,
    demo_owner_policy,
    normalize_policy_config,
    policy_context_from_dict,
)
from ..policy.red_team import run_red_team
from ..stripe_glue import select_stripe

DASHBOARD_DIR = Path(__file__).resolve().parent.parent.parent / "dashboard"


class WebEscalation:
    """Escalation handler that parks the decision for a real owner tap.

    Implements the EscalationHandler protocol. Instead of auto-approving, it
    publishes the pending event through ``pending`` (which /state exposes) and
    blocks the calling thread on a gate until /approve or /deny releases it.
    That blocking is deliberate: it makes the "ask the owner" beat a real pause,
    so the dashboard genuinely waits on a human the way the product would.
    """

    def __init__(self) -> None:
        self._gate = threading.Event()
        self._decision: DecisionKind | None = None
        self.pending: dict | None = None
        # Set by the runner immediately before each decide() so the parked
        # card can name the event the rules layer is deferring on.
        self.current_id: str = ""
        self.current_beat: str = ""

    def request_approval(self, event, result) -> DecisionKind:
        self.pending = {
            "event_id": self.current_id,
            "kind": event.kind.value,
            "beat": self.current_beat,
            "reason": result.reason,
            "risk": round(result.risk_score, 2),
            "amount": event.amount,
            "currency": event.currency,
            "approve_url": f"/approve/{self.current_id}",
            "deny_url": f"/deny/{self.current_id}",
        }
        self._gate.clear()
        self._decision = None
        self._gate.wait()  # block here until the owner acts
        self.pending = None
        # Default to BLOCK if somehow released without a decision: safe-by-default.
        return self._decision or DecisionKind.BLOCK

    def resolve(self, decision: DecisionKind) -> None:
        self._decision = decision
        self._gate.set()


class DemoState:
    """Holds one playthrough of the demo timeline behind the web endpoints."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.owner_policy = demo_owner_policy()
        self.reset()

    def reset(self, trust_mode: str | None = None) -> None:
        trust_mode = trust_mode or "policy_autopilot"
        self.ctx = policy_context_from_dict(self.owner_policy)  # owner setup governs the demo
        self.ledger = EventLedger()
        self.escalation = WebEscalation()
        # The agent is the sole holder of the Stripe rail. select_stripe() gives
        # the real test-mode rail when STRIPE_SECRET_KEY is set, else the stub.
        # No other object gets its own handle — every payment goes through
        # agent.settle(), so nothing can pay around the engine.
        self.agent = ArbiterAgent(
            ctx=self.ctx,
            ledger=self.ledger,
            nemotron=select_nemotron(),
            escalation=self.escalation,
            stripe=select_stripe(),
        )
        self.agent.set_trust_mode(trust_mode)
        self.running = False
        self.done = False
        self.thread: threading.Thread | None = None
        # The autonomous business-operator runs on the SAME agent + ledger, so its
        # earn/verify/spend/refuse decisions stream onto the same timeline the
        # dashboard already polls. None until a run starts. ``operator_mode`` tells
        # the dashboard which story is playing so it can pick the right headline.
        self.operator: BusinessOperator | None = None
        self.operator_mode = False
        self.spend_judge = select_spend_judge()

    @property
    def stripe(self):
        """The single Stripe handle, owned by the agent. Read-only alias so the
        /state snapshot and inbound-earn path share the agent's one rail."""
        return self.agent.stripe

    def _run(self, step_delay: float) -> None:
        """Play the AP-autopilot business day on the shared agent + ledger.

        The coherent story the dashboard streams: revenue in, pay the approved
        suppliers, block the double-pay / overpay / unapproved stranger, and park
        the weak-evidence bank change on a real owner tap. Every beat goes through
        agent.settle() — the single money door — so only an APPROVED decision
        reaches the Stripe rail, and it reaches it the same way every front door
        does (no separate pay path to drift out of sync).
        """
        for event_id, beat, event, seeds in business_day_events():
            if self.agent.trust_mode == "paused":
                break
            # Seed any pre-demo payment fingerprints (for duplicate detection).
            for fp in seeds:
                self.ctx.recent_payment_fingerprints.add((fp[0], fp[1], fp[2]))

            # Tell the escalation handler which event it's about to be asked about.
            self.escalation.current_id = event_id
            self.escalation.current_beat = beat

            # settle = decide + (on approve) execute on the rail. A blocked or
            # escalated decision returns executed=False and never touches Stripe.
            self.agent.settle(event, event_id=event_id, demo_beat=beat)
            time.sleep(step_delay)

        self.done = True
        self.running = False

    def start(self, step_delay: float = 1.2) -> None:
        with self.lock:
            if self.running or self.agent.trust_mode == "paused":
                return
            self.running = True
            self.done = False
            self.operator_mode = False
            self.thread = threading.Thread(target=self._run, args=(step_delay,), daemon=True)
            self.thread.start()

    def _run_operator(self, step_delay: float) -> None:
        """Play the business-operator timeline on the shared agent + ledger.

        Each refused spend is surfaced to the owner through the same web
        escalation gate the scenario demo uses: the worker thread parks on a real
        approve/deny tap before moving on. The refusal itself is final (the agent
        protected its own margin); the tap is the owner acknowledging it — the
        human-in-the-loop beat the judges watch.
        """
        op = self.operator
        assert op is not None

        def on_refused(spend_ctx, result) -> None:
            # Publish a pending card naming the refused spend, then block on the gate.
            self.escalation.current_id = f"{spend_ctx.job_id}:refused:{spend_ctx.tool_name}"
            self.escalation.current_beat = (
                f"Refused: {spend_ctx.tool_name} (£{spend_ctx.cost:.0f}) on '{spend_ctx.job_title}'"
            )
            # request_approval blocks until /approve or /deny; the returned decision
            # doesn't un-refuse the spend, it just records that the owner saw it.
            self.escalation.request_approval(
                AgentEvent(kind=EventKind.SELF_SPEND, amount=spend_ctx.cost,
                           category=spend_ctx.tool_category, message=result.reason),
                result,
            )

        for job in demo_jobs():
            if self.agent.trust_mode == "paused":
                break
            op.run_job(job, on_spend_refused=on_refused)
            time.sleep(step_delay)

        self.done = True
        self.running = False

    def start_operator(self, step_delay: float = 1.2) -> None:
        with self.lock:
            if self.running or self.agent.trust_mode == "paused":
                return
            self.running = True
            self.done = False
            self.operator_mode = True
            self.operator = BusinessOperator(
                agent=self.agent,
                stripe=self.stripe,
                spend_judge=self.spend_judge,
                starting_balance=50.0,
                scout=ProcurementScout(demo_catalog()),
            )
            self.thread = threading.Thread(target=self._run_operator, args=(step_delay,), daemon=True)
            self.thread.start()

    def snapshot(self) -> dict:
        # The capability is acquired once an approved fraud-detection self-spend
        # lands (the reinvest beat), so the autonomy figure ticks up live and
        # honestly. Both numbers are MEASURED by re-running the real agent over
        # the fraud scenario set — see arbiter.metrics — never hardcoded.
        has_capability = self.ledger.spend > 0
        governance = reinvest_improvement()
        current = governance["after"] if has_capability else governance["before"]
        return {
            "running": self.running,
            "done": self.done,
            "earnings": round(self.ledger.earnings, 2),
            "spend": round(self.ledger.spend, 2),
            "net": round(self.ledger.net, 2),
            # Headline meter the dashboard already binds to: the live autonomous-
            # resolution rate (fraud resolved without a human tap). Moves 0.8->1.0
            # the moment the agent reinvests in bank-reconciliation.
            "catch_rate": current["autonomous_rate"],
            # Full honest before/after so the dashboard can show the delta as a
            # real measured number rather than an assertion.
            "governance": governance,
            "has_capability": has_capability,
            "trust_mode": self.agent.trust_mode,
            "trust_controls": {
                "mode": self.agent.trust_mode,
                "modes": list(TRUST_MODES),
            },
            "owner_policy": self.owner_policy,
            "awaiting_approval": self.escalation.pending,
            # When the business-operator is the active story, expose its per-job
            # ledger + rollup so the dashboard can show "watch the business run":
            # balance, revenue, cost, waste blocked, every margin protected.
            "operator_mode": self.operator_mode,
            "business": self.operator.rollup.as_dict() if self.operator is not None else None,
            # The owner's approved-supplier allowlist + which Stripe backend is
            # live, so the dashboard can show "Owner approved: ..." and whether
            # supplier payments are real test-mode obp_... or recorded stubs.
            "approved_payees": sorted(self.ctx.approved_payees) if self.ctx.approved_payees else [],
            "stripe_backend": getattr(self.stripe, "backend", "stub"),
            "supplier_payments": [
                {"payee": c.payee, "amount": c.amount, "currency": c.currency,
                 "stripe_id": c.stripe_id, "ref": c.ref, "failed": getattr(c, "failed", False),
                 "notes": getattr(c, "notes", "")}
                for c in self.stripe.calls if c.op == "pay_supplier"
            ],
            # Inbound money-in objects (real test-mode pi_... when live) so the
            # dashboard can show the earn side with its Stripe ids, not just the
            # payout side. Mirrors supplier_payments for the 'client paid' beat.
            "customer_payments": [
                {"ref": c.ref, "amount": c.amount, "currency": c.currency,
                 "stripe_id": c.stripe_id, "failed": getattr(c, "failed", False),
                 "notes": getattr(c, "notes", "")}
                for c in self.stripe.calls if c.op == "create_payment"
            ],
            # F5-lite: prove the rail matches the ledger's approved spend, to the
            # penny — or surface the gap. Consumes the B0 fix: a failed live call
            # shows here as drift instead of a masked success.
            "reconciliation": reconcile(self.ledger, self.stripe),
            # Row-level settlement receipts: every approved spend that moved money
            # through settle(), joined to the governance event id the dashboard
            # also has on the timeline. Lets the reconciliation strip show
            # "ledger spend == Stripe settled" per row, not just in aggregate.
            "settlements": [
                {
                    "event_id": c.event_id,
                    "kind": "vendor_payment" if c.op == "pay_supplier" else "self_spend",
                    "amount": c.amount,
                    "currency": c.currency,
                    "stripe_id": c.stripe_id,
                    "stripe_object": ("transfer" if c.op == "pay_supplier" else "capability"),
                    "backend": getattr(self.stripe, "backend", "stub"),
                    "failed": getattr(c, "failed", False),
                }
                for c in self.stripe.calls
                if c.op in ("pay_supplier", "provision_capability") and c.event_id
            ],
            "audit_evidence": {
                **self.ledger.audit_summary(),
                "single_money_door": "ArbiterAgent.settle()",
                "policy_source": "backend PolicyContext",
            },
            # insertion order matches dashboard/sample_state.json; the UI reverses
            # for display so the contract fixture and the live feed are identical.
            "timeline": self.ledger.as_timeline(),
        }


app = FastAPI(title="Arbiter", docs_url=None, redoc_url=None)
state = DemoState()


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (DASHBOARD_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/state")
def get_state() -> JSONResponse:
    return JSONResponse(state.snapshot())


@app.post("/run")
def run() -> dict:
    state.start()
    return {"running": state.running, "trust_mode": state.agent.trust_mode}


@app.post("/run_operator")
def run_operator() -> dict:
    """Start the autonomous business-operator timeline (the swing demo).

    Plays paid jobs through earn -> verify -> margin-protected spend on the same
    shared ledger /state exposes, so the dashboard streams the operator's
    decisions and per-job business rollup live.
    """
    state.start_operator()
    return {"running": state.running, "operator_mode": state.operator_mode, "trust_mode": state.agent.trust_mode}


class TrustModeRequest(BaseModel):
    mode: str


class PolicyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spend_cap: float | None = None
    budget_remaining: float | None = None
    allowed_categories: list[str] | None = None
    approved_payees: list[str] | None = None
    duplicate_lookback: int | None = None
    new_vendor_auto_threshold: float | None = None
    detail_change_evidence_threshold: float | None = None


class PolicyReplayRequest(BaseModel):
    """Run an event against current policy and proposed policy without side effects."""

    model_config = ConfigDict(extra="forbid")

    event: dict[str, Any]
    policy: dict[str, Any] = Field(default_factory=dict)


class RedTeamRequest(BaseModel):
    """Run adversarial spend probes against proposed owner policy."""

    model_config = ConfigDict(extra="forbid")

    policy: dict[str, Any] = Field(default_factory=dict)


def _policy_result_payload(result) -> dict:
    return {
        "decision": result.decision.value,
        "reason": result.reason,
        "policy_refs": list(result.policy_refs),
        "risk_score": result.risk_score,
        "decided_by": result.decided_by.value,
    }


def _float_or_none(payload: dict[str, Any], key: str) -> float | None:
    if payload.get(key) is None:
        return None
    if isinstance(payload[key], bool):
        raise ValueError(f"{key} must be a number")
    try:
        return float(payload[key])
    except (TypeError, ValueError):
        raise ValueError(f"{key} must be a number")


def _event_from_payload(payload: dict[str, Any]) -> AgentEvent:
    try:
        kind = EventKind(payload.get("kind"))
    except ValueError:
        raise ValueError(f"unknown event kind {payload.get('kind')!r}")
    try:
        vendor_history_count = int(payload.get("vendor_history_count", 0) or 0)
    except (TypeError, ValueError):
        raise ValueError("vendor_history_count must be an integer")
    return AgentEvent(
        kind=kind,
        amount=_float_or_none(payload, "amount"),
        currency=payload.get("currency") or "GBP",
        vendor_id=payload.get("vendor_id"),
        vendor_known=bool(payload.get("vendor_known", False)),
        vendor_history_count=vendor_history_count,
        invoice_amount=_float_or_none(payload, "invoice_amount"),
        detail_change_evidence=_float_or_none(payload, "detail_change_evidence") or 0.0,
        ref=payload.get("ref"),
        message=payload.get("message") or "",
        category=payload.get("category"),
    )


@app.post("/trust_mode")
def set_trust_mode(req: TrustModeRequest) -> JSONResponse:
    if req.mode not in TRUST_MODES:
        return JSONResponse(
            {"error": f"unknown trust mode {req.mode!r}", "valid_modes": list(TRUST_MODES)},
            status_code=422,
        )
    state.agent.set_trust_mode(req.mode)
    if req.mode == "paused" and state.running:
        # Release any pending gate so the worker can observe the pause and exit.
        state.escalation.resolve(DecisionKind.BLOCK)
    return JSONResponse({"trust_mode": state.agent.trust_mode, "running": state.running})


@app.get("/policy")
def get_policy() -> JSONResponse:
    return JSONResponse({"policy": state.owner_policy, "running": state.running})


@app.post("/policy")
def set_policy(req: PolicyRequest) -> JSONResponse:
    if state.running:
        return JSONResponse({"error": "policy cannot change while a run is active"}, status_code=409)
    fields_set = req.model_fields_set if hasattr(req, "model_fields_set") else req.__fields_set__
    updates = {key: getattr(req, key) for key in fields_set}
    raw = {**state.owner_policy, **updates}
    try:
        policy = normalize_policy_config(raw)
    except PolicyConfigError as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)
    with state.lock:
        state.owner_policy = policy
        trust_mode = state.agent.trust_mode
        state.reset(trust_mode=trust_mode)
    return JSONResponse({"policy": state.owner_policy, "trust_mode": state.agent.trust_mode})


@app.post("/policy/replay")
def replay_policy(req: PolicyReplayRequest) -> JSONResponse:
    """What-if a money event against proposed owner policy, with no ledger/rail mutation."""
    if not isinstance(req.event, dict):
        return JSONResponse({"error": "event must be an object"}, status_code=422)
    try:
        event = _event_from_payload(req.event)
    except (TypeError, ValueError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)

    if not isinstance(req.policy, dict):
        return JSONResponse({"error": "policy must be an object"}, status_code=422)
    raw_policy = {**state.owner_policy, **req.policy}
    try:
        current_ctx = policy_context_from_dict(state.owner_policy)
        replay_policy = normalize_policy_config(raw_policy)
        replay_ctx = policy_context_from_dict(replay_policy)
    except PolicyConfigError as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)

    baseline = evaluate(event, current_ctx)
    replay = evaluate(event, replay_ctx)
    baseline_payload = _policy_result_payload(baseline)
    replay_payload = _policy_result_payload(replay)
    return JSONResponse({
        "event": req.event,
        "current_policy": state.owner_policy,
        "replay_policy": replay_policy,
        "baseline": baseline_payload,
        "replay": replay_payload,
        "changed": baseline_payload != replay_payload,
        "moved_money": False,
        "mutated_state": False,
    })


@app.post("/red_team")
def red_team(req: RedTeamRequest) -> JSONResponse:
    """Run built-in adversarial spend tests against current/proposed policy."""
    if not isinstance(req.policy, dict):
        return JSONResponse({"error": "policy must be an object"}, status_code=422)
    raw_policy = {**state.owner_policy, **req.policy}
    try:
        return JSONResponse(run_red_team(raw_policy))
    except PolicyConfigError as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)


@app.post("/reset")
def reset() -> dict:
    with state.lock:
        if state.running:
            # release any parked escalation so the worker thread can exit
            state.escalation.resolve(DecisionKind.BLOCK)
        trust_mode = state.agent.trust_mode
        state.reset(trust_mode=trust_mode)
    return {"reset": True, "trust_mode": state.agent.trust_mode}


def _resolve(event_id: str, decision: DecisionKind) -> HTMLResponse:
    state.escalation.resolve(decision)
    label = "Approved" if decision == DecisionKind.APPROVE else "Denied"
    # A phone opens the link in a browser; give it a clean confirmation page.
    return HTMLResponse(
        f"<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
        f"<body style='font-family:system-ui;background:#0b0f17;color:#e6edf3;"
        f"display:grid;place-items:center;height:100vh;margin:0'>"
        f"<div style='text-align:center'><div style='font-size:64px'>"
        f"{'&#10003;' if decision == DecisionKind.APPROVE else '&#10007;'}</div>"
        f"<h2>{label}</h2><p style='color:#8b949e'>{event_id}</p>"
        f"<p style='color:#8b949e'>You can return to the dashboard.</p></div></body>"
    )


@app.api_route("/approve/{event_id}", methods=["GET", "POST"])
def approve(event_id: str) -> HTMLResponse:
    return _resolve(event_id, DecisionKind.APPROVE)


@app.api_route("/deny/{event_id}", methods=["GET", "POST"])
def deny(event_id: str) -> HTMLResponse:
    return _resolve(event_id, DecisionKind.BLOCK)


class AuthorizeRequest(BaseModel):
    """A payment an external agent (e.g. a Hermes agent over MCP) wants to make.

    Only ``kind`` and ``amount`` are usually required; the rest give the rules
    engine the context it needs to judge well. Mirrors AgentEvent's flat shape.
    """

    kind: str
    amount: float | None = None
    currency: str = "GBP"
    vendor_id: str | None = None
    vendor_known: bool = False
    vendor_history_count: int = 0
    invoice_amount: float | None = None
    detail_change_evidence: float = 0.0
    ref: str | None = None
    message: str = ""
    category: str | None = None
    event_id: str | None = None
    beat: str | None = None


@app.post("/authorize")
def authorize(req: AuthorizeRequest) -> JSONResponse:
    """Run an externally-submitted payment through the full 3-layer pipeline.

    This is the Hermes-native seam: a Hermes agent calls the Arbiter MCP tool,
    which POSTs here. The event runs through the *same* engine and lands in the
    *same* ledger the dashboard polls — so a decision driven by an autonomous
    agent shows up live on the dashboard exactly like a demo beat.

    If the decision escalates, this call BLOCKS until a human resolves the gate
    via /approve or /deny (the dashboard button or a phone tap). That block is
    the point: the agent's payment genuinely waits on a human. FastAPI serves
    sync endpoints from a threadpool, so this block never stalls /state or the
    approval routes.
    """
    try:
        kind = EventKind(req.kind)
    except ValueError:
        return JSONResponse(
            {"error": f"unknown event kind {req.kind!r}", "valid_kinds": [k.value for k in EventKind]},
            status_code=422,
        )

    event = AgentEvent(
        kind=kind,
        amount=req.amount,
        currency=req.currency,
        vendor_id=req.vendor_id,
        vendor_known=req.vendor_known,
        vendor_history_count=req.vendor_history_count,
        invoice_amount=req.invoice_amount,
        detail_change_evidence=req.detail_change_evidence,
        ref=req.ref,
        message=req.message,
        category=req.category,
    )
    event_id = req.event_id or f"auth_{int(time.time() * 1000)}"
    beat = req.beat or f"agent authorize: {req.kind}"

    # Point the escalation handler at this event before deciding, exactly as the
    # demo runner does — so a parked card names the right request.
    state.escalation.current_id = event_id
    state.escalation.current_beat = beat
    # settle(), not decide(): the agent decides AND, on approve, executes on the
    # rail it alone holds. The caller gets the rail receipt, never a chance to
    # pay around the engine. A block/escalate returns executed=False, stripe_id
    # None — proof no money moved.
    result = state.agent.settle(event, event_id=event_id, demo_beat=beat)

    return JSONResponse(
        {
            "decision": result.decision.value,
            "reason": result.reason,
            "risk_score": round(result.risk_score, 2),
            "policy_refs": result.policy_refs,
            "decided_by": result.decided_by.value,
            "event_id": event_id,
            # The settlement truth: did money move, and the rail handle if so.
            "executed": result.executed,
            "stripe_id": result.stripe_id,
            "stripe_backend": result.stripe_backend,
        }
    )


# Serve the rest of the dashboard (dashboard.html, app.js, styles.css, *.json)
# as static files. Mounted last so the API routes above take precedence; the
# mount catches everything else, including the landing page at "/".
app.mount("/", StaticFiles(directory=str(DASHBOARD_DIR), html=True), name="dashboard")
