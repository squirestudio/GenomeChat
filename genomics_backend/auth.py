"""
Google OAuth + JWT authentication.

Flow:
  1. Frontend redirects user to GET /auth/google
  2. User signs in with Google → redirected to GET /auth/google/callback
  3. Backend exchanges code for Google token, fetches user profile
  4. Creates or updates User row (email + name only — no searches stored here)
  5. Returns short-lived JWT to frontend via redirect to {frontend_url}?token=...
  6. Frontend stores JWT in localStorage, sends as Authorization: Bearer <token>
  7. get_current_user() dependency decodes JWT on protected routes

Privacy:
  - Only email + display name stored in users table
  - Queries are linked to user_id so users only ever see their own history
  - Users can delete any of their own queries or projects at any time
  - No raw genetic data is ever persisted
"""

import httpx
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from config import get_settings
from database.models import get_db, User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


# ── JWT helpers ───────────────────────────────────────────────────────────────

def create_jwt(user_id: int, email: str) -> str:
    settings = get_settings()
    expire = datetime.utcnow() + timedelta(hours=settings.jwt_expire_hours)
    return jwt.encode(
        {"sub": str(user_id), "email": email, "exp": expire},
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )


def decode_jwt(token: str) -> Optional[dict]:
    settings = get_settings()
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None


# ── Dependency: get current user from Bearer token ────────────────────────────

def get_current_user(request: Request, db: Session = Depends(get_db)) -> Optional[User]:
    """Returns User if a valid JWT is present, otherwise None (routes decide if required)."""
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else None
    if not token:
        return None
    payload = decode_jwt(token)
    if not payload:
        return None
    user = db.query(User).filter(User.id == int(payload["sub"])).first()
    return user


def require_user(user: Optional[User] = Depends(get_current_user)) -> User:
    """Raises 401 if not authenticated. Use as a dependency on protected routes."""
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


# ── OAuth routes ──────────────────────────────────────────────────────────────

def _callback_url(request: Request) -> str:
    """Build the OAuth callback URL. Uses BACKEND_URL env var if set (needed behind Railway proxy)."""
    settings = get_settings()
    base = settings.backend_url.rstrip("/") if settings.backend_url else str(request.base_url).rstrip("/")
    return base + "/auth/google/callback"


@router.get("/google")
def google_login(request: Request, ref: str = ""):
    """Redirect user to Google's OAuth consent screen.

    `ref` is an optional referral code, carried through in OAuth `state` — the
    parameter that exists to survive this round trip. Threading it here rather
    than offering an endpoint to claim a code later means it cannot outlive the
    sign-in it arrived with, so an established account cannot backdate one.
    """
    settings = get_settings()
    if not settings.google_client_id:
        raise HTTPException(status_code=501, detail="Google OAuth not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET")

    callback_url = _callback_url(request)
    params = (
        f"client_id={settings.google_client_id}"
        f"&redirect_uri={callback_url}"
        f"&response_type=code"
        f"&scope=openid%20email%20profile"
        f"&access_type=offline"
        f"&prompt=select_account"
    )
    # Codes are short and urlsafe by construction; anything else is discarded
    # rather than reflected into the redirect.
    safe_ref = "".join(c for c in (ref or "") if c.isalnum() or c in "-_")[:16]
    if safe_ref:
        params += f"&state={safe_ref}"
    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{params}")


@router.get("/google/callback")
async def google_callback(code: str, request: Request, state: str = "", db: Session = Depends(get_db)):
    """Exchange Google auth code for user profile, issue JWT, redirect to frontend."""
    settings = get_settings()
    callback_url = _callback_url(request)

    async with httpx.AsyncClient() as client:
        # Exchange code for tokens
        token_resp = await client.post(GOOGLE_TOKEN_URL, data={
            "code": code,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "redirect_uri": callback_url,
            "grant_type": "authorization_code",
        })
        if token_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to exchange Google code")

        access_token = token_resp.json().get("access_token")

        # Fetch user profile
        profile_resp = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if profile_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to fetch Google profile")

        profile = profile_resp.json()

    email = profile.get("email", "").lower().strip()
    name = profile.get("name") or profile.get("given_name") or email.split("@")[0]

    if not email:
        raise HTTPException(status_code=400, detail="Google profile missing email")

    # Upsert user — only store email + display name, nothing else
    user = db.query(User).filter(User.email == email).first()
    if not user:
        user = User(email=email, name=name)
        db.add(user)
        db.commit()
        db.refresh(user)
        logger.info(f"New user registered: {email}")
        # Only a brand-new account can carry a referral. attach_pending_referral
        # re-checks that regardless, but not calling it for returning users
        # keeps the intent obvious at the call site.
        if state:
            from services.billing import attach_pending_referral
            attach_pending_referral(user, state, db)
    else:
        if user.name != name:
            user.name = name
            db.commit()

    token = create_jwt(user.id, user.email)

    # Redirect to frontend with token in query param — frontend stores it
    return RedirectResponse(f"{settings.frontend_url}?token={token}")


@router.get("/me")
def get_me(user: Optional[User] = Depends(get_current_user), db: Session = Depends(get_db)):
    """Return current user info, or null if not authenticated."""
    if not user:
        return {"user": None}
    from services.billing import (FREE_QUERY_LIMIT, is_test_mode_user, is_unlimited_user,
                                  ensure_referral_code, REFERRAL_CAP, REFERRAL_CREDITS)
    from services.encryption import try_decrypt_key
    # Reports whether the stored key actually works, not just that a row exists.
    # A user whose key cannot be decrypted is not on BYOK, and the UI must not
    # tell them they are.
    has_working_key = try_decrypt_key(user.encrypted_api_key) is not None
    return {"user": {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "byok_unlocked": bool(user.byok_unlocked),
        "query_credits": user.query_credits or 0,
        "total_queries": user.total_queries or 0,
        # Generated on first read rather than at signup — most accounts never
        # open the referral card, and an unused code is a row nobody needed.
        "referral_code": ensure_referral_code(user, db),
        "referrals_converted": user.referrals_converted or 0,
        "referral_cap": REFERRAL_CAP,
        "referral_credits": REFERRAL_CREDITS,
        "free_limit": FREE_QUERY_LIMIT,
        "has_stored_key": has_working_key,
        # The one-time right to store a key, separate from the subscription.
        "byok_purchased": bool(user.byok_purchased) or is_unlimited_user(user),
        # Drives the "Manage subscription" entry point.
        # byok_unlocked implies they went through checkout at some point, so the
        # portal is reachable even before the customer id has been backfilled.
        "has_billing_account": bool(user.stripe_customer_id) or bool(user.byok_unlocked) or bool(user.byok_purchased),
        # True only when a key is stored but unusable — prompts re-entry.
        "stored_key_unusable": bool(user.encrypted_api_key) and not has_working_key,
        # Drives the visible TEST MODE badge so an allowlisted account can never
        # mistake a 4242 purchase for a real one.
        "stripe_test_mode": is_test_mode_user(user),
        # Quota bypassed by configuration rather than by purchase.
        "unlimited_access": is_unlimited_user(user),
    }}


@router.post("/logout")
def logout():
    """JWT is stateless — client just drops the token. This endpoint is a no-op for symmetry."""
    return {"message": "Logged out"}
