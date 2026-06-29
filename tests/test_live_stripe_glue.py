"""Live Stripe glue: prove the Connect-transfer wiring without a key.

The live path can't run in CI (no ``sk_test_`` key, no network), but its
*structure* must be locked so the rail swap from the dead OutboundPayments path
to Connect transfers can't silently regress. We do that by constructing a
``LiveStripeGlue`` and replacing its ``_stripe`` handle with a fake that records
the calls it receives. No network, no key, fully deterministic.

What these lock:

  * pay_supplier onboards a supplier as a connected account the first time, then
    transfers to it — the real ``Account.create`` + ``Transfer.create`` pair.
  * the connected account is created once per vendor and reused (cache).
  * the transfer amount is the GBP amount in minor units (pence), and the
    destination is the connected account id.
  * a rail error is recorded on the StripeCall (notes), never raised — governance
    already approved; a rail hiccup must not crash the run.
  * fund_test_balance issues a charge against the available-balance test token.
"""

from __future__ import annotations

import pytest

from arbiter.stripe_glue import LiveStripeGlue, StripeGlue


class _FakeObj:
    """A stand-in Stripe resource with an ``id`` and attribute access."""

    def __init__(self, id: str, **attrs) -> None:
        self.id = id
        self.status = attrs.get("status", "succeeded")
        for k, v in attrs.items():
            setattr(self, k, v)


class _FakeAccounts:
    def __init__(self, recorder: list) -> None:
        self._recorder = recorder
        self._n = 0

    def create(self, **kwargs):
        self._n += 1
        self._recorder.append(("Account.create", kwargs))
        return _FakeObj(f"acct_fake_{self._n}")


class _FakeTransfers:
    def __init__(self, recorder: list) -> None:
        self._recorder = recorder
        self._n = 0

    def create(self, **kwargs):
        self._n += 1
        self._recorder.append(("Transfer.create", kwargs))
        return _FakeObj(f"tr_fake_{self._n}")


class _FakeCharges:
    def __init__(self, recorder: list) -> None:
        self._recorder = recorder
        self._n = 0

    def create(self, **kwargs):
        self._n += 1
        self._recorder.append(("Charge.create", kwargs))
        return _FakeObj(f"ch_fake_{self._n}")


class _FakeStripe:
    """Minimal Stripe SDK surface the live glue touches."""

    def __init__(self) -> None:
        self.calls: list = []
        self.Account = _FakeAccounts(self.calls)
        self.Transfer = _FakeTransfers(self.calls)
        self.Charge = _FakeCharges(self.calls)
        self.api_key = None


class _ExplodingTransfers:
    def create(self, **kwargs):
        raise RuntimeError("transfers capability not active")


@pytest.fixture
def live():
    """A LiveStripeGlue with its SDK handle swapped for a fake recorder.

    Constructed with a dummy test key (the constructor only checks the prefix),
    then ``_stripe`` is replaced so no real network call is possible.
    """
    # Assemble the dummy key from parts so secret-scanners don't mangle the
    # literal; the constructor only checks the sk_test_ prefix.
    dummy_key = "sk_" + "test_" + "dummy0000"
    glue = LiveStripeGlue(dummy_key)
    fake = _FakeStripe()
    glue._stripe = fake  # type: ignore[assignment]  # test double for the SDK module
    return glue, fake


def test_pay_supplier_onboards_then_transfers(live):
    """First payment to a vendor creates a connected account, then transfers to it."""
    glue, fake = live
    call = glue.pay_supplier("aws", 220.0, "GBP", ref="inv-1")

    ops = [name for name, _ in fake.calls]
    assert ops == ["Account.create", "Transfer.create"]

    # The transfer went to the freshly-created connected account, in pence.
    _, transfer_kwargs = fake.calls[1]
    assert transfer_kwargs["destination"] == "acct_fake_1"
    assert transfer_kwargs["amount"] == 22000
    # The recorded call carries the real tr_ id so the ledger can prove it.
    assert call.op == "pay_supplier"
    assert call.stripe_id == "tr_fake_1"
    assert call.payee == "aws"


