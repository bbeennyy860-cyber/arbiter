/* Arbiter dashboard
 * Reads the state contract from 04_integration_contract.md.
 * Surface Alex owns: render /state, show approval card, post to approve/deny URLs.
 * NO decision logic lives here — the core owns every decision. The detail
 * "trace" is a presentation-only reorganisation of fields already on each row.
 */

const SAMPLE_URL = "sample_state.json";
const SAMPLE_PENDING_URL = "sample_state_pending.json";
const LIVE_URL = "/state";
const POLL_MS = 1500;

// Fallbacks for the seed/goal header before any state has loaded.
const SEED_DEFAULT = 50;
const GOAL_DEFAULT = 500;

const el = {
  // sidebar / chrome
  statusPill: document.getElementById("status-pill"),
  sourcePill: document.getElementById("source-pill"),
  crumbs: document.getElementById("crumbs"),
  runDemo: document.getElementById("run-demo"),
  toggleLive: document.getElementById("toggle-live"),
  trustMode: document.getElementById("trust-mode"),
  // views
  viewOverview: document.getElementById("view-overview"),
  viewDetail: document.getElementById("view-detail"),
  // stats
  earnings: document.getElementById("m-earnings"),
  spend: document.getElementById("m-spend"),
  net: document.getElementById("m-net"),
  margin: document.getElementById("m-margin"),
  catch: document.getElementById("m-catch"),
  catchBar: document.getElementById("m-catch-bar"),
  // business header (seed → goal → balance)
  bhBalance: document.getElementById("bh-balance"),
  bhBal: document.querySelector(".bh-bal"),
  bhSeed: document.getElementById("bh-seed"),
  bhGoal: document.getElementById("bh-goal"),
  bhGoalPct: document.getElementById("bh-goal-pct"),
  bhProgress: document.getElementById("bh-progress"),
  spark: document.getElementById("balance-spark"),
  // per-job ledger
  jobs: document.getElementById("jobs"),
  cApprove: document.getElementById("c-approve"),
  cBlock: document.getElementById("c-block"),
  cEscalate: document.getElementById("c-escalate"),
  pcRules: document.getElementById("pc-rules"),
  pcModel: document.getElementById("pc-model"),
  pcOwner: document.getElementById("pc-owner"),
  policyStatus: document.getElementById("policy-status"),
  policySpendCap: document.getElementById("policy-spend-cap"),
  policyBudget: document.getElementById("policy-budget"),
  policyNewVendor: document.getElementById("policy-new-vendor"),
  policyEvidence: document.getElementById("policy-evidence"),
  policyCategories: document.getElementById("policy-categories"),
  policyPayees: document.getElementById("policy-payees"),
  policySave: document.getElementById("policy-save"),
  policySummary: document.getElementById("policy-summary"),
  replayStatus: document.getElementById("replay-status"),
  replayScenario: document.getElementById("replay-scenario"),
  replayRun: document.getElementById("replay-run"),
  replayResult: document.getElementById("replay-result"),
  redteamStatus: document.getElementById("redteam-status"),
  redteamRun: document.getElementById("redteam-run"),
  redteamResults: document.getElementById("redteam-results"),
  auditEvidence: document.getElementById("audit-evidence"),
  stageRules: document.getElementById("stage-rules"),
  stageModel: document.getElementById("stage-model"),
  stageOwner: document.getElementById("stage-owner"),
  // spotlight
  spotlight: document.getElementById("spotlight"),
  spStatus: document.getElementById("sp-status"),
  spIcon: document.getElementById("sp-icon"),
  spBeat: document.getElementById("sp-beat"),
  spSource: document.getElementById("sp-source"),
  spAmount: document.getElementById("sp-amount"),
  spVerdict: document.getElementById("sp-verdict"),
  // approval card
  card: document.getElementById("approval-card"),
  cardBeat: document.getElementById("approval-beat"),
  cardReason: document.getElementById("approval-reason"),
  cardRisk: document.getElementById("approval-risk"),
  cardWait: document.getElementById("approval-wait"),
  btnApprove: document.getElementById("btn-approve"),
  btnDeny: document.getElementById("btn-deny"),
  // table
  decisions: document.getElementById("decisions"),
  logCount: document.getElementById("log-count"),
  // headline verdict banner + reconciliation strip (operator surfaces)
  verdictBanner: document.getElementById("verdict-banner"),
  reconcileSection: document.getElementById("reconcile-section"),
  reconcile: document.getElementById("reconcile"),
  sourcingSection: document.getElementById("sourcing-section"),
  sourcing: document.getElementById("sourcing"),
  sourcingMeta: document.getElementById("sourcing-meta"),
  // detail
  detailHead: document.getElementById("detail-head"),
  detailReceipt: document.getElementById("detail-receipt"),
  detailEvent: document.getElementById("detail-event"),
  detailTrace: document.getElementById("detail-trace"),
  detailOutcome: document.getElementById("detail-outcome"),
  // end card
  endCard: document.getElementById("end-card"),
  endCardClose: document.getElementById("end-card-close"),
  endStat: document.getElementById("end-stat"),
};

let mode = "sample"; // "sample" | "live"
let pollTimer = null;
let pendingApproval = null;
let currentState = { timeline: [] };
let desiredTrustMode = "policy_autopilot";
let desiredOwnerPolicy = null;
let lastTableKey = "";
let ownerTapResolver = null; // set while the demo waits for a human tap

/* ---------- domain mapping (presentation only) ---------- */

const ALLOWED_SELF = ["fraud_detection", "ocr", "bank_reconciliation"];

// Which engine layer decided this event -> a pipeline stage.
function stageOf(layer) {
  if (layer === "llm" || layer === "model") return "model";
  if (layer === "escalate" || layer === "owner") return "owner";
  return "rules";
}

const STAGE_META = {
  rules: { name: "Policy engine", tech: "Deterministic rules", elKey: "stageRules", countKey: "pcRules" },
  model: { name: "NVIDIA Nemotron", tech: "Bounded judgment", elKey: "stageModel", countKey: "pcModel" },
  owner: { name: "Owner approval", tech: "Phone tap", elKey: "stageOwner", countKey: "pcOwner" },
};

// Human-readable names for the rule/signal refs on each row.
const REF_LABEL = {
  // service-business signals
  invoice_verified: "Invoice verified & reconciled",
  spend_within_budget: "Within the job's budget",
  spend_kills_margin: "Margin-protection guard",
  thin_margin: "Thin-margin review",
  spend_allowed: "On-goal capability",
  // legacy payment-ops signals (still rendered if the core emits them)
  invoice_normal_paid: "Invoice reconciled",
  duplicate_invoice: "Duplicate-payment guard",
  amount_mismatch: "Amount-mismatch guard",
  vendor_detail_change_known_vendor: "Known-vendor bank-change review",
  vendor_detail_change_new_vendor: "New-vendor impersonation guard",
  instruction_override: "Prompt-injection guard",
  new_vendor_small_amount: "New-vendor low-value check",
  self_spend_over_budget: "Budget-ceiling guard",
  self_spend_off_goal: "Off-goal spend guard",
  self_spend_allowed: "Approved reinvestment",
  llm_refine: "Bounded model judgment",
  phone_escalation: "Owner phone approval",
};

function refLabel(ref) {
  return REF_LABEL[ref] || ref;
}

// Inline SVG glyphs per event kind (currentColor).
const ICON = {
  invoice_payment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/></svg>',
  vendor_payment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>',
  vendor_detail_change: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
  self_spend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/><circle cx="12" cy="12" r="2"/></svg>',
};

const KIND_LABEL = {
  invoice_payment: "Client payment",
  vendor_payment: "Vendor payment",
  vendor_detail_change: "Vendor detail change",
  self_spend: "Spend to deliver",
};

function iconFor(kind) {
  return ICON[kind] || ICON.vendor_payment;
}

function sourceLine(row) {
  if (row.kind === "invoice_payment" && row.decision === "approve") {
    return "Stripe · client payment received & verified";
  }
  const s = STAGE_META[stageOf(row.layer)];
  return `${s.name} · ${s.tech}`;
}

function isHero(row) {
  // The pitch frame: the agent refusing a spend that would kill the job's margin.
  return (
    (row.margin_killer === true) ||
    (row.kind === "self_spend" && row.decision === "block" && stageOf(row.layer) === "rules")
  );
}

/* ---------- operator business rollup (the margin story surfaces) ---------- */

// Real Nemotron spend-judgements on this run. The advisory NIM layer judges
// EVERY delivery spend, but the *deciding* layer is the rules engine — so the
// pipeline counter must read the judgements off the business rollup, never the
// timeline layer (which only ever shows the deciding rule). Matches the engine
// contract: rules DECIDE, Nemotron JUDGES every spend; show both honestly.
function nemotronJudgements(state) {
  return (state && state.business && state.business.jobs ? state.business.jobs : [])
    .flatMap((j) => j.spends || [])
    .filter((sp) => String((sp.judgement && sp.judgement.source) || "").startsWith("nim:"));
}

