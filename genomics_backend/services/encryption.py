import logging
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken
from config import get_settings

logger = logging.getLogger(__name__)


class EncryptionNotConfigured(RuntimeError):
    """ENCRYPTION_KEY is missing or is not a usable Fernet key."""


def is_configured() -> bool:
    """True if a well-formed ENCRYPTION_KEY is present."""
    try:
        _fernet()
        return True
    except Exception:
        return False


def _fernet() -> Fernet:
    key = get_settings().encryption_key
    if not key:
        raise EncryptionNotConfigured(
            "ENCRYPTION_KEY not configured — cannot store user API keys. "
            "Generate one with: python -c "
            "'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'"
        )
    try:
        return Fernet(key.encode() if isinstance(key, str) else key)
    except Exception as e:
        # Wrong length, bad base64, stray whitespace from a copy-paste, ...
        raise EncryptionNotConfigured(
            f"ENCRYPTION_KEY is set but is not a valid Fernet key ({e}). It must be "
            "32 url-safe base64-encoded bytes."
        ) from e


def encrypt_key(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_key(ciphertext: str) -> str:
    return _fernet().decrypt(ciphertext.encode()).decode()


def try_decrypt_key(ciphertext: Optional[str]) -> Optional[str]:
    """Decrypt a stored key, returning None if it cannot be used.

    Callers must treat None as "this user has no working key" — never as
    "fall back to the shared server key while still granting BYOK privileges".
    That combination silently bills the operator for a user who appears to be
    on their own key. Failures are logged at ERROR because every cause
    (missing/rotated ENCRYPTION_KEY, corrupted ciphertext) needs operator
    attention.
    """
    if not ciphertext:
        return None
    try:
        return decrypt_key(ciphertext)
    except EncryptionNotConfigured as e:
        logger.error("Cannot decrypt stored user API key: %s", e)
        return None
    except InvalidToken:
        logger.error(
            "Stored user API key failed to decrypt (InvalidToken). ENCRYPTION_KEY "
            "has most likely been rotated — affected users must re-enter their key."
        )
        return None
    except Exception as e:
        logger.error("Unexpected error decrypting stored user API key: %s", e)
        return None
