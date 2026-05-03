from cryptography.fernet import Fernet
from config import get_settings


def _fernet() -> Fernet:
    key = get_settings().encryption_key
    if not key:
        raise ValueError("ENCRYPTION_KEY not configured — cannot store API keys")
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt_key(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_key(ciphertext: str) -> str:
    return _fernet().decrypt(ciphertext.encode()).decode()