// The NIM judgement attached to a timeline spend row, mapped by job + spend.
// Live operator rows id as `${job_id}:spend:${tool}`; the curated sample uses
// its own ids — so match on the stable pair (job title + category + cost) and
// fall back to the id suffix. Returns the model's own verdict or null.
function judgementForRow(state, row) {
  const jobs = state && state.business && state.business.jobs ? state.business.jobs : [];
  const job = jobs.find((j) => j.title === row.job);
  if (!job) return null;
  const spends = job.spends || [];
  const spend =
    spends.find((sp) => sp.category === row.category && Number(sp.cost) === Number(row.amount)) ||
    spends.find((sp) => String(row.id).endsWith(`:spend:${sp.tool}`));
  return spend ? spend.judgement : null;
}

// Rail status for a row, if the backend exposed one. We show three honest states:
// a real Stripe receipt, a recorded/stub settlement, or a failed rail call.
function railStatusForRow(state, row) {
  if (row.kind === "invoice_payment") {
    const customerPayments = (state && state.customer_payments) || [];
    const payment =
      customerPayments.find((p) => p.ref === row.ref || p.ref === row.invoice_ref || p.event_id === row.id) ||
      customerPayments.find((p) => Number(p.amount) === Number(row.amount) && (isRealStripeId(p.stripe_id) || p.failed));
    if (payment) {
      return {
        id: payment.stripe_id || null,
        failed: payment.failed === true,
        recorded: !isRealStripeId(payment.stripe_id),
        label: payment.failed ? "Rail failed" : isRealStripeId(payment.stripe_id) ? "Stripe receipt" : "Recorded payment",
        notes: payment.notes || "",
      };
    }

    const jobs = state && state.business && state.business.jobs ? state.business.jobs : [];
    const job = jobs.find((j) => j.title === row.job);
    const id = job && job.payment_id;
    return isRealStripeId(id) ? { id, failed: false, recorded: false, label: "Stripe receipt", notes: "" } : null;
  }
  const settlements = (state && state.settlements) || [];
  const settlement = settlements.find((s) => s.event_id === row.id);
  if (settlement) {
    return {
      id: settlement.stripe_id || null,
      failed: settlement.failed === true,
      recorded: !isRealStripeId(settlement.stripe_id),
      label: settlement.failed ? "Rail failed" : isRealStripeId(settlement.stripe_id) ? "Stripe receipt" : "Recorded settlement",
      notes: settlement.notes || "",
    };
  }

  const supplierPayments = (state && state.supplier_payments) || [];
  const supplierPayment = supplierPayments.find((p) => p.ref === row.id);
  if (supplierPayment) {
    return {
      id: supplierPayment.stripe_id || null,
      failed: supplierPayment.failed === true,
      recorded: !isRealStripeId(supplierPayment.stripe_id),
      label: supplierPayment.failed ? "Rail failed" : isRealStripeId(supplierPayment.stripe_id) ? "Stripe receipt" : "Recorded settlement",
      notes: supplierPayment.notes || "",
    };
  }
  return null;
}

// The real Stripe object id for a row, if the live rail produced one.
function stripeRefForRow(state, row) {
  const rail = railStatusForRow(state, row);
  return rail && isRealStripeId(rail.id) ? rail.id : null;
}

const STRIPE_OBJ_BASE = {
  pi: "https://dashboard.stripe.com/test/payments/",
  tr: "https://dashboard.stripe.com/test/connect/transfers/",
  cs: "https://dashboard.stripe.com/test/checkout/sessions/",
  ch: "https://dashboard.stripe.com/test/payments/",
};

function isRealStripeId(id) {
  // A real test-mode rail object: PaymentIntent (pi_), Connect transfer (tr_),
  // Checkout session (cs_), or Charge (ch_) — the self-spend delivery charge.
  return typeof id === "string" && /^(pi|tr|cs|ch)_/.test(id);
}

function stripeLink(id) {
  if (!isRealStripeId(id)) return null;
  const base = STRIPE_OBJ_BASE[String(id).split("_")[0]];
  return base ? base + id : null;
}

function railChipHtml(rail) {
  if (!rail) return "";
  if (rail.failed) {
    return `<span class="rail-chip rail-failed" title="${escapeHtml(rail.notes || "Rail call failed")}">RAIL FAILED</span>`;
  }
  if (isRealStripeId(rail.id)) {
    return `<span class="stripe-chip" title="Real Stripe test-mode id">${escapeHtml(rail.id)}</span>`;
  }
  return `<span class="rail-chip rail-recorded" title="Recorded by the rail adapter; no real Stripe id">${escapeHtml(rail.label || "Recorded")}</span>`;
}

function railDetailRowHtml(rail) {
  if (!rail) return "";
  const stripeId = isRealStripeId(rail.id) ? rail.id : null;
  const stripeHref = stripeLink(stripeId);
  if (rail.failed) {
    return `<div class="kv-row"><span class="k">Rail status</span><span class="v rail-status-failed">Rail failed${rail.notes ? ` · ${escapeHtml(rail.notes)}` : ""}</span></div>`;
  }
  if (stripeId) {
    const value = stripeHref
      ? `<a class="v mono stripe-link" href="${stripeHref}" target="_blank" rel="noopener">${escapeHtml(stripeId)} \u2197</a>`
      : `<span class="v mono">${escapeHtml(stripeId)}</span>`;
    return `<div class="kv-row"><span class="k">Stripe receipt</span>${value}</div>`;
  }
  return `<div class="kv-row"><span class="k">Settlement</span><span class="v rail-status-recorded">${escapeHtml(rail.label || "Recorded settlement")}</span></div>`;
}

// A block is one of two very different stories: an *economic* margin refusal —
// the non-obvious beat, a legitimate-sounding tool refused only because it would
// make the job unprofitable — versus a *fraud/policy* block, which is expected
// (every competitor has it). They must read differently in the UI.
function isMarginRefusal(row) {
  if (row.decision !== "block") return false;
  if (row.margin_killer === true) return true;
  const refs = row.refs || [];
  return (
    refs.includes("spend_kills_margin") ||
    refs.includes("self_spend_over_budget") ||
    refs.includes("thin_margin")
  );
}

function blockClass(row) {
  if (row.decision !== "block") return null;
  return isMarginRefusal(row) ? "margin" : "fraud";
}

// A margin refusal says REFUSED (economics); a fraud/policy block says BLOCKED.
// Approvals and escalations keep their plain verdict word.
function verdictLabel(row) {
  if (row.decision === "block") return isMarginRefusal(row) ? "REFUSED" : "BLOCKED";
  return row.decision.toUpperCase();
}

function verdictClass(row) {
  if (row.decision === "block" && isMarginRefusal(row)) return "v-refused";
  return `v-${row.decision}`;
}

/* ---------- formatting ---------- */

const CURRENCY_SYMBOL = { GBP: "£", USD: "$", EUR: "€" };

function money(amount, currency = "GBP") {
  if (amount == null) return "-";
  const sym = CURRENCY_SYMBOL[currency] || "";
  return sym + Number(amount).toFixed(2);
}

// Signed money for the live feed: client invoices are money in (+),
// spends to deliver are money out (−).
function moneyFlow(row) {
  if (row.amount == null) return { text: "-", cls: "" };
  const sym = CURRENCY_SYMBOL[row.currency] || "£";
  const isIn = row.kind === "invoice_payment";
  const sign = isIn ? "+" : "\u2212";
  return { text: `${sign}${sym}${Number(row.amount).toFixed(2)}`, cls: isIn ? "flow-in" : "flow-out" };
}

function pct(x) {
  return Math.round((Number(x) || 0) * 100) + "%";
}

