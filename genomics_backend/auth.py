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

@router.get("/google")
def google_login(request: Request):
    """Redirect user to Google's OAuth consent screen."""
    settings = get_settings()
    if not settings.google_client_id:
        raise HTTPException(status_code=501, detail="Google OAuth not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET")

    callback_url = str(request.base_url).rstrip("/") + "/auth/google/callback"
    params = (
        f"client_id={settings.google_client_id}"
        f"&redirect_uri={callback_url}"
        f"&response_type=code"
        f"&scope=openid%20email%20profile"
        f"&access_type=offline"
        f"&prompt=select_account"
    )
    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{params}")


@router.get("/google/callback")
async def google_callback(code: str, request: Request, db: Session = Depends(get_db)):
    """Exchange Google auth code for user profile, issue JWT, redirect to frontend."""
    settings = get_settings()
    callback_url = str(request.base_url).rstrip("/") + "/auth/google/callback"

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
    else:
        if user.name != name:
            user.name = name
            db.commit()

    token = create_jwt(user.id, user.email)

    # Redirect to frontend with token in query param — frontend stores it
    return RedirectResponse(f"{settings.frontend_url}?token={token}")


@router.get("/me")
def get_me(user: Optional[User] = Depends(get_current_user)):
    """Return current user info, or null if not authenticated."""
    if not user:
        return {"user": None}
    return {"user": {"id": user.id, "email": user.email, "name": user.name}}


@router.post("/logout")
def logout():
    """JWT is stateless — client just drops the token. This endpoint is a no-op for symmetry."""
    return {"message": "Logged out"}
