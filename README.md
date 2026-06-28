# Arbiter

**An AI bookkeeper that pays your suppliers while you sleep — and can only ever pay the ones you approved, the amount they're actually owed.**

Arbiter connects to your Stripe, reconciles the money coming in against the suppliers you owe, and pays the open invoices for you. The catch that makes it safe to leave running: it can only pay a supplier on your approved list, it blocks an invoice for the wrong amount, it refuses a duplicate, and when something looks off — a new bank account, an unfamiliar payee — it stops and asks you. Every decision is logged.

Built by **Ben Anokye-Davies** and **Alex Kurkar** for the Nous Research × NVIDIA × Stripe agent hackathon.

## Why this exists

Every small business pays someone to do accounts payable: match the incoming money to the outgoing invoices, pay the suppliers, and not get robbed doing it. It's repetitive, it's monthly, and it's exactly the kind of job you'd hand to software — except you can't, because software that can move money can move it *anywhere*, and one bad instruction or spoofed invoice empties the account.

So the job stays manual. The owner's real objection to automating it is not "can a model read an invoice" — it's "if it can pay anyone, that's terrifying." Arbiter is built around removing that fear: the agent that holds the Stripe key is structurally incapable of paying a supplier you didn't approve. Autonomy becomes safe to grant because the dangerous actions are blocked in code, before any money moves — not promised in a prompt.

## What it does — one business day

Press "Go live" and Arbiter runs a real day's accounts payable, end to end. These are the actual seven beats it plays, straight from `business_day_events()`:

```
[1] Revenue in     Brightwave pays their £480 invoice. Reconciled, no red flags.   -> APPROVE
[2] Pay AWS        £220, approved supplier, monthly cloud bill, amount matches.     -> APPROVE  (pays)
[3] Pay Acme Print £140, approved supplier, this month's print run, matches.        -> APPROVE  (pays)
[4] AWS duplicate  A second identical £220 AWS charge, same ref. Already paid.       -> BLOCK    (duplicate)
[5] Northstar £840 Invoice claims £840 but the invoice on file is £480.              -> BLOCK    (overpay)
[6] Meta Ads £300  A payee the owner never approved sends an invoice.                -> BLOCK    (not on allowlist)
[7] Northstar bank Email: "new bank details, please update." Evidence is weak.       -> ASK YOU  (phone tap)
```

It pays the two approved suppliers for real (test-mode Stripe). It blocks the double-payment, the overpayment, and the stranger. And on the one genuinely ambiguous beat — a bank-detail change with weak evidence — it doesn't guess, it buzzes the owner for a yes/no.

That is the whole pitch in one run: **it does the job, and it can't be talked into the dangerous version of the job.**

## How it's built — money is never decided by a raw LLM

Three layers, checked in order. The first hard verdict wins, and the payee allowlist is the highest-priority rule of all — nothing reaches an approve path without clearing it.

1. **Deterministic rules** (`arbiter/policy/rules.py`) — first-match-wins rules with no model in the loop: payee-not-approved, duplicate invoice, amount mismatch, vendor-detail change, instruction-override (hard block). This is the moat. A prompt-injection string can't argue with an `if` statement.
2. **Bounded Nemotron reasoning** (`arbiter/agent/nim_nemotron.py`) — real NVIDIA NIM calls, strict-JSON only, used *only* to refine the ambiguous cases the rules can't express. If the model is unreachable or returns malformed output, the decision escalates to a human rather than guessing. It never holds a Stripe tool.
3. **Phone escalation** (`arbiter/agent/escalation.py`) — anything still ambiguous goes to the owner for a one-tap yes/no. The human is the final layer, by design.

**The single money door.** The agent core holds no Stripe key. `ArbiterAgent.settle()` is the only call in the system that can move money, and it runs the full pipeline above before it does. Audit one function, audit every payment.

## It generalizes — the same engine runs an autonomous business

The governance engine isn't AP-specific. Point it at a different job and it still refuses the spend that breaks the rules. The `--operator` demo runs a small service business autonomously: it takes paid jobs, buys what each job needs to deliver, and refuses any purchase that would blow the job's margin — booking the protected margin to a ledger.