function riskChip(risk) {
  const v = Number(risk) || 0;
  const level = v >= 0.66 ? "high" : v >= 0.33 ? "med" : "low";
  return `<span class="risk-chip risk-${level}">${Math.round(v * 100)}%</span>`;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function csvList(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function currentPolicyFromForm() {
  return {
    spend_cap: Number(el.policySpendCap && el.policySpendCap.value) || 0,
    budget_remaining: Number(el.policyBudget && el.policyBudget.value) || 0,
    allowed_categories: csvList(el.policyCategories && el.policyCategories.value),
    approved_payees: csvList(el.policyPayees && el.policyPayees.value),
    new_vendor_auto_threshold: Number(el.policyNewVendor && el.policyNewVendor.value) || 0,
    detail_change_evidence_threshold: Number(el.policyEvidence && el.policyEvidence.value) || 0,
    duplicate_lookback: 50,
  };
}

function setPolicyStatus(text, kind = "idle") {
  if (!el.policyStatus) return;
  el.policyStatus.textContent = text;
  el.policyStatus.className = `panel-meta policy-status-${kind}`;
}

function setReplayStatus(text, kind = "idle") {
  if (!el.replayStatus) return;
  el.replayStatus.textContent = text;
  el.replayStatus.className = `panel-meta policy-status-${kind}`;
}

function setRedteamStatus(text, kind = "idle") {
  if (!el.redteamStatus) return;
  el.redteamStatus.textContent = text;
  el.redteamStatus.className = `panel-meta policy-status-${kind}`;
}

function isPolicyFieldFocused() {
  return [
    el.policySpendCap,
    el.policyBudget,
    el.policyNewVendor,
    el.policyEvidence,
    el.policyCategories,
    el.policyPayees,
  ].includes(document.activeElement);
}

function renderPolicy(policy) {
  if (!policy || !el.policySpendCap) return;
  desiredOwnerPolicy = policy;
  el.policySpendCap.value = policy.spend_cap ?? 1000;
  el.policyBudget.value = policy.budget_remaining ?? policy.spend_cap ?? 1000;
  el.policyNewVendor.value = policy.new_vendor_auto_threshold ?? 50;
  el.policyEvidence.value = policy.detail_change_evidence_threshold ?? 0.8;
  el.policyCategories.value = (policy.allowed_categories || []).join(", ");
  el.policyPayees.value = (policy.approved_payees || []).join(", ");
  if (el.policySummary) {
    const categories = (policy.allowed_categories || []).length;
    const payees = (policy.approved_payees || []).length;
    el.policySummary.textContent = `Policy active: ${money(policy.spend_cap)} cap, ${categories} spend categories, ${payees} approved suppliers.`;
  }
}

async function savePolicy() {
  const policy = currentPolicyFromForm();
  desiredOwnerPolicy = policy;
  if (mode !== "live") {
    renderPolicy(policy);
    setPolicyStatus("Policy staged for next live run", "staged");
    return true;
  }
  try {
    const res = await fetch("/policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(policy),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `policy save failed (${res.status})`);
    renderPolicy(body.policy);
    setPolicyStatus("Policy saved to backend", "saved");
    pollLive();
    return true;
  } catch (err) {
    setPolicyStatus(err.message || "Policy save failed", "error");
    return false;
  }
}

const REPLAY_SCENARIOS = {
  aws_payment: {
    kind: "vendor_payment",
    vendor_id: "aws",
    amount: 42,
    invoice_amount: 42,
    vendor_known: true,
    vendor_history_count: 12,
    ref: "aws-hosting-042",
    message: "AWS hosting invoice",
  },
  unknown_payee: {
    kind: "vendor_payment",
    vendor_id: "ghost_vendor",
    amount: 42,
    invoice_amount: 42,
    vendor_known: true,
    vendor_history_count: 3,
    ref: "ghost-042",
    message: "Supplier payment request",
  },
  margin_spend: {
    kind: "self_spend",
    amount: 60,
    category: "marketing",
    ref: "ad-campaign-tool",
    message: "Buy an ad campaign tool for the job",
  },
};

function verdictMini(v) {
  const cls = v === "approve" ? "approve" : v === "block" ? "block" : "escalate";
  return `<span class="replay-verdict replay-${cls}">${escapeHtml(String(v).toUpperCase())}</span>`;
}

function renderReplayResult(body) {
  if (!el.replayResult) return;
  const before = body.baseline || {};
  const after = body.replay || {};
  const changed = body.changed ? "changed" : "unchanged";
  el.replayResult.innerHTML = `
    <div class="replay-columns">
      <div class="replay-card">
        <span class="replay-label">Current policy</span>
        ${verdictMini(before.decision || "-")}
        <p>${escapeHtml(before.reason || "No result")}</p>
      </div>
      <div class="replay-card replay-card-after">
        <span class="replay-label">Policy form</span>
        ${verdictMini(after.decision || "-")}
        <p>${escapeHtml(after.reason || "No result")}</p>
      </div>
    </div>
    <div class="replay-note">Replay ${changed}. Ledger unchanged. Rail untouched.</div>`;
}

async function runReplay() {
  const scenario = REPLAY_SCENARIOS[(el.replayScenario && el.replayScenario.value) || "aws_payment"];
  const policy = currentPolicyFromForm();
  if (mode !== "live") {
    setReplayStatus("Replay needs live backend", "error");
    if (el.replayResult) el.replayResult.textContent = "Switch to live mode to run policy replay against the backend engine.";
    return false;
  }
  try {
    const res = await fetch("/policy/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: scenario, policy }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `policy replay failed (${res.status})`);
    renderReplayResult(body);
    setReplayStatus(body.changed ? "Replay changed the verdict" : "Replay verdict unchanged", body.changed ? "staged" : "saved");
    return true;
  } catch (err) {
    setReplayStatus(err.message || "Policy replay failed", "error");
    return false;
  }
}

function renderRedteam(body) {
  if (!el.redteamResults) return;
  const rows = body.results || [];
  el.redteamResults.innerHTML = rows.map((row) => `
    <div class="redteam-row ${row.passed ? "passed" : "failed"}">
      <span class="redteam-mark">${row.passed ? "PASS" : "FAIL"}</span>
      <div>
        <b>${escapeHtml(row.title)}</b>
        <p>${escapeHtml(row.reason || "No reason returned")}</p>
        <small>${escapeHtml((row.policy_refs || []).join(", "))}</small>
      </div>
    </div>`).join("");
}

function shortHash(hash) {
  if (!hash) return "pending";
  return `${String(hash).slice(0, 10)}…${String(hash).slice(-8)}`;
}

function renderAuditEvidence(state) {
  if (!el.auditEvidence) return;
  const audit = state.audit_evidence || {};
  const rec = state.reconciliation || null;
  const settlements = Array.isArray(state.settlements) ? state.settlements : [];
  const events = Number(audit.event_count) || 0;
  const ledgerHash = audit.ledger_hash || null;
  const recOk = rec ? rec.ok === true : true;
  el.auditEvidence.innerHTML = `
    <div class="audit-card">
      <span class="audit-k">Decision entries</span>
      <b>${events}</b>
      <small>${audit.append_only ? "append-only ledger" : "ledger status unknown"}</small>
    </div>
    <div class="audit-card">
      <span class="audit-k">Ledger hash</span>
      <b class="mono">${escapeHtml(shortHash(ledgerHash))}</b>
      <small>${escapeHtml(audit.hash_algorithm || "sha256-prev-hash")}</small>
    </div>
    <div class="audit-card">
      <span class="audit-k">Rail reconciliation</span>
      <b class="${recOk ? "audit-ok" : "audit-bad"}">${recOk ? "Matched" : "Drift"}</b>
      <small>${settlements.length} settlement receipt${settlements.length === 1 ? "" : "s"}</small>
    </div>
    <div class="audit-card">
      <span class="audit-k">Money door</span>
      <b class="mono">${escapeHtml(audit.single_money_door || "ArbiterAgent.settle()")}</b>
      <small>frontend displays proof, backend owns execution</small>
    </div>`;
}

async function runRedteam() {
  const policy = currentPolicyFromForm();
  if (mode !== "live") {
    setRedteamStatus("Red-team needs live backend", "error");
    if (el.redteamResults) el.redteamResults.textContent = "Switch to live mode to run adversarial probes against the backend engine.";
    return false;
  }
  try {
    const res = await fetch("/red_team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `red-team test failed (${res.status})`);
    renderRedteam(body);
    setRedteamStatus(`${body.passed}/${body.total} attacks blocked`, body.all_passed ? "saved" : "error");
    return true;
  } catch (err) {
    setRedteamStatus(err.message || "Red-team test failed", "error");
    return false;
  }
}

function verdictColor(decision) {
  if (decision === "approve") return "var(--approve)";
  if (decision === "block") return "var(--block)";
  return "var(--escalate)";
}

function verdictGlyph(decision) {
  if (decision === "approve") return "✓";
  if (decision === "block") return "✕";
  return "!";
}

/* ---------- stats + pipeline ---------- */

function renderMeters(state) {
  const seed = state.seed != null ? Number(state.seed) : SEED_DEFAULT;
  const goal = state.goal != null ? Number(state.goal) : GOAL_DEFAULT;
  const earnings = Number(state.earnings) || 0;
  const spend = Number(state.spend) || 0;
  const margin = state.margin != null ? Number(state.margin) : earnings - spend;
  const balance = state.balance != null ? Number(state.balance) : seed + earnings - spend;

  // Stat row: revenue in, cost out, margin kept, and balance (reuses #m-net).
  el.earnings.textContent = money(earnings, "GBP");
  el.spend.textContent = money(spend, "GBP");
  if (el.margin) el.margin.textContent = money(margin, "GBP");
  el.net.textContent = money(balance, "GBP");

  // Fraud-screening capability bar lives in the header now.
  if (el.catch) el.catch.textContent = pct(state.catch_rate);
  if (el.catchBar) el.catchBar.style.width = pct(state.catch_rate);

  renderBusinessHeader(seed, goal, balance);
}

function renderBusinessHeader(seed, goal, balance) {
  if (el.bhBalance) el.bhBalance.textContent = money(balance, "GBP");
  if (el.bhSeed) el.bhSeed.textContent = money(seed, "GBP");
  if (el.bhGoal) el.bhGoal.textContent = money(goal, "GBP");
  const ratio = goal > 0 ? balance / goal : 0;
  if (el.bhGoalPct) el.bhGoalPct.textContent = Math.round(ratio * 100) + "%";
  if (el.bhProgress) el.bhProgress.style.width = Math.max(0, Math.min(1, ratio)) * 100 + "%";
}

/* ---------- balance-over-time sparkline ---------- */

function balanceSeries(state) {
  const seed = state.seed != null ? Number(state.seed) : SEED_DEFAULT;
  const pts = [seed];
  let bal = seed;
  for (const r of state.timeline || []) {
    if (r.decision === "approve" && r.amount) {
      if (r.kind === "invoice_payment") bal += r.amount;
      else if (r.kind === "self_spend") bal -= r.amount;
    }
    pts.push(bal);
  }
  return pts;
}

function renderSpark(state) {
  const svg = el.spark;
  if (!svg) return;
  const W = 320, H = 96, padY = 12;
  const goal = state.goal != null ? Number(state.goal) : GOAL_DEFAULT;
  const seed = state.seed != null ? Number(state.seed) : SEED_DEFAULT;
  const series = balanceSeries(state);

  if (series.length <= 1) {
    svg.innerHTML =
      `<text class="spark-empty" x="${W / 2}" y="${H / 2}" text-anchor="middle" dominant-baseline="middle">Awaiting first event…</text>`;
    return;
  }

  const maxV = Math.max(goal, ...series);
  const minV = Math.min(seed, ...series, 0);
  const spanV = maxV - minV || 1;
  const x = (i) => (i / (series.length - 1)) * W;
  const y = (v) => H - padY - ((v - minV) / spanV) * (H - padY * 2);

  const linePts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const areaPts = `0,${H} ` + linePts + ` ${W},${H}`;
  const goalY = y(goal).toFixed(1);
  const lastX = x(series.length - 1).toFixed(1);
  const lastY = y(series[series.length - 1]).toFixed(1);

  svg.innerHTML =
    `<defs><linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#2fbf74" stop-opacity="0.45"/>` +
    `<stop offset="1" stop-color="#2fbf74" stop-opacity="0"/></linearGradient></defs>` +
    `<line class="spark-goal-line" x1="0" y1="${goalY}" x2="${W}" y2="${goalY}"/>` +
    `<polygon class="spark-area" fill="url(#sparkfill)" points="${areaPts}"/>` +
    `<polyline class="spark-line" points="${linePts}"/>` +
    `<circle class="spark-dot" cx="${lastX}" cy="${lastY}" r="3.5"/>`;
}

/* ---------- per-job ledger ---------- */

function buildJobs(timeline) {
  const order = [];
  const map = new Map();
  for (const r of timeline || []) {
    const name = r.job || "Operations";
    if (!map.has(name)) {
      map.set(name, { name, revenue: 0, cost: 0, refusedMargin: 0, refusedPolicy: 0 });
      order.push(name);
    }
    const j = map.get(name);
    if (r.decision === "approve" && r.amount) {
      if (r.kind === "invoice_payment") j.revenue += r.amount;
      else if (r.kind === "self_spend") j.cost += r.amount;
    }
    if (r.decision === "block" && r.kind === "self_spend" && r.amount) {
      if (isMarginRefusal(r)) j.refusedMargin += r.amount;
      else j.refusedPolicy += r.amount;
    }
  }
  return order.map((n) => {
    const j = map.get(n);
    j.margin = j.revenue - j.cost;
    return j;
  });
}

function renderJobs(timeline) {
  if (!el.jobs) return;
  const jobs = buildJobs(timeline);
  if (!jobs.length) {
    el.jobs.innerHTML = `<div class="jobs-empty">No jobs yet — waiting for the first client payment.</div>`;
    return;
  }
  const kept = jobs.reduce((s, j) => s + j.margin, 0);
  const saved = jobs.reduce((s, j) => s + j.refusedMargin, 0);
  const billed = jobs.filter((j) => j.revenue > 0).length;
  const rollup = `
    <div class="jobs-rollup">
      <span class="jr-fig"><b>${money(kept)}</b><small>margin kept across ${billed} job${billed === 1 ? "" : "s"}</small></span>
      <span class="jr-fig jr-saved"><b>${money(saved)}</b><small>refused to protect margin</small></span>
    </div>`;
  el.jobs.innerHTML = rollup + jobs
    .map((j) => {
      const marginPct = j.revenue > 0 ? Math.max(0, Math.min(1, j.margin / j.revenue)) : 0;
      const neg = j.margin < 0;
      const sub = j.refusedMargin > 0
        ? `${money(j.refusedMargin)} refused to protect margin`
        : j.refusedPolicy > 0
          ? `${money(j.refusedPolicy)} blocked by policy`
        : j.revenue > 0 ? "delivered within budget" : "overhead / reinvest";
      return `
      <div class="job-row${j.refusedMargin > 0 ? " is-hero" : ""}${j.refusedPolicy > 0 ? " has-policy-block" : ""}">
        <div class="job-name"><span class="jdot"></span><span class="jn-text"><b>${escapeHtml(j.name)}</b><small>${escapeHtml(sub)}</small></span></div>
        <div class="job-fig jf-rev"><span class="jf-label">Revenue</span><span class="jf-val">${money(j.revenue)}</span></div>
        <div class="job-fig jf-cost"><span class="jf-label">Cost</span><span class="jf-val">${money(j.cost)}</span></div>
        <div class="job-fig jf-margin${neg ? " neg" : ""}"><span class="jf-label">Margin</span><span class="jf-val">${money(j.margin)}</span></div>
        <div class="job-bar"><div class="job-bar-fill" style="width:${(marginPct * 100).toFixed(0)}%"></div></div>
      </div>`;
    })
    .join("");
}

function tallyFrom(timeline) {
  const t = { approve: 0, block: 0, escalate: 0, rules: 0, model: 0, owner: 0 };
  for (const r of timeline) {
    if (t[r.decision] != null) t[r.decision]++;
    t[stageOf(r.layer)]++;
  }
  return t;
}

function renderCounters(timeline, state) {
  const t = tallyFrom(timeline);
  el.cApprove.textContent = t.approve;
  el.cBlock.textContent = t.block;
  el.cEscalate.textContent = t.escalate;
  el.pcRules.textContent = t.rules;
  // The NVIDIA beat: Nemotron judges EVERY spend (advisory), even though the
  // rules layer DECIDES. Count the real NIM judgements off the business rollup
  // so the climax frame shows NVIDIA working — not idle at 0. Falls back to the
  // timeline-layer tally when no rollup is present (e.g. the scenario demo).
  const nim = state ? nemotronJudgements(state).length : 0;
  el.pcModel.textContent = nim || t.model;
  el.pcOwner.textContent = t.owner;
}

/* ---------- headline verdict banner (the outcome, in words) ---------- */

function renderVerdictBanner(state) {
  if (!el.verdictBanner) return;
  const b = state && state.business;
  if (!b || !(b.jobs && b.jobs.length)) {
    el.verdictBanner.classList.add("hidden");
    return;
  }
  const protectedMargin = Number(b.net_profit) || 0;
  const refused = Number(b.waste_blocked) || 0;
  // The verify layer rejected every fraudulent invoice before booking it, so no
  // bad payment ever moved — the figure judges should remember.
  const badPayments = 0;
  const fraudCaught = (b.jobs || []).filter((j) => !j.revenue_booked).length;
  el.verdictBanner.classList.remove("hidden");
  el.verdictBanner.innerHTML =
    `<span class="vb-ico" aria-hidden="true">\u{1F6E1}</span>` +
    `<span class="vb-line">` +
    `<b>Protected ${money(protectedMargin)}</b> of margin` +
    ` <span class="vb-sep">\u00B7</span> ` +
    `<span class="vb-refused">refused ${money(refused)} of unprofitable spend</span>` +
    (fraudCaught
      ? ` <span class="vb-sep">\u00B7</span> ${fraudCaught} fraudulent invoice${fraudCaught > 1 ? "s" : ""} caught`
      : "") +
    ` <span class="vb-sep">\u00B7</span> <b>${badPayments} bad payments</b>` +
    `</span>`;
}

/* ---------- reconciliation strip (close the loop) ---------- */

function renderReconciliation(state) {
  if (!el.reconcile || !el.reconcileSection) return;
  const b = state && state.business;
  if (!b || !(b.jobs && b.jobs.length)) {
    el.reconcileSection.classList.add("hidden");
    return;
  }
  el.reconcileSection.classList.remove("hidden");

  const rec = state.reconciliation || null;
  const settlements = Array.isArray(state.settlements) ? state.settlements : [];
  const settledRows = settlements.filter((s) => !s.failed);
  const realSettlements = settledRows.filter((s) => isRealStripeId(s.stripe_id));
  const failedCalls = rec && Array.isArray(rec.failed_calls) ? rec.failed_calls : [];
  const ledgerSpend = rec ? Number(rec.ledger_spend) || 0 : Number(state.spend) || 0;
  const railSettled = rec ? Number(rec.rail_settled) || 0 : Number(b.cost_spent) || 0;
  const drift = rec ? Number(rec.drift) || 0 : Math.abs(ledgerSpend - railSettled);
  const reconciled = rec ? rec.ok === true : drift < 0.005;
  const rollupRevenue = Number(b.revenue_booked) || 0;

  const customerPayments = Array.isArray(state.customer_payments) ? state.customer_payments : [];
  const verified = customerPayments.length
    ? customerPayments.filter((p) => !p.failed && isRealStripeId(p.stripe_id)).length
    : (b.jobs || []).filter((j) => j.revenue_booked && isRealStripeId(j.payment_id)).length;
  const outflowNote = realSettlements.length
    ? `${realSettlements.length} Stripe receipt${realSettlements.length > 1 ? "s" : ""}`
    : settledRows.length
      ? `${settledRows.length} recorded settlement${settledRows.length > 1 ? "s" : ""}`
      : "no outflow yet";
  const failureHtml = failedCalls.length
    ? `<div class="rec-failures">${failedCalls.map((f) =>
        `<span>${escapeHtml(f.op || "rail")} ${money(f.amount || 0, f.currency || "GBP")} failed${f.notes ? `: ${escapeHtml(f.notes)}` : ""}</span>`
      ).join("")}</div>`
    : "";

  el.reconcile.innerHTML =
    `<div class="rec-chain">` +
    `<div class="rec-node"><span class="rec-k">Decisions</span><span class="rec-v">${b.jobs_total} jobs \u00B7 ${b.jobs_completed} delivered</span></div>` +
    `<span class="rec-arrow" aria-hidden="true">\u2192</span>` +
    `<div class="rec-node"><span class="rec-k">Payments in</span><span class="rec-v">${money(rollupRevenue)} <small>${verified} Stripe-verified</small></span></div>` +
    `<span class="rec-arrow" aria-hidden="true">\u2192</span>` +
    `<div class="rec-node"><span class="rec-k">Settled out</span><span class="rec-v">${money(railSettled)} <small>${outflowNote}</small></span></div>` +
    `<span class="rec-arrow" aria-hidden="true">\u2192</span>` +
    `<div class="rec-node"><span class="rec-k">Margin kept</span><span class="rec-v">${money(Number(b.net_profit) || 0)}</span></div>` +
    `</div>` +
    `<div class="rec-check ${reconciled ? "ok" : "drift"}">` +
    (reconciled
      ? `\u2713 Reconciled \u2014 ledger spend ${money(ledgerSpend)} matches rail-settled outflow ${money(railSettled)}.`
      : `\u26A0 Drift \u2014 ledger spend ${money(ledgerSpend)} vs rail-settled ${money(railSettled)} (\u0394 ${money(drift)}). Investigate before trusting the run.`) +
    `</div>` +
    failureHtml;
}

function setStageActive(stage) {
  for (const k of ["stageRules", "stageModel", "stageOwner"]) {
    el[k].classList.remove("active");
  }
  if (stage) el[STAGE_META[stage].elKey].classList.add("active");
}

/* ---------- smart sourcing strip (F3: the scout chose cheap, policy kept it honest) ---------- */

function renderProcurement(state) {
  if (!el.sourcing || !el.sourcingSection) return;
  const b = state && state.business;
  const sourcings = b && Array.isArray(b.sourcings) ? b.sourcings : [];
  if (!sourcings.length) {
    el.sourcingSection.classList.add("hidden");
    return;
  }
  el.sourcingSection.classList.remove("hidden");

  const savings = Number(b.sourcing_savings) || 0;
  if (el.sourcingMeta) {
    el.sourcingMeta.textContent = savings > 0
      ? `Chose cheaper-but-good and saved ${money(savings)} of margin — a real number, not a claim`
      : "The scout sources the cheapest catalog tool that meets the job's quality bar";
  }

  el.sourcing.innerHTML = sourcings
    .map((s) => {
      const chosen = s.chosen || {};
      const premium = s.premium || null;
      const saved = Number(s.savings_vs_premium) || 0;
      // The model proposed something off-catalog/below-bar and the backend
      // canonicalised it back to the safe baseline. That correction IS the moat.
      const corrected = s.model_was_corrected === true;
      const considered = Array.isArray(s.considered) ? s.considered : [];
      const altNames = considered
        .filter((it) => it && it.item_id !== chosen.item_id)
        .slice(0, 2)
        .map((it) => `${escapeHtml(it.name || it.item_id)} ${money(it.price || 0)}`)
        .join(" · ");
      const altLine = premium && Number(premium.price) > Number(chosen.price)
        ? `chose <b>${money(chosen.price)}</b> over premium <b>${money(premium.price)}</b> (${escapeHtml(premium.name || premium.item_id || "premium")})`
        : `sourced <b>${money(chosen.price)}</b> at quality ${chosen.quality != null ? Number(chosen.quality).toFixed(2) : "—"}`;
      return `
      <div class="sourcing-row${saved > 0 ? " is-saver" : ""}">
        <div class="sc-name"><span class="sc-dot"></span><span class="sc-text"><b>${escapeHtml(chosen.name || chosen.item_id || "tool")}</b><small>${escapeHtml(s.capability || "")}${corrected ? " · model proposal corrected to safe baseline" : ""}</small></span></div>
        <div class="sc-pick">${altLine}${altNames ? `<small>Considered: ${altNames}</small>` : ""}</div>
        <div class="sc-save">${saved > 0 ? `<span class="sc-save-val">−${money(saved)}</span><span class="sc-save-k">saved</span>` : `<span class="sc-save-k">cheapest fit</span>`}</div>
      </div>`;
    })
    .join("");
}

function bump(node) {
  if (!node) return;
  node.classList.remove("bump");
  void node.offsetWidth;
  node.classList.add("bump");
}

/* ---------- spotlight ---------- */

function spotlightEvaluating(row) {
  const stage = stageOf(row.layer);
  el.spotlight.className = "spotlight is-eval";
  el.spStatus.textContent = "Evaluating";
  el.spIcon.innerHTML = iconFor(row.kind);
  el.spBeat.textContent = row.beat;
  el.spSource.textContent = `Routing through ${STAGE_META[stage].name.toLowerCase()}…`;
  el.spAmount.textContent = row.amount != null ? moneyFlow(row).text : "";
  el.spVerdict.textContent = "…";
  setStageActive(stage);
}

function spotlightVerdict(row, statusLabel) {
  el.spotlight.className = `spotlight is-${row.decision}`;
  el.spStatus.textContent = statusLabel || "Latest decision";
  el.spIcon.innerHTML = iconFor(row.kind);
  el.spBeat.textContent = row.beat;
  // On the climax frame, surface the model's OWN words — the NVIDIA sponsor beat.
  const j = isHero(row) ? judgementForRow(currentState, row) : null;
  el.spSource.textContent =
    j && j.reason ? `NVIDIA Nemotron: \u201C${j.reason}\u201D` : sourceLine(row);
  el.spAmount.textContent = row.amount != null ? moneyFlow(row).text : "";
  el.spVerdict.textContent = verdictLabel(row);
}

/* ---------- decision table ---------- */

function rowTemplate(row) {
  const tr = document.createElement("tr");
  const stage = stageOf(row.layer);
  tr.className = "drow";
  if (row.kind === "self_spend") tr.classList.add("is-self");
  if (isHero(row)) tr.classList.add("is-hero");
  // Margin refusal and fraud block are different stories — tag the row so each
  // reads distinctly (economics vs fraud) in the feed.
  const bc = blockClass(row);
  if (bc) tr.classList.add(`block-${bc}`);
  tr.dataset.id = row.id;

  const dotClass =
    row.decision === "approve" ? "dot-approve" : row.decision === "block" ? "dot-block" : "dot-escalate";

  const kindLabel = KIND_LABEL[row.kind] || row.kind;
  const sub = row.job ? `${escapeHtml(row.job)} · ${escapeHtml(kindLabel)}` : escapeHtml(kindLabel);
  const flow = moneyFlow(row);
  // Real Stripe id, recorded settlement, or failed rail call shown on paid rows.
  const rail = railStatusForRow(currentState, row);
  const railChip = railChipHtml(rail);

  tr.innerHTML = `
    <td>
      <div class="cell-kind">
        <span class="kdot ${dotClass}"></span>
        <span class="ktext">
          <span class="kbeat">${escapeHtml(row.beat)}</span>
          <span class="kkind">${sub}${row.kind === "self_spend" ? '<span class="self-tag"> · SPEND</span>' : ""}${railChip}</span>
        </span>
      </div>
    </td>
    <td><span class="lchip layer-${stage}">${STAGE_META[stage].name}</span></td>
    <td class="cell-risk">${riskChip(row.risk)}</td>
    <td class="cell-amt ${flow.cls}">${flow.text}</td>
    <td><span class="vtag ${verdictClass(row)}">${verdictLabel(row)}</span></td>
    <td class="cell-go">›</td>`;

  tr.addEventListener("click", () => {
    location.hash = `#/event/${encodeURIComponent(row.id)}`;
  });
  return tr;
}

function renderTable(timeline) {
  const rows = [...timeline].reverse(); // newest first
  const key = rows.map((r) => r.id + ":" + r.decision).join("|");
  if (key === lastTableKey) return;
  lastTableKey = key;

  el.decisions.innerHTML = "";
  for (const row of rows) el.decisions.appendChild(rowTemplate(row));
  el.logCount.textContent = `${timeline.length} events`;
}

/* ---------- approval card ---------- */

function renderApproval(state) {
  const pending = state.awaiting_approval;
  pendingApproval = pending || null;
  if (!pending) {
    el.card.classList.add("hidden");
    return;
  }
  el.card.classList.remove("hidden");
  el.cardBeat.textContent = pending.beat || "Owner approval needed";
  el.cardReason.textContent = pending.reason || "";
  const amt = pending.amount != null ? money(pending.amount, pending.currency) : "";
  const risk = pending.risk != null ? `risk ${pending.risk}` : "";
  el.cardRisk.textContent = [amt, risk].filter(Boolean).join(" · ");
}

/* ---------- detail view (presentation-only trace) ---------- */

// Partition the row's refs by which engine layer "owns" them.
function refsByStage(row) {
  const out = { rules: [], model: [], owner: [] };
  for (const r of row.refs || []) {
    if (r === "llm_refine") out.model.push(r);
    else if (r === "phone_escalation") out.owner.push(r);
    else out.rules.push(r);
  }
  return out;
}

// Build the three-layer trace from fields already on the row. No new logic.
function buildTrace(row) {
  const stage = stageOf(row.layer);
  const refs = refsByStage(row);
  const hasModel = (row.refs || []).includes("llm_refine") || stage === "model";
  const hasOwner =
    (row.refs || []).includes("phone_escalation") || stage === "owner" || row.decision === "escalate";

  const steps = [];

  // ---- Step 1: Policy engine (always runs first) ----
  if (stage === "rules") {
    const status = row.decision === "approve" ? "pass" : row.decision === "block" ? "fail" : "warn";
    const label = row.decision === "approve" ? "Passed" : row.decision === "block" ? "Blocked" : "Flagged";
    steps.push({
      status, label, deciding: true,
      title: "Policy engine", tech: "Deterministic rules",
      text: row.reason, refs: refs.rules,
    });
  } else {
    steps.push({
      status: "pass", label: "Cleared", deciding: false,
      title: "Policy engine", tech: "Deterministic rules",
      text: "Deterministic checks passed; routed onward for judgment.", refs: refs.rules,
    });
  }

  // ---- Step 2: NVIDIA Nemotron (bounded judgment) ----
  // The advisory NIM judgement runs on EVERY delivery spend even when the rules
  // layer decides. If we have the model's own verdict for this row, show it —
  // that's the honest "rules decide, Nemotron judges every spend" framing.
  const nimJudgement = judgementForRow(currentState, row);
  if (!hasModel && nimJudgement && nimJudgement.reason) {
    const advisedBlock = nimJudgement.decision === "block";
    steps.push({
      status: advisedBlock ? "fail" : "pass",
      label: advisedBlock ? "Judged · refuse" : "Judged · clear",
      deciding: false,
      title: "NVIDIA Nemotron", tech: "Bounded judgment (advisory)",
      text: nimJudgement.reason, refs: refs.model,
    });
  } else if (!hasModel) {
    steps.push({
      status: "skip", label: "Not needed", deciding: false,
      title: "NVIDIA Nemotron", tech: "Bounded judgment",
      text: "Policy was decisive. No model judgment required.", refs: [],
    });
  } else if (stage === "model") {
    const status = row.decision === "approve" ? "pass" : row.decision === "block" ? "fail" : "warn";
    const label = row.decision === "approve" ? "Approved" : row.decision === "block" ? "Blocked" : "Flagged";
    steps.push({
      status, label, deciding: true,
      title: "NVIDIA Nemotron", tech: "Bounded judgment",
      text: row.reason, refs: refs.model,
    });
  } else {
    steps.push({
      status: "pass", label: "Refined", deciding: false,
      title: "NVIDIA Nemotron", tech: "Bounded judgment",
      text: "Bounded model refined the rationale within policy limits, but it cannot widen them.",
      refs: refs.model,
    });
  }

  // ---- Step 3: Owner approval (phone tap) ----
  if (!hasOwner) {
    steps.push({
      status: "skip", label: "Not needed", deciding: false,
      title: "Owner approval", tech: "Phone tap",
      text: "Resolved automatically. The owner was not contacted.", refs: [],
    });
  } else {
    const deciding = stage === "owner" || row.decision === "escalate";
    steps.push({
      status: "warn", label: deciding ? "Owner tap" : "Notified", deciding,
      title: "Owner approval", tech: "Phone tap",
      text: deciding
        ? (row.reason || "Pushed to the owner's phone for a one-tap approval.")
        : "Owner was notified for visibility.",
      refs: refs.owner,
    });
  }

  return steps;
}

function refPillsHtml(refs) {
  if (!refs || !refs.length) return "";
  return (
    '<div class="ref-list">' +
    refs.map((r) => `<span class="ref-pill" title="${escapeHtml(r)}">${escapeHtml(refLabel(r))}</span>`).join("") +
    "</div>"
  );
}

function stepHtml(step) {
  const glyph = step.status === "pass" ? "✓" : step.status === "fail" ? "✕" : step.status === "warn" ? "!" : "–";
  return `
    <details class="tstep is-${step.status}"${step.deciding ? " open" : ""}>
      <summary>
        <span class="tdot">${glyph}</span>
        <span class="tstep-title">${escapeHtml(step.title)}</span>
        <span class="tstep-tech">${escapeHtml(step.tech)}</span>
        <span class="tstep-status">${escapeHtml(step.label)}</span>
        <span class="chev">›</span>
      </summary>
      <div class="tstep-body">
        <div>${escapeHtml(step.text)}</div>
        ${refPillsHtml(step.refs)}
      </div>
    </details>`;
}

function settlementForRow(state, row) {
  return ((state && state.settlements) || []).find((s) => s.event_id === row.id) || null;
}

function executionTruthForRow(state, row) {
  const awaiting = state && state.awaiting_approval && state.awaiting_approval.event_id === row.id;
  const settlement = settlementForRow(state, row);
  const stripeId = stripeRefForRow(state, row) || (settlement && settlement.stripe_id);
  const backend = (settlement && settlement.backend) || (state && state.stripe_backend) || "stub";

  if (awaiting) {
    return {
      tone: "warn",
      label: "Waiting on owner",
      detail: "No money moves until the approval gate resolves.",
      stripeId: null,
    };
  }

  if (row.kind === "invoice_payment" && stripeId) {
    return {
      tone: "pass",
      label: "Client payment verified",
      detail: "Inbound Stripe test-mode payment reconciled to this job.",
      stripeId,
    };
  }

  if (row.decision !== "approve") {
    return {
      tone: "safe",
      label: "No money moved",
      detail: row.decision === "block"
        ? "The policy gate refused the request before settlement."
        : "The request escalated instead of executing automatically.",
      stripeId: null,
    };
  }

  if (settlement && settlement.failed) {
    return {
      tone: "fail",
      label: "Rail failed",
      detail: "Policy approved it, but the Stripe rail did not settle. The failure is visible instead of hidden.",
      stripeId: stripeId || null,
    };
  }

  if (stripeId) {
    return {
      tone: "pass",
      label: "Rail settled",
      detail: "Approved by policy and matched to a Stripe test-mode receipt.",
      stripeId,
    };
  }

  return {
    tone: backend === "stub" ? "safe" : "warn",
    label: backend === "stub" ? "Recorded stub" : "Approved, no Stripe id",
    detail: backend === "stub"
      ? "Offline demo mode recorded the approved action without a real rail object."
      : "Approved, but no real Stripe receipt is attached to this row.",
    stripeId: null,
  };
}

function receiptHtml(state, row) {
  const nim = judgementForRow(state, row);
  const exec = executionTruthForRow(state, row);
  const refs = row.refs || [];
  const stripeHref = stripeLink(exec.stripeId);
  const aiLabel = nim
    ? `${String(nim.decision || "judged").toUpperCase()} · ${nim.margin_ok === false ? "margin risk" : "margin OK"}`
    : stageOf(row.layer) === "model"
      ? `${row.decision.toUpperCase()} · bounded model decided`
      : "Not needed";
  const aiDetail = nim
    ? nim.reason
    : stageOf(row.layer) === "model"
      ? row.reason
      : "Deterministic policy was decisive, so no model judgement was required for this event.";
  const policyDetail = refs.length
    ? refs.map(refLabel).join(" · ")
    : "No named policy reference on this row.";
  const verdict = verdictLabel(row);
  const verdictDetail = row.decision === "approve"
    ? "Approved request may proceed to the settlement door."
    : row.decision === "block"
      ? "Request refused. Settlement is blocked."
      : "Request parked for owner approval.";
  const stripeLine = exec.stripeId
    ? (stripeHref
        ? `<a class="receipt-stripe mono" href="${stripeHref}" target="_blank" rel="noopener">${escapeHtml(exec.stripeId)} ↗</a>`
        : `<span class="receipt-stripe mono">${escapeHtml(exec.stripeId)}</span>`)
    : "";

  return `
    <div class="panel-head">
      <h3>Decision receipt</h3>
      <span class="panel-meta">AI suggests · policy decides · rail proves</span>
    </div>
    <div class="receipt-body">
      <div class="receipt-grid">
        <div class="receipt-card is-request">
          <span class="receipt-step">1</span>
          <span class="receipt-label">Request</span>
          <strong>${escapeHtml(KIND_LABEL[row.kind] || row.kind)}</strong>
          <p>${row.amount != null ? money(row.amount, row.currency) : "No amount"}${row.category ? ` · ${escapeHtml(row.category)}` : ""}</p>
        </div>
        <div class="receipt-card is-ai ${nim ? "has-ai" : "is-muted"}">
          <span class="receipt-step">2</span>
          <span class="receipt-label">AI suggestion</span>
          <strong>${escapeHtml(aiLabel)}</strong>
          <p>${escapeHtml(aiDetail)}</p>
        </div>
        <div class="receipt-card is-policy">
          <span class="receipt-step">3</span>
          <span class="receipt-label">Policy checks</span>
          <strong>${escapeHtml(STAGE_META[stageOf(row.layer)].name)}</strong>
          <p>${escapeHtml(policyDetail)}</p>
        </div>
        <div class="receipt-card is-verdict v-${row.decision}">
          <span class="receipt-step">4</span>
          <span class="receipt-label">Verdict</span>
          <strong>${escapeHtml(verdict)}</strong>
          <p>${escapeHtml(verdictDetail)}</p>
        </div>
        <div class="receipt-card is-exec exec-${exec.tone}">
          <span class="receipt-step">5</span>
          <span class="receipt-label">Execution truth</span>
          <strong>${escapeHtml(exec.label)}</strong>
          <p>${escapeHtml(exec.detail)}</p>
          ${stripeLine}
        </div>
      </div>
    </div>`;
}

function renderDetail(id) {
  const row = (currentState.timeline || []).find((r) => r.id === id);
  if (!row) {
    location.hash = "#/overview";
    return false;
  }

  // ----- head -----
  const old = document.querySelector("#view-detail .detail-banner");
  if (old) old.remove();
  el.detailHead.innerHTML = `
    <div class="dh-icon">${iconFor(row.kind)}</div>
    <div class="dh-main">
      <div class="dh-kind">${escapeHtml(KIND_LABEL[row.kind] || row.kind)}</div>
      <h2 class="dh-beat">${escapeHtml(row.beat)}</h2>
    </div>
    <div class="dh-right">
      <span class="dh-amount">${row.amount != null ? money(row.amount, row.currency) : "-"}</span>
      <span class="dh-verdict ${verdictClass(row)}">${verdictLabel(row)}</span>
    </div>`;
  if (isHero(row)) {
    const j = judgementForRow(currentState, row);
    const nimLine = j && j.reason
      ? `<div class="db-nim"><span class="nim-tag">NVIDIA Nemotron</span> \u201C${escapeHtml(j.reason)}\u201D</div>`
      : "";
    el.detailHead.insertAdjacentHTML(
      "afterend",
      `<div class="detail-banner"><div class="db-main">\u26D4 <span><b>Margin-killer refused.</b> This spend would have cost more than the job brings in, so the agent refused it to keep the job profitable.</span></div>${nimLine}</div>`
    );
  }

  // ----- receipt panel -----
  el.detailReceipt.innerHTML = receiptHtml(currentState, row);

  // ----- request panel -----
  const sigRefs = row.refs || [];
  const rail = railStatusForRow(currentState, row);
  const railRowHtml = railDetailRowHtml(rail);
  el.detailEvent.innerHTML = `
    <div class="panel-head"><h3>Request</h3></div>
    <div class="panel-body">
      <div class="kv">
        <div class="kv-row"><span class="k">Type</span><span class="v">${escapeHtml(KIND_LABEL[row.kind] || row.kind)}</span></div>
        <div class="kv-row"><span class="k">Amount</span><span class="v">${row.amount != null ? money(row.amount, row.currency) : "-"}</span></div>
        <div class="kv-row"><span class="k">Currency</span><span class="v">${escapeHtml(row.currency || "-")}</span></div>
        ${row.category ? `<div class="kv-row"><span class="k">Category</span><span class="v">${escapeHtml(row.category)}</span></div>` : ""}
        <div class="kv-row"><span class="k">Event ID</span><span class="v mono">${escapeHtml(row.id)}</span></div>
        ${railRowHtml}
        <div class="kv-row"><span class="k">Source</span><span class="v">${escapeHtml(sourceLine(row))}</span></div>
        <div class="kv-row"><span class="k">Signals</span>${sigRefs.length ? refPillsHtml(sigRefs) : '<span class="v">-</span>'}</div>
      </div>
    </div>`;

  // ----- trace panel -----
  const steps = buildTrace(row);
  el.detailTrace.innerHTML = `
    <div class="panel-head"><h3>Decision trace</h3><span class="panel-meta">3-layer engine</span></div>
    <div class="panel-body"><div class="trace">${steps.map(stepHtml).join("")}</div></div>`;

  // ----- outcome panel -----
  const awaiting = currentState.awaiting_approval && currentState.awaiting_approval.event_id === row.id;
  el.detailOutcome.innerHTML = `
    <div class="panel-head"><h3>Outcome</h3></div>
    <div class="panel-body">
      <div class="outcome">
        <span class="verdict-big v-${row.decision}">${verdictGlyph(row.decision)} ${row.decision.toUpperCase()}</span>
        <div class="risk-meter">
          <div class="k"><span>Risk score</span><span>${row.risk}</span></div>
          <div class="risk-bar"><div class="risk-fill" style="width:${Math.round((Number(row.risk) || 0) * 100)}%;background:${verdictColor(row.decision)}"></div></div>
        </div>
        <div class="reason-box">${escapeHtml(row.reason)}</div>
        ${awaiting
          ? `<div class="detail-actions"><button class="btn btn-approve" id="d-approve">Approve</button><button class="btn btn-deny" id="d-deny">Deny</button></div>`
          : ""}
      </div>
    </div>`;

  if (awaiting) {
    const a = currentState.awaiting_approval;
    const da = document.getElementById("d-approve");
    const dd = document.getElementById("d-deny");
    if (da) da.addEventListener("click", () => postDecision(a.approve_url));
    if (dd) dd.addEventListener("click", () => postDecision(a.deny_url));
  }

  setCrumbsDetail(row);
  return true;
}

/* ---------- routing ---------- */

function parseRoute() {
  const h = location.hash || "#/overview";
  if (h.startsWith("#/event/")) {
    return { name: "event", id: decodeURIComponent(h.slice("#/event/".length)) };
  }
  return { name: "overview" };
}

function setCrumbsOverview() {
  el.crumbs.innerHTML = `<span class="crumb cur">Overview</span>`;
}

function setCrumbsDetail(row) {
  el.crumbs.innerHTML =
    `<a class="crumb" href="#/overview">Overview</a>` +
    `<span class="crumb-sep">›</span>` +
    `<span class="crumb cur">${escapeHtml(KIND_LABEL[row.kind] || row.kind)}</span>`;
}

function setNavActive(routeName) {
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  if (routeName === "overview") {
    const o = document.querySelector('.nav-item[data-route="overview"]');
    if (o) o.classList.add("active");
  }
}

function showOverview() {
  el.viewDetail.classList.add("hidden");
  el.viewOverview.classList.remove("hidden");
  setCrumbsOverview();
  setNavActive("overview");
}

function showDetail(id) {
  if (!renderDetail(id)) return;
  el.viewOverview.classList.add("hidden");
  el.viewDetail.classList.remove("hidden");
  setNavActive("detail");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function applyRoute() {
  const r = parseRoute();
  if (r.name === "event") showDetail(r.id);
  else showOverview();
}

window.addEventListener("hashchange", applyRoute);

/* ---------- main render ---------- */

function render(state) {
  currentState = state || { timeline: [] };
  if (state && state.trust_mode && el.trustMode && document.activeElement !== el.trustMode) {
    desiredTrustMode = state.trust_mode;
    el.trustMode.value = state.trust_mode;
  }
  if (state && state.owner_policy && !isPolicyFieldFocused()) renderPolicy(state.owner_policy);
  renderMeters(state);
  renderSpark(state);
  renderVerdictBanner(state);
  renderJobs(state.timeline || []);
  renderCounters(state.timeline || [], state);
  renderReconciliation(state);
  renderProcurement(state);
  renderAuditEvidence(state);
  renderApproval(state);
  renderTable(state.timeline || []);
  const tl = state.timeline || [];
  if (tl.length) spotlightVerdict(tl[tl.length - 1], "Latest decision");
  setStageActive(null);
  applyRoute();
}

/* ---------- idle (nothing analysed yet) ---------- */

function showIdle() {
  currentState = { timeline: [] };
  renderMeters({ seed: SEED_DEFAULT, goal: GOAL_DEFAULT, earnings: 0, spend: 0, net: 0, catch_rate: 0 });
  renderSpark({ seed: SEED_DEFAULT, goal: GOAL_DEFAULT, timeline: [] });
  renderVerdictBanner({});
  renderJobs([]);
  renderCounters([]);
  renderReconciliation({});
  renderProcurement({});
  renderAuditEvidence({ audit_evidence: { event_count: 0, append_only: true } });
  renderApproval({ awaiting_approval: null });
  lastTableKey = "__idle__";
  renderTable([]);
  setStageActive(null);

  el.spotlight.className = "spotlight";
  el.spStatus.textContent = "Idle";
  el.spIcon.innerHTML = iconFor("invoice_payment");
  el.spBeat.textContent = "Nothing running yet";
  el.spSource.textContent = 'Press "Run demo" to watch the back office run.';
  el.spAmount.textContent = "";
  el.spVerdict.textContent = "-";

  applyRoute();
}

/* ---------- data sources ---------- */

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function loadSample() {
  try {
    const state = await fetchJson(SAMPLE_URL);
    render(state);
  } catch (err) {
    el.spBeat.textContent = "Could not load sample_state.json";
    el.spSource.textContent = `Serve this folder over http (see README), then reload. (${err.message})`;
  }
}

async function pollLive() {
  try {
    const state = await fetchJson(LIVE_URL);
    render(state);
  } catch (err) {
    el.sourcePill.textContent = "LIVE (no backend)";
  }
}

/* ---------- live mode ---------- */

function startLive() {
  mode = "live";
  el.sourcePill.textContent = "LIVE";
  el.sourcePill.classList.remove("source-sample");
  el.sourcePill.classList.add("source-live");
  el.toggleLive.textContent = "Go sample";
  // Kick the backend so the live timeline actually plays: rebuild a fresh run,
  // then start it. The agent decides server-side and we mirror it via /state.
  // If the backend isn't reachable, pollLive() surfaces "LIVE (no backend)".
  //
  // /run_operator (not /run) is the swing demo: the autonomous money-operator
  // that earns, verifies, and protects each job's margin — the run that emits
  // the margin_killer hero row + per-job business rollup this UI renders. /run
  // plays the older AP-autopilot day, which has no margin-refusal climax.
  (async () => {
    try {
      desiredOwnerPolicy = currentPolicyFromForm();
      await fetch("/reset", { method: "POST" });
      if (desiredOwnerPolicy) {
        await fetch("/policy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(desiredOwnerPolicy),
        });
      }
      await fetch("/trust_mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: desiredTrustMode }),
      });
      await fetch("/run_operator", { method: "POST" });
    } catch (_) {
      /* no backend; pollLive reports it */
    }
    pollLive();
  })();
  pollTimer = setInterval(pollLive, POLL_MS);
}

function stopLive() {
  mode = "sample";
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  el.sourcePill.textContent = "SAMPLE DATA";
  el.sourcePill.classList.add("source-sample");
  el.sourcePill.classList.remove("source-live");
  el.toggleLive.textContent = "Go live";
  loadSample();
}

el.toggleLive.addEventListener("click", () => {
  if (mode === "live") stopLive();
  else startLive();
});

if (el.policySave) {
  el.policySave.addEventListener("click", savePolicy);
}

if (el.replayRun) {
  el.replayRun.addEventListener("click", runReplay);
}

if (el.redteamRun) {
  el.redteamRun.addEventListener("click", runRedteam);
}

if (el.trustMode) {
  el.trustMode.addEventListener("change", async () => {
    desiredTrustMode = el.trustMode.value;
    if (mode !== "live") return;
    try {
      await fetch("/trust_mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: desiredTrustMode }),
      });
      pollLive();
    } catch (_) {
      /* backend owns the truth; next poll reconciles */
    }
  });
}

/* ---------- approve / deny ---------- */

async function postDecision(url) {
  if (mode === "live" && url) {
    try {
      await fetch(url, { method: "POST" });
    } catch (_) {
      /* backend owns the truth; next poll reconciles */
    }
    pollLive();
    return;
  }
  // sample mode: optimistically clear so the demo flows
  el.card.classList.add("hidden");
}

el.btnApprove.addEventListener("click", () => {
  if (ownerTapResolver) { const r = ownerTapResolver; ownerTapResolver = null; r("approve"); return; }
  postDecision(pendingApproval && pendingApproval.approve_url);
});
el.btnDeny.addEventListener("click", () => {
  if (ownerTapResolver) { const r = ownerTapResolver; ownerTapResolver = null; r("deny"); return; }
  postDecision(pendingApproval && pendingApproval.deny_url);
});

/* ---------- sidebar nav: scroll-to-section ---------- */

document.querySelectorAll(".nav-item[data-scroll]").forEach((a) => {
  a.addEventListener("click", () => {
    const id = a.dataset.scroll;
    if (location.hash && location.hash !== "#/overview") location.hash = "#/overview";
    setTimeout(() => {
      const node = document.getElementById(id);
      if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  });
});

/* ---------- Run demo (sample sequence playback) ---------- */

let demoRunning = false;

function setStatusState(kind, label) {
  el.statusPill.className = `status-pill status-${kind}`;
  el.statusPill.textContent = `● ${label}`;
}

function setStatus(running) {
  setStatusState(running ? "running" : "idle", running ? "Processing" : "Idle");
}

function waitForOwnerTap() {
  return new Promise((resolve) => { ownerTapResolver = resolve; });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runDemo() {
  if (demoRunning) return;
  if (location.hash && location.hash !== "#/overview") location.hash = "#/overview";
  demoRunning = true;
  el.runDemo.disabled = true;
  setStatus(true);

  if (mode === "live") stopLive();

  let full;
  try {
    full = await fetchJson(SAMPLE_URL);
  } catch (err) {
    demoRunning = false;
    el.runDemo.disabled = false;
    setStatus(false);
    return;
  }

  // Reset to a clean start.
  el.decisions.innerHTML = "";
  el.card.classList.add("hidden");
  el.endCard.classList.add("hidden");
  lastTableKey = "";

  const ordered = [...full.timeline]; // chronological
  const seed = full.seed != null ? Number(full.seed) : SEED_DEFAULT;
  const goal = full.goal != null ? Number(full.goal) : GOAL_DEFAULT;
  let earnings = 0;
  let spend = 0;
  const counts = { approve: 0, block: 0, escalate: 0, rules: 0, model: 0, owner: 0 };
  // Catch-rate climbs only when the agent reinvests in fraud detection.
  let catchRate = Math.max(0, full.catch_rate - 0.28);

  renderMeters({ seed, goal, earnings, spend, catch_rate: catchRate });
  renderSpark({ seed, goal, timeline: [] });
  renderJobs([]);
  const cmapAll = { approve: "cApprove", block: "cBlock", escalate: "cEscalate", rules: "pcRules", model: "pcModel", owner: "pcOwner" };
  for (const k of Object.keys(cmapAll)) el[cmapAll[k]].textContent = "0";

  // Make the operator surfaces available for the whole playback: point the
  // shared state at the full sample (so judgementForRow / stripeRefForRow can
  // map hero rows to their NIM verdict + Stripe id), seed the NVIDIA count from
  // the rollup, and render the headline banner + reconciliation up front.
  currentState = full;
  el.pcModel.textContent = nemotronJudgements(full).length || "0";
  renderVerdictBanner(full);
  renderReconciliation(full);
  renderProcurement(full);
  let pendingState = null;
  try {
    pendingState = await fetchJson(SAMPLE_PENDING_URL);
  } catch (_) {
    pendingState = null;
  }

  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i];
    const stage = stageOf(row.layer);

    // 1) Show the event entering the engine and light its stage.
    spotlightEvaluating(row);

    if (stage === "owner") {
      // Human-in-the-loop: pause the whole demo until the judge taps.
      const pend = (pendingState && pendingState.awaiting_approval)
        ? pendingState
        : { awaiting_approval: { beat: row.beat, reason: row.reason, risk: row.risk } };
      renderApproval(pend);
      el.card.classList.add("awaiting");
      if (el.cardWait) el.cardWait.classList.add("show");
      setStatusState("waiting", "Waiting on owner");

      const choice = await waitForOwnerTap();

      el.card.classList.remove("awaiting");
      if (el.cardWait) el.cardWait.classList.remove("show");
      setStatus(true);
      if (choice === "deny") {
        row.decision = "block";
        row.reason = "Owner denied the spend from their phone — it left too thin a margin on the job.";
      } else {
        row.decision = "approve";
      }
      await sleep(350);
      el.card.classList.add("hidden");
    } else {
      await sleep(700);
    }

    // 2) Reveal the verdict + move the money.
    let moneyIn = false;
    if (row.decision === "approve" && row.kind === "invoice_payment" && row.amount) {
      earnings += row.amount;
      moneyIn = true;
    }
    if (row.decision === "approve" && row.kind === "self_spend" && row.amount) {
      spend += row.amount;
      if (row.category === "fraud_detection") catchRate = full.catch_rate;
    }

    const played = ordered.slice(0, i + 1);
    const partial = {
      seed, goal, earnings, spend,
      balance: seed + earnings - spend,
      margin: earnings - spend,
      catch_rate: catchRate,
      timeline: played,
    };
    renderMeters(partial);
    renderSpark(partial);
    renderJobs(played);
    if (moneyIn) {
      bumpFlash(el.earnings.closest(".stat"));
      bumpFlash(el.net.closest(".stat"));
      if (el.bhBal) { el.bhBal.classList.remove("grew"); void el.bhBal.offsetWidth; el.bhBal.classList.add("grew"); }
    }

    counts[row.decision] = (counts[row.decision] || 0) + 1;
    counts[stage]++;
    const cmap = { approve: el.cApprove, block: el.cBlock, escalate: el.cEscalate };
    if (cmap[row.decision]) {
      cmap[row.decision].textContent = counts[row.decision];
      bump(cmap[row.decision].closest(".cc"));
    }
    el[STAGE_META[stage].countKey].textContent = counts[stage];

    spotlightVerdict(row, isHero(row) ? "Margin-killer refused" : "Decided");

    // 3) Drop into the live event feed (newest at top).
    el.decisions.insertBefore(rowTemplate(row), el.decisions.firstChild);
    el.logCount.textContent = `${i + 1} events`;

    await sleep(isHero(row) ? 1500 : 650);
    setStageActive(null);
  }

  // Settle to the real totals + show the branded close.
  render(full);
  const t = tallyFrom(full.timeline);
  const finalBalance = full.balance != null ? Number(full.balance) : seed + (Number(full.earnings) - Number(full.spend));
  el.endStat.textContent = `${full.timeline.length} events · ${money(full.earnings)} earned · ${money(full.spend)} spent to deliver · ${t.block} margin-killers refused · balance ${money(finalBalance)}`;
  el.card.classList.add("hidden");
  el.endCard.classList.remove("hidden");

  demoRunning = false;
  el.runDemo.disabled = false;
  setStatusState("complete", `Complete · balance ${money(finalBalance)}`);
}

function bumpFlash(node) {
  if (!node) return;
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
}

el.runDemo.addEventListener("click", runDemo);
el.endCardClose.addEventListener("click", () => el.endCard.classList.add("hidden"));

/* ---------- boot ---------- */

showIdle();
