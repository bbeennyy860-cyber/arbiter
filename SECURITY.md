# Security policy

## Supported versions

Security fixes are considered for the current default branch. Arbiter is a
hackathon prototype and is **not** a production payment service.

## Reporting a vulnerability

Do not include secrets, Stripe keys, customer data, or detailed exploit steps in
a public issue. Use GitHub's private vulnerability-reporting feature when it is
enabled for this repository. If it is unavailable, contact the maintainers
privately and include only the information needed to reproduce the issue safely.

A useful report includes:

- affected commit or version;
- a minimal, non-sensitive reproduction;
- impact and the payment-safety boundary involved; and
- any suggested mitigation.

## Scope boundary

Arbiter is designed for Stripe **test mode only**. A report that reveals a path
to live charges, payouts, transfers, ungoverned settlement, approval bypass, or
secret disclosure is security-sensitive and should be handled privately.
