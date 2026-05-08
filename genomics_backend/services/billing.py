import stripe
import logging
from config import get_settings

logger = logging.getLogger(__name__)

FREE_QUERY_LIMIT = 20
CREDITS_PER_PACK = 50


def _init_stripe():
    stripe.api_key = get_settings().stripe_secret_key


def create_checkout_session(price_id: str, user_id: int, purchase_type: str) -> str:
    _init_stripe()
    settings = get_settings()
    session = stripe.checkout.Session.create(
        payment_method_types=["card"],
        line_items=[{"price": price_id, "quantity": 1}],
        mode="payment",
        metadata={"user_id": str(user_id), "purchase_type": purchase_type},
        success_url=f"{settings.frontend_url}?payment=success&type={purchase_type}",
        cancel_url=f"{settings.frontend_url}?payment=cancelled",
    )
    return session.url


def verify_webhook(payload: bytes, sig_header: str) -> dict:
    _init_stripe()
    settings = get_settings()
    return stripe.Webhook.construct_event(payload, sig_header, settings.stripe_webhook_secret)


def user_can_query(user) -> tuple[bool, str]:
    """Returns (allowed, reason). reason is 'free'|'credits'|'unlocked'|'byok'|'blocked'."""
    if user.encrypted_api_key:
        return True, "byok"
    if user.byok_unlocked:
        return True, "unlocked"
    if (user.query_credits or 0) > 0:
        return True, "credits"
    if (user.total_queries or 0) < FREE_QUERY_LIMIT:
        return True, "free"
    return False, "blocked"


def consume_query(user, db):
    """Increment counters after a successful query. Call inside an open db session."""
    user.total_queries = (user.total_queries or 0) + 1
    if not user.byok_unlocked and not user.encrypted_api_key:
        if (user.query_credits or 0) > 0:
            user.query_credits -= 1
    db.commit()
