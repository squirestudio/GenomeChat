import stripe
import logging
from typing import Optional

from config import get_settings

logger = logging.getLogger(__name__)

FREE_QUERY_LIMIT = 20
CREDITS_PER_PACK = 50


def is_test_mode_user(user) -> bool:
    """True if this account should get test-mode Stripe on a live deployment.

    Allowlisted by email so billing can be exercised against production with
    4242 cards. Requires the test credentials to actually be present — an email
    on the list with no test keys configured falls through to live rather than
    silently producing a broken checkout.
    """
    settings = get_settings()
    if not user or not getattr(user, "email", None):
        return False
    if not settings.test_mode_configured():
        return False
    return user.email.strip().lower() in settings.test_mode_emails()


def is_unlimited_user(user) -> bool:
    """True if this account bypasses the query quota by configuration.

    Independent of the Stripe test-mode list on purpose: an account that never
    hits the paywall cannot exercise the purchase flow, so being able to turn
    one off without the other is the point.
    """
    settings = get_settings()
    if not user or not getattr(user, "email", None):
        return False
    return user.email.strip().lower() in settings.unlimited_access_emails()


def stripe_credentials_for(test_mode: bool) -> tuple[str, str, str]:
    """(secret_key, price_unlock, price_credits) for the requested mode."""
    s = get_settings()
    if test_mode:
        return s.stripe_test_secret_key, s.stripe_test_price_unlock, s.stripe_test_price_credits
    return s.stripe_secret_key, s.stripe_price_unlock, s.stripe_price_credits


def create_checkout_session(user_id: int, purchase_type: str, test_mode: bool = False) -> str:
    settings = get_settings()
    secret_key, price_unlock, price_credits = stripe_credentials_for(test_mode)
    price_id = price_unlock if purchase_type == "unlock" else price_credits
    if not secret_key or not price_id:
        raise ValueError("Stripe not configured for this mode")

    stripe.api_key = secret_key

    # Ask Stripe what kind of price this is rather than assuming. A recurring
    # price in a mode="payment" session is rejected outright, so hardcoding the
    # mode means any switch between one-time and subscription pricing silently
    # breaks checkout until someone redeploys.
    try:
        price = stripe.Price.retrieve(price_id)
        recurring = bool(price.get("recurring"))
    except Exception as e:
        logger.warning("Could not inspect price %s (%s) — assuming one-time", price_id, e)
        recurring = False

    metadata = {"user_id": str(user_id), "purchase_type": purchase_type}
    kwargs = dict(
        payment_method_types=["card"],
        line_items=[{"price": price_id, "quantity": 1}],
        mode="subscription" if recurring else "payment",
        metadata=metadata,
        success_url=f"{settings.frontend_url}?payment=success&type={purchase_type}",
        cancel_url=f"{settings.frontend_url}?payment=cancelled",
    )
    # For subscriptions the metadata must also live on the subscription itself:
    # later lifecycle events (cancellation, failed payment) carry the
    # subscription, not the checkout session that created it.
    if recurring:
        kwargs["subscription_data"] = {"metadata": metadata}

    session = stripe.checkout.Session.create(**kwargs)
    if test_mode:
        logger.info("TEST-MODE checkout created for user %s (%s)", user_id, purchase_type)
    return session.url


def verify_webhook(payload: bytes, sig_header: str) -> tuple[dict, bool]:
    """Verify against the live secret, then the test secret. Returns (event, is_test).

    Live and test are separate Stripe environments with separate endpoints and
    separate signing secrets, so a deployment serving both has to accept either.
    Each signature is checked independently — a test-mode event can never be
    validated by the live secret, so this widens what is accepted without
    weakening verification.
    """
    settings = get_settings()
    errors = []

    for secret, is_test in ((settings.stripe_webhook_secret, False),
                            (settings.stripe_test_webhook_secret, True)):
        if not secret:
            continue
        try:
            return stripe.Webhook.construct_event(payload, sig_header, secret), is_test
        except Exception as e:
            errors.append(f"{'test' if is_test else 'live'}: {e}")

    raise ValueError("; ".join(errors) or "No webhook signing secret configured")


def user_can_query(user, has_working_key: bool = False) -> tuple[bool, str]:
    """Returns (allowed, reason). reason is 'free'|'credits'|'unlocked'|'byok'|'blocked'.

    `has_working_key` must reflect a key that actually decrypted, not merely the
    presence of a non-null encrypted_api_key column. Treating an undecryptable
    key as BYOK grants unlimited queries while the request falls back to the
    shared server key — i.e. the operator pays for them.
    """
    if is_unlimited_user(user):
        return True, "unlimited"
    if has_working_key:
        return True, "byok"
    if user.byok_unlocked:
        return True, "unlocked"
    if (user.query_credits or 0) > 0:
        return True, "credits"
    if (user.total_queries or 0) < FREE_QUERY_LIMIT:
        return True, "free"
    return False, "blocked"


def consume_query(user, db, has_working_key: bool = False):
    """Increment counters after a successful query. Call inside an open db session.

    Same rule as user_can_query: only a key that actually decrypted exempts the
    user from spending credits.
    """
    # total_queries still increments for allowlisted accounts — it is the usage
    # record, not the quota — but their credits are never spent.
    user.total_queries = (user.total_queries or 0) + 1
    if not user.byok_unlocked and not has_working_key and not is_unlimited_user(user):
        if (user.query_credits or 0) > 0:
            user.query_credits -= 1
    db.commit()