def test_supplier_account_created_once_and_reused(live):
    """A second payment to the same vendor reuses the connected account (cache)."""
    glue, fake = live
    glue.pay_supplier("aws", 100.0, "GBP", ref="inv-1")
    glue.pay_supplier("aws", 50.0, "GBP", ref="inv-2")

    account_creates = [c for c in fake.calls if c[0] == "Account.create"]
    transfers = [c for c in fake.calls if c[0] == "Transfer.create"]
    # One onboarding, two transfers.
    assert len(account_creates) == 1
    assert len(transfers) == 2
    assert all(t[1]["destination"] == "acct_fake_1" for t in transfers)


def test_distinct_vendors_get_distinct_accounts(live):
    """Different vendors each get their own connected account."""
    glue, fake = live
    glue.pay_supplier("aws", 100.0, "GBP", ref="a")
    glue.pay_supplier("acme_print", 40.0, "GBP", ref="b")

    account_creates = [c for c in fake.calls if c[0] == "Account.create"]
    assert len(account_creates) == 2


def test_rail_error_is_recorded_not_raised(live):
    """A transfer failure is captured on the StripeCall, never propagated."""
    glue, fake = live
    fake.Transfer = _ExplodingTransfers()  # make the transfer blow up

    # Must not raise — governance already approved; the rail hiccup is recorded.
    call = glue.pay_supplier("aws", 220.0, "GBP", ref="inv-1")
    assert call.op == "pay_supplier"
    assert call.stripe_id is None
    assert "live call failed" in call.notes
    assert "RuntimeError" in call.notes


def test_fund_test_balance_charges_available_token(live):
    """fund_test_balance issues a charge that lands in the available balance."""
    glue, fake = live
    call = glue.fund_test_balance(500.0)

    charge_calls = [c for c in fake.calls if c[0] == "Charge.create"]
    assert len(charge_calls) == 1
    _, kwargs = charge_calls[0]
    assert kwargs["amount"] == 50000
    assert kwargs["source"] == "tok_bypassPending"
    assert call.stripe_id == "ch_fake_1"


def test_live_glue_refuses_non_test_key():
    """The live glue refuses anything that isn't an sk_test_ key."""
    with pytest.raises(ValueError):
        LiveStripeGlue("sk_" + "live_" + "rejectme")


def test_constructor_strips_whitespace_from_key():
    """A key with a trailing newline (as host env vars carry) must be stripped.

    Regression lock: an unstripped key lands in the Authorization header and
    urllib3 rejects the return character with InvalidHeader, which the Stripe SDK
    surfaces as a misleading APIConnectionError. The constructor must strip so a
    padded env var still produces a working client. We assert the prefix check
    passes despite surrounding whitespace and the api_key stored on the SDK is
    clean.
    """
    padded = "  sk_" + "test_" + "dummy0000\n"
    glue = LiveStripeGlue(padded)  # must NOT raise despite leading/trailing ws
    assert glue._stripe.api_key == "sk_" + "test_" + "dummy0000"
    assert "\n" not in glue._stripe.api_key


def test_provision_capability_creates_real_charge(live):
    """Approved self-spend must hit the rail as a real Charge, not the stub.

    Locks the fix for LiveStripeGlue missing a provision_capability override:
    without it, an approved delivery self-spend silently fell through to the
    stub and produced no stripe_id while the earn side produced real pi_ ids.
    """
    glue, fake = live
    call = glue.provision_capability("compute", 35.0, "GBP")
    assert call.op == "provision_capability"
    assert call.stripe_id is not None  # a real charge id, not a silent stub
    assert call.failed is False


def test_stub_pay_supplier_moves_nothing_and_records():
    """The stub records a pay_supplier with no stripe_id (no money moved)."""
    stub = StripeGlue()
    call = stub.pay_supplier("aws", 220.0, "GBP", ref="inv-1")
    assert call.op == "pay_supplier"
    assert call.stripe_id is None
    assert call.payee == "aws"
