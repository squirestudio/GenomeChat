"""Deferred datasets: charged only when they return something."""
import httpx
import pytest

from services.genomics_api_real import section_has_data

pytestmark_unit = None


@pytest.mark.parametrize("payload,expected", [
    ({"pathways": []}, False),
    ({"omim": {}}, False),
    ({"alphafold": None, "domains": []}, False),
    ({"pathways": [{"name": "x"}]}, True),
    ({"omim": {"gene_entry": {"mim_number": "1"}}}, True),
    ({"publication_count": 0}, False),
    ({"publication_count": 12}, True),
])
def test_emptiness_is_judged_on_content_not_shape(payload, expected):
    assert section_has_data(payload) is expected


@pytest.mark.external
def test_an_empty_section_costs_nothing(base_url, make_user, auth, fresh):
    """Whether a source holds anything cannot be known without asking, so the
    cost falls on a useful answer rather than on the attempt."""
    user = make_user("pytest-sections@test.local", query_credits=10)
    r = httpx.post(f"{base_url}/gene/section",
                   json={"gene": "SOD1", "section": "pathways"},
                   headers=auth(user), timeout=180)
    assert r.status_code == 200
    body = r.json()
    if body["empty"]:
        assert body["charged"] is False
        assert fresh(user).query_credits == 10
    else:
        assert body["charged"] is True
        assert fresh(user).query_credits == 9