```
$ python -m arbiter.cli --operator
[JOB job_02] 50 product banners for a store
   EARN  -> OK    £90 booked (margin floor £40)
   SPEND -> OK    paid  image_gen_compute (£35)
   SPEND -> STOP  REFUSED premium_stock_library (£45) — would breach the £40 margin floor
   LEDGER: cost £35 | waste blocked £45 | margin kept £55 | protected=True
```

Same three layers, same single money door, a different job. AP autopilot is the product; this is the proof the engine is a reusable asset.

## Real sponsor rails

| Sponsor | How it's used | State |
|---|---|---|
| **Stripe** | `LiveStripeGlue` moves real test-mode money via Connect Transfers (`tr_...`) and confirmed PaymentIntents (`pi_...`); activates on `STRIPE_SECRET_KEY` | Real (test mode) |
| **NVIDIA Nemotron** | Bounded spend/decision judgement via NIM, OpenRouter fallback; activates on `NVIDIA_API_KEY` | Real |
| **Nous / Hermes** | MCP server (`arbiter/mcp_server.py`) exposes the governed `settle()` door so a Hermes agent's payments hit the same allowlist | Real |

With no keys present, every rail falls back to a faithful mock so the suite and the demo run offline. Boot banners print which mode is live (`[arbiter] Stripe layer: REAL test-mode` vs `... stub`), so a recorded demo can truthfully say which sponsor tech is real on camera.

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest                                    # 177 passing
uvicorn arbiter.web.server:app --port 8000
# open the dashboard, press "Go live" — runs the seven-beat business day above
```

Real rails need test-mode keys (see `.env.example`); without them the demo runs mocked and says so.

## Deploy

The repo ships a `render.yaml` blueprint. Connect the repo at [render.com/new](https://render.com/new) as a Web Service — Render auto-detects the blueprint, installs the `web`/`stripe`/`llm` extras, and serves the dashboard on HTTPS. Add `STRIPE_SECRET_KEY` (test mode) in the Render environment to activate the real Stripe rail; with no keys it runs mocked and the boot banner says so.

## Safety model

| What could go wrong | Which gate catches it |
|---|---|
| Pay a supplier the owner never approved | Payee allowlist — highest-priority rule, BLOCK before any approve path |
| Pay the same invoice twice | Duplicate-fingerprint rule (vendor + amount + ref) |
| Pay an inflated invoice (£840 on a £480 bill) | Amount-mismatch rule |
| Get talked into bypassing checks by a crafted message | Instruction-override rule — hard block, no LLM consulted |
| Supplier impersonation via a sudden bank-detail change | Vendor-detail-change rule → phone escalation on weak evidence |
| Model hallucinates an approval | Rules run first; the LLM can only refine an escalation, never hold the money door |
| Real money moves by accident | No live key in repo; `LiveStripeGlue` refuses a non-`sk_test_` key |

## Repo layout

```
arbiter/
  models.py              # core dataclasses + enums
  policy/rules.py        # deterministic rules (the moat) + payee allowlist
  policy/config.py       # demo_policy_context: the approved-supplier list
  agent/
    agent.py             # 3-layer core + settle() single money door
    nim_nemotron.py      # real NVIDIA NIM client (+ OpenRouter fallback)
    spend_judge.py       # margin-aware spend judgement
    escalation.py        # phone escalation interface
  ledger/event_ledger.py # append-only ledger, dashboard-ready timeline
  business_day.py        # the AP-autopilot day — the seven canonical beats
  operator.py            # the same engine running a business autonomously
  stripe_glue.py         # StripeGlue stub + LiveStripeGlue (real Connect Transfers)
  web/server.py          # FastAPI: /run (the business day), /run_operator, /authorize, /state
  mcp_server.py          # Hermes MCP server exposing the governed door
  cli.py                 # terminal demo runner
scenarios/               # JSON fixtures
dashboard/               # dashboard + phone approval UI
tests/                   # 177 passing — policy, operator, ingest, web, single-door
docs/                    # architecture diagrams and public specs
```

## Team

**Ben Anokye-Davies** and **Alex Kurkar** built Arbiter together.

- **Ben Anokye-Davies** — backend policy engine, agent core, ledger, operator loop, governed payment flow, tests, demo narrative, and submission.
- **Alex Kurkar** — dashboard/front-end experience, phone approval surface, visual demo flow, and product presentation polish.

## No real money

Test mode only. No real charges, payouts, bank transfers, or customer emails. Stripe test keys live in `.env` / `arbiter.env` (gitignored), never committed.
