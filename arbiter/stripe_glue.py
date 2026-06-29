"""Stripe integration glue.

A thin interface the agent core calls to move money on the Stripe rail. Two
implementations behind one interface:

  * ``StripeGlue``     — records what *would* happen; zero keys, deterministic.
                          The demo and tests run on this.
  * ``LiveStripeGlue`` — real Stripe test-mode calls. ``pay_supplier`` creates a
                          real Connect transfer (tr_...) to a connected supplier
                          account; ``create_checkout`` / ``create_payment``
                          create real test-mode money-in objects. Selected
                          automatically when STRIPE_SECRET_KEY (sk_test_...) is set.

The accounts-payable story turns on ``pay_supplier``: once governance APPROVES a
supplier payment, THIS is the call that actually pays them. The agent never
calls it for a blocked/escalated decision — only an approved one reaches the rail.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional, Protocol


@dataclass
class StripeCall:
    """A record of a Stripe operation the agent asked to perform.

    ``stripe_id`` carries the real object id when a live call produced one
    (``cs_...`` checkout, ``pi_...`` payment, ``tr_...`` transfer); it stays None
    on the stub so a test never mistakes a stub for a real settlement.
    """

    op: str  # create_invoice | create_checkout | create_payment | webhook_received | provision_capability | pay_supplier | fund_test_balance
    ref: Optional[str] = None
    amount: Optional[float] = None
    currency: str = "GBP"
    category: Optional[str] = None
    test_mode: bool = True
    notes: str = ""
    stripe_id: Optional[str] = None
    payee: Optional[str] = None
    # True when a live rail call was attempted but errored — the call is recorded
    # (not raised) so governance never crashes, but settle() must NOT count a
    # failed rail call as executed. Stays False on the stub and on successful
    # live calls. See settle() in agent.py.
    failed: bool = False
    # The governance event id this rail call settled (e.g. "job_02:spend:img").
    # Stamped by settle() after execution so the dashboard can join a paid row to
    # its Stripe receipt by id. Optional: ops not driven through settle() (the
    # inbound checkout/webhook pair) leave it None.
    event_id: Optional[str] = None


class StripeBackend(Protocol):
    """The surface the agent core depends on. Both glues satisfy it."""

    calls: list[StripeCall]

    def create_invoice(self, ref: str, amount: float, currency: str = "GBP") -> StripeCall: ...
    def create_checkout(self, ref: str, amount: float, currency: str = "GBP") -> StripeCall: ...
    def create_payment(self, ref: str, amount: float, currency: str = "GBP") -> StripeCall: ...
    def webhook_received(self, event_type: str, ref: Optional[str] = None) -> StripeCall: ...
    def provision_capability(self, category: str, amount: float, currency: str = "GBP") -> StripeCall: ...
    def pay_supplier(self, payee: str, amount: float, currency: str = "GBP",
                     ref: Optional[str] = None) -> StripeCall: ...


class StripeGlue:
    """No-op stub. Records calls; does not hit the Stripe API."""

    backend = "stub"

    def __init__(self) -> None:
        self.calls: list[StripeCall] = []

    def create_invoice(self, ref: str, amount: float, currency: str = "GBP") -> StripeCall:
        c = StripeCall(op="create_invoice", ref=ref, amount=amount, currency=currency, notes="test-mode stub")
        self.calls.append(c)
        return c

    def create_checkout(self, ref: str, amount: float, currency: str = "GBP") -> StripeCall:
        c = StripeCall(op="create_checkout", ref=ref, amount=amount, currency=currency, notes="test-mode stub")
        self.calls.append(c)
        return c

    def create_payment(self, ref: str, amount: float, currency: str = "GBP") -> StripeCall:
        """Record the inbound customer payment for a job (stub: no real PaymentIntent).

        The operator's earn beat calls this when a client pays an invoice. The live
        glue creates a real confirmed test-mode PaymentIntent; the stub just records
        it so offline runs and tests need no Stripe key.
        """
        c = StripeCall(op="create_payment", ref=ref, amount=amount, currency=currency,
                       notes="test-mode stub — would create a confirmed PaymentIntent")
        self.calls.append(c)
        return c

    def webhook_received(self, event_type: str, ref: Optional[str] = None) -> StripeCall:
        c = StripeCall(op="webhook_received", ref=ref, notes=f"event_type={event_type}")
        self.calls.append(c)
        return c

    def provision_capability(self, category: str, amount: float, currency: str = "GBP") -> StripeCall:
        c = StripeCall(op="provision_capability", category=category, amount=amount, currency=currency,
                       notes="self-spend reinvest")
        self.calls.append(c)
        return c

    def pay_supplier(self, payee: str, amount: float, currency: str = "GBP",
                     ref: Optional[str] = None) -> StripeCall:
        """Record a supplier payment that governance approved (stub: no money moves)."""
        c = StripeCall(op="pay_supplier", payee=payee, amount=amount, currency=currency,
                       ref=ref, notes="test-mode stub — would create a Connect transfer")
        self.calls.append(c)
        return c


class LiveStripeGlue(StripeGlue):
    """Real Stripe test-mode calls. Falls back to recording if the SDK errors.

    Inherits the stub's recording so every call is still logged; overrides the
    methods that should hit the real API. Test-mode only — refuses a live key.

    The ``pay_supplier`` path uses **Stripe Connect transfers**, not the v2
    money-management OutboundPayment API. OutboundPayments need a Treasury
    financial account (``fa_...``) that a team cannot provision with a bare
    test key; a Connect transfer to a connected "supplier" account is the real
    "move money to a third party" primitive that works with only a test key
    plus a one-time, free **Connect → Get started** toggle in the dashboard.
    It produces a real ``tr_...`` object visible under Balances → Transactions.

    Every live method is wrapped so a rail error (missing capability,
    unconfigured account) is *recorded with the error* rather than raised:
    governance has already decided, and a rail hiccup must never crash the run
    or — worse — turn an approved decision into a silent no-op the caller can't
    see. The recorded ``notes`` carry the exact API error for diagnosis.
    """

    backend = "live-test"

    # Connected "supplier" accounts created in this process, keyed by vendor_id.
    # Created lazily on first payment to a vendor and reused thereafter. In a
    # real product this mapping would persist; for the demo, per-run is enough.
    _supplier_accounts: dict[str, str]

    def __init__(self, secret_key: str) -> None:
        super().__init__()
        if not secret_key.startswith("sk_test_"):
            raise ValueError("LiveStripeGlue refuses a non-test key — test-mode only (sk_test_...).")
        import stripe  # imported lazily so the stub path needs no dependency
        self._stripe = stripe
        self._stripe.api_key = secret_key
        self._supplier_accounts = {}
        # The platform's settlement country/currency for connected accounts and
        # transfers. Defaults to GB/gbp to match the demo's sterling amounts;
        # override via env if the test account is registered elsewhere.
        self.country = os.environ.get("STRIPE_PLATFORM_COUNTRY", "GB").upper()
        self.currency = os.environ.get("STRIPE_PLATFORM_CURRENCY", "gbp").lower()

    def create_checkout(self, ref: str, amount: float, currency: str = "GBP") -> StripeCall:
        try:
            session = self._stripe.checkout.Session.create(
                mode="payment",
                line_items=[{
                    "price_data": {"currency": currency.lower(),
                                   "product_data": {"name": ref or "Arbiter invoice"},
                                   "unit_amount": int(round(amount * 100))},
                    "quantity": 1,
                }],
                success_url="https://example.com/ok",
                cancel_url="https://example.com/no",
            )
            c = StripeCall(op="create_checkout", ref=ref, amount=amount, currency=currency,
                           notes="live test-mode", stripe_id=session.id)
        except Exception as e:  # noqa: BLE001 — never let a rail error crash governance
            c = StripeCall(op="create_checkout", ref=ref, amount=amount, currency=currency,
                           notes=f"live call failed, recorded only: {type(e).__name__}: {e}",
                           failed=True)
        self.calls.append(c)
        return c

    def create_payment(self, ref: str, amount: float, currency: str = "GBP") -> StripeCall:
        """Create a real, confirmed test-mode PaymentIntent — the inbound 'client paid'.

        Uses Stripe's canonical test card token (pm_card_visa) and confirms inline,
        so the result is a genuine money-in object on the rail: a ``pi_..`` id in
        ``succeeded`` state with a real charge, retrievable from the test dashboard.
        Redirects are disabled so confirmation completes synchronously. A rail error
        is recorded rather than raised so a hiccup never crashes governance.
        """
        try:
            pi = self._stripe.PaymentIntent.create(
                amount=int(round(amount * 100)),
                currency=currency.lower(),
                payment_method="pm_card_visa",
                confirm=True,
                automatic_payment_methods={"enabled": True, "allow_redirects": "never"},
                description=f"Arbiter: client pays invoice {ref}",
                metadata={"invoice_ref": ref or ""},
            )
            c = StripeCall(op="create_payment", ref=ref, amount=amount, currency=currency,
                           notes=f"live test-mode PaymentIntent ({pi.status})", stripe_id=pi.id)
        except Exception as e:  # noqa: BLE001 — never let a rail error crash governance
            c = StripeCall(op="create_payment", ref=ref, amount=amount, currency=currency,
                           notes=f"live call failed, recorded only: {type(e).__name__}: {e}",
                           failed=True)
        self.calls.append(c)
        return c

    def _ensure_supplier_account(self, vendor_id: str) -> str:
        """Return a connected-account id for ``vendor_id``, creating one once.

        Models supplier onboarding: a connected account is the supplier's
        identity on the rail. Created with the transfers capability requested and
        TOS acceptance so the account meets requirements and can receive
        transfers immediately in test mode.
        """
        cached = self._supplier_accounts.get(vendor_id)
        if cached:
            return cached
        acct = self._stripe.Account.create(
            country=self.country,
            email=f"{vendor_id}@suppliers.arbiter.test",
            controller={
                "losses": {"payments": "application"},
                "fees": {"payer": "application"},
                "stripe_dashboard": {"type": "none"},
                "requirement_collection": "application",
            },
            capabilities={"transfers": {"requested": True}},
            business_type="company",
            business_profile={"name": vendor_id, "product_description": "Approved supplier"},
            tos_acceptance={"date": 1609459200, "ip": "127.0.0.1"},
            metadata={"arbiter_vendor_id": vendor_id, "approved_by": "governance_engine"},
        )
        self._supplier_accounts[vendor_id] = acct.id
        return acct.id

    def fund_test_balance(self, amount: float, currency: Optional[str] = None) -> StripeCall:
        """Add immediately-available test funds so transfers have a balance.

        Uses the ``tok_bypassPending`` test token, whose charge lands directly in
        the available (not pending) balance in test mode — so a transfer right
        after it succeeds. Demo-only plumbing: real revenue would fund the
        balance through Checkout/Invoices.
        """
        cur = (currency or self.currency).lower()
        try:
            charge = self._stripe.Charge.create(
                amount=int(round(amount * 100)),
                currency=cur,
                source="tok_bypassPending",
                description="Arbiter demo: fund test-mode available balance",
            )
            c = StripeCall(op="fund_test_balance", amount=amount, currency=cur,
                           notes="live test-mode available-balance top-up",
                           stripe_id=getattr(charge, "id", None))
        except Exception as e:  # noqa: BLE001
            c = StripeCall(op="fund_test_balance", amount=amount, currency=cur,
                           notes=f"live call failed, recorded only: {type(e).__name__}: {e}")
        self.calls.append(c)
        return c

    def provision_capability(self, category: str, amount: float, currency: str = "GBP") -> StripeCall:
        """Create a real test-mode charge for an approved delivery self-spend.

        The agent buying a capability to deliver a job (stock footage, render
        credits, hosting) is a real outbound spend, so it should leave a real
        receipt on the rail — not a silent stub. Uses the canonical test card
        token so the charge lands as a genuine ``ch_..`` object retrievable from
        the test dashboard. A rail error is recorded rather than raised so a
        hiccup never crashes governance, matching the other live primitives.
        """
        cur = (currency or self.currency).lower()
        try:
            charge = self._stripe.Charge.create(
                amount=int(round(amount * 100)),
                currency=cur,
                source="tok_visa",
                description=f"Arbiter: delivery spend ({category})",
                metadata={"arbiter_category": category},
            )
            c = StripeCall(op="provision_capability", category=category, amount=amount, currency=cur,
                           notes=f"live test-mode charge ({getattr(charge, 'status', 'created')})",
                           stripe_id=getattr(charge, "id", None))
        except Exception as e:  # noqa: BLE001 — never let a rail error crash governance
            c = StripeCall(op="provision_capability", category=category, amount=amount, currency=cur,
                           notes=f"live call failed, recorded only: {type(e).__name__}: {e}",
                           failed=True)
        self.calls.append(c)
        return c

    def pay_supplier(self, payee: str, amount: float, currency: str = "GBP",
                     ref: Optional[str] = None) -> StripeCall:
        """Create a real test-mode Connect transfer to an approved supplier.

        Onboards the supplier as a connected account on first payment, then
        moves the money with ``Transfer.create`` — a real ``tr_...`` object in
        the test dashboard. The transfer currency follows the platform currency
        (the balance is held in that currency); the requested ``currency`` is
        recorded for the ledger. If the rail errors (transfers capability not
        yet active, no balance), the call is recorded with the error rather than
        raised — governance already approved; a rail hiccup must not crash.
        """
        try:
            destination = self._ensure_supplier_account(payee)
            transfer = self._stripe.Transfer.create(
                amount=int(round(amount * 100)),
                currency=self.currency,
                destination=destination,
                description=ref or f"AP autopilot payment to {payee}",
                metadata={"arbiter_vendor_id": payee, "ref": ref or ""},
            )
            c = StripeCall(op="pay_supplier", payee=payee, amount=amount, currency=currency, ref=ref,
                           notes=f"live test-mode Connect transfer -> {destination}",
                           stripe_id=getattr(transfer, "id", None))
        except Exception as e:  # noqa: BLE001
            c = StripeCall(op="pay_supplier", payee=payee, amount=amount, currency=currency, ref=ref,
                           notes=f"live call failed, recorded only: {type(e).__name__}: {e}",
                           failed=True)
        self.calls.append(c)
        return c


def select_stripe() -> StripeGlue:
    """Real test-mode glue when STRIPE_SECRET_KEY (sk_test_...) is set, else the stub.

    Prints which backend is active so the demo shows at boot whether the Stripe
    rail is real or recorded — same honesty discipline as the Nemotron banner.
    """
    key = os.environ.get("STRIPE_SECRET_KEY", "")
    if key.startswith("sk_test_"):
        try:
            glue = LiveStripeGlue(key)
            print("[arbiter] Stripe layer: REAL test-mode (sk_test_...)")
            return glue
        except Exception as e:  # noqa: BLE001 — bad key/SDK -> fall back honestly
            print(f"[arbiter] Stripe layer: stub (live init failed: {type(e).__name__}: {e})")
            return StripeGlue()
    if key and not key.startswith("sk_test_"):
        print("[arbiter] Stripe layer: stub (refusing non-test key — set sk_test_... only)")
    else:
        print("[arbiter] Stripe layer: stub (no STRIPE_SECRET_KEY set)")
    return StripeGlue()
