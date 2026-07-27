"""A stored API key only counts as BYOK if it actually decrypts.

Treating an undecryptable key as BYOK granted unlimited queries while the
request fell back to the shared server key — the operator paid for them.
"""
import pytest
from cryptography.fernet import Fernet

from services import billing, encryption
from services.billing import FREE_QUERY_LIMIT


class FakeUser:
    def __init__(self, **kw):
        self.email = "pytest-keys@test.local"
        self.byok_unlocked = False
        self.byok_purchased = False
        self.query_credits = 0
        self.total_queries = 0
        self.encrypted_api_key = None
        self.__dict__.update(kw)


class FakeDB:
    def commit(self):
        pass


def test_garbage_ciphertext_decrypts_to_none():
    assert encryption.try_decrypt_key("not-a-valid-fernet-token") is None


@pytest.mark.parametrize("value", [None, ""])
def test_missing_ciphertext_decrypts_to_none(value):
    assert encryption.try_decrypt_key(value) is None


def test_a_key_from_a_rotated_encryption_key_decrypts_to_none():
    other = Fernet(Fernet.generate_key()).encrypt(b"sk-ant-old").decode()
    assert encryption.try_decrypt_key(other) is None


def test_an_unusable_key_does_not_grant_unlimited_access():
    over_quota = FakeUser(total_queries=FREE_QUERY_LIMIT + 500,
                          encrypted_api_key="not-a-valid-fernet-token")
    working = encryption.try_decrypt_key(over_quota.encrypted_api_key) is not None
    allowed, reason = billing.user_can_query(over_quota, has_working_key=working)
    assert (allowed, reason) == (False, "blocked")


def test_presence_alone_would_have_allowed_it():
    """Documents the original bug: the old check was `if user.encrypted_api_key`."""
    u = FakeUser(encrypted_api_key="not-a-valid-fernet-token")
    assert bool(u.encrypted_api_key) is True


@pytest.mark.skipif(not encryption.is_configured(), reason="ENCRYPTION_KEY not set")
def test_a_real_key_round_trips_and_grants_access():
    ciphertext = encryption.encrypt_key("sk-ant-wellformed")
    assert encryption.try_decrypt_key(ciphertext) == "sk-ant-wellformed"
    u = FakeUser(total_queries=FREE_QUERY_LIMIT + 500, encrypted_api_key=ciphertext)
    allowed, reason = billing.user_can_query(u, has_working_key=True)
    assert (allowed, reason) == (True, "byok")


def test_a_broken_key_still_spends_credits():
    u = FakeUser(query_credits=5, encrypted_api_key="broken")
    billing.consume_query(u, FakeDB(), has_working_key=False)
    assert u.query_credits == 4


def test_a_working_key_spends_none():
    u = FakeUser(query_credits=5, encrypted_api_key="whatever")
    billing.consume_query(u, FakeDB(), has_working_key=True)
    assert u.query_credits == 5
