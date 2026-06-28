# Arbiter

**An AI agent that runs a real service business end to end — and refuses any spend that would lose money.**

Seeded with a starting balance, Arbiter takes client jobs, collects payment through Stripe, reads what each job needs, and buys it — but every purchase is checked against that job's margin first. It refuses any spend that would cost more than the job brings in, blocks the fraud and the duplicates, and when something is genuinely ambiguous it stops and asks the owner. The agent never holds the money rail directly; a single governed door is the only path to a payment. Every decision is logged.

Built by **Ben Anokye-Davies** and **Alex Kurkar** for the Nous Research × NVIDIA × Stripe agent hackathon.

## Why this exists

The field is full of agents that *spend* money on your behalf. That's the easy half. The half nobody trusts is letting an agent spend money *unsupervised* — because one bad instruction, one spoofed invoice, one job that quietly runs over budget, and the account is empty.

So autonomous money agents stay demos, never the real thing. Arbiter is built around the missing half: the agent that holds the Stripe key is structurally incapable of making a money-losing spend. It can run the business on its own precisely because the dangerous actions are blocked in code, before any money moves — not promised in a prompt. That's what turns "an agent that can pay" into "an agent you can leave running."

## What it does — runs the business live

Press "Go live" and Arbiter runs a service business autonomously: it takes paid jobs, spends to deliver them, and protects the margin on every one. These are real beats from a live run:

```
JOB  Tide-times API for a surf shop
   EARN  -> OK    £140 booked
   SPEND -> OK    paid to deliver (£30)
JOB  50 product banners for a store
   EARN  -> OK    £90 booked   (margin floor £40)
   SPEND -> OK    paid  image_gen_compute (£35)
   SPEND -> STOP  REFUSED premium_stock_library (£45) — would breach the £40 margin floor
   ESCALATE -> owner taps approve/deny on the borderline spend
   LEDGER: margin protected, every spend checked against the job it serves
```

It earns, it spends to deliver, and the moment a purchase would make a job unprofitable it refuses on the spot — or escalates to the owner's phone when the call is genuinely close. That is the whole pitch in one run: **it runs the business, and it can't be talked into the money-losing version of running it.**

## It also does your books — the same engine, accounts payable

The governance engine isn't operator-specific. Point it at accounts payable and it pays your approved suppliers while blocking everyone else: it pays the suppliers on your allowlist the right amount, refuses a duplicate charge, blocks an inflated invoice, blocks a payee you never approved, and escalates a suspicious bank-detail change to your phone. Same three layers, same single money door, a different job — proof the engine is a reusable asset, not a one-trick demo.

## How it's built — money is never decided by a raw LLM

Three layers, checked in order. The first hard verdict wins, and the payee allowlist is the highest-priority rule of all — nothing reaches an approve path without clearing it.

1. **Deterministic rules** (`arbiter/policy/rules.py`) — first-match-wins rules with no model in the loop: payee-not-approved, duplicate invoice, amount mismatch, vendor-detail change, instruction-override (hard block). This is the moat. A prompt-injection string can't argue with an `if` statement.
2. **Bounded Nemotron reasoning** (`arbiter/agent/nim_nemotron.py`) — real NVIDIA NIM calls, strict-JSON only, used *only* to refine the ambiguous cases the rules can't express. If the model is unreachable or returns malformed output, the decision escalates to a human rather than guessing. It never holds a Stripe tool.
3. **Phone escalation** (`arbiter/agent/escalation.py`) — anything still ambiguous goes to the owner for a one-tap yes/no. The human is the final layer, by design.

**The single money door.** The agent core holds no Stripe key. `ArbiterAgent.settle()` is the only call in the system that can move money, and it runs the full pipeline above before it does. Audit one function, audit every payment.

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
# open the dashboard, press "Go live" — runs the autonomous operator above
```

Real rails need test-mode keys (see `.env.example`); without them the demo runs mocked and says so.

## Deploy

The repo ships a `render.yaml` blueprint. Connect the repo at [render.com/new](https://render.com/new) as a Web Service — Render auto-detects the blueprint, installs the `web`/`stripe`/`llm` extras, and serves the dashboard on HTTPS. Add `STRIPE_SECRET_KEY` (test mode) in the Render environment to activate the real Stripe rail; with no keys it runs mocked and the boot banner says so.

## Safety model

| What could go wrong | Which gate catches it |
|---|---|
| A spend would cost more than the job earns | Margin-protection rule — refuses the purchase before it settles |
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
  operator.py            # the autonomous money-operator loop (earn -> spend -> protect)
  business_day.py        # the accounts-payable variant (same engine, AP beats)
  stripe_glue.py         # StripeGlue stub + LiveStripeGlue (real Connect Transfers)
  web/server.py          # FastAPI: /run_operator (the live demo), /run, /authorize, /state
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
