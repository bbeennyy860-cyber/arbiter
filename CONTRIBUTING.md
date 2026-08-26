# Contributing to Arbiter

Thanks for improving Arbiter. This repository is a hackathon prototype: changes
must preserve the governed-payment boundary and the **Stripe test-mode-only**
constraint.

## Local setup

Arbiter requires Python 3.10 or newer. From the repository root:

```bash
python -m venv .venv
# macOS/Linux
source .venv/bin/activate
# Windows PowerShell
# .venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[dev,web,stripe,llm,mcp]"
```

Copy `.env.example` to `.env` only when testing an optional integration. Never
commit `.env` files or credentials. Stripe keys, if used, must be test-mode keys.

## Verification

Run these before opening a change:

```bash
python -m pytest
python -m pytest --cov=arbiter --cov-report=term
python -m arbiter.cli --operator
python -m build
```

The CI workflow runs the test suite on supported Python versions and builds a
wheel and source distribution. Keep documentation commands executable on a
fresh clone.

## Change scope

- Keep deterministic policy ahead of model judgement and settlement.
- Treat model output as advisory; malformed or unavailable output must not
  approve a payment.
- Do not add live-payment behavior or claim production readiness.
- Add or update tests when changing behavior.
- Use a conventional commit, for example `docs: clarify local setup` or
  `fix: reject malformed settlement input`.

For security-sensitive issues, follow [SECURITY.md](SECURITY.md) rather than
posting sensitive details publicly.
