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


# ── disease answers offer follow-up questions, not datasets ──────────────────

def test_disease_results_are_unstaged_by_default():
    """Callers that ask for everything still get the original shape."""
    import asyncio
    from services.genomics_api_real import run_disease_pipeline
    # No network needed for the shape check when the gene list is empty.
    result = asyncio.get_event_loop_policy().new_event_loop().run_until_complete(
        _empty_disease()
    )
    assert result["pending_sections"] == []


async def _empty_disease():
    from services.genomics_api_real import run_disease_pipeline
    import services.genomics_api_real as g
    original = g.fetch_disease_genes
    g.fetch_disease_genes = lambda name: _no_genes()
    try:
        return await run_disease_pipeline("nothing at all", staged=True)
    finally:
        g.fetch_disease_genes = original


async def _no_genes():
    return []


@pytest.mark.external
def test_a_disease_query_offers_its_top_genes_as_follow_ups(base_url):
    """The useful next step from a gene list is reading about one of the genes."""
    import json
    import httpx

    event = None
    with httpx.stream("POST", f"{base_url}/chat/stream",
                      json={"message": "Which genes are linked to Parkinson's disease?"},
                      headers={"X-Forwarded-For": "203.0.113.60"}, timeout=300) as r:
        assert r.status_code == 200
        for line in r.iter_lines():
            if line.startswith("event: "):
                event = line[7:].strip()
            elif line.startswith("data: ") and event == "data":
                data = json.loads(line[6:])["data"]
                break

    assert data["gene_count"] > 0
    pending = data["pending_sections"]
    assert pending, "a disease answer should offer somewhere to go next"
    for p in pending:
        assert p["key"].startswith("ask:")
        assert p["ask"].endswith(" variants"), "follow-ups are questions, not fetches"


# ── distinguishing "nothing there" from "could not ask" ──────────────────────

def test_source_failures_are_recorded_per_request():
    """A tolerated failure must still be reported, or an outage reads as a finding."""
    from services.genomics_api_real import begin_source_tracking, record_source_failure

    failures = begin_source_tracking()
    record_source_failure("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?x=1", "HTTP 503")
    record_source_failure("https://gtexportal.org/api/v2/expression", "timeout")
    assert failures == {"NCBI", "GTEx"}


def test_tracking_starts_clean_for_each_request():
    from services.genomics_api_real import begin_source_tracking, record_source_failure
    first = begin_source_tracking()
    record_source_failure("https://rest.ensembl.org/lookup", "boom")
    assert first == {"Ensembl"}
    second = begin_source_tracking()
    assert second == set(), "a new request must not inherit the last one's failures"


@pytest.mark.parametrize("url,expected", [
    ("https://rest.uniprot.org/uniprotkb/search", "UniProt"),
    ("https://string-db.org/api/json/get_string_ids", "STRING"),
    ("https://api.pharmgkb.org/v1/data/gene", "PharmGKB"),
    ("https://example.invalid/whatever", "upstream"),
])
def test_failures_are_attributed_to_the_right_source(url, expected):
    from services.genomics_api_real import _source_for
    assert _source_for(url) == expected
