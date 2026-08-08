"""Reading the abstracts behind a disagreement.

The first place this product reads a paper rather than pointing at one. Every
citation before it was an identifier — enough to link, not enough to compare.
"""
import httpx
import pytest

from services.ai_explainer import EVIDENCE_SYSTEM


def test_it_requires_an_account(base_url):
    r = httpx.post(f"{base_url}/research/evidence",
                   json={"gene": "COL1A1", "disease": "Caffey disease", "verdicts": []}, timeout=30)
    assert r.status_code in (401, 403)


def test_no_cited_papers_says_so_rather_than_calling_the_model(base_url, make_user, auth):
    """A disagreement where nobody recorded a citation is common — Ambry did
    exactly that on Caffey disease. Spending a model call to say nothing was
    cited would be charging for an empty answer."""
    u = make_user("evidence-none@example.com")
    r = httpx.post(f"{base_url}/research/evidence", headers=auth(u), timeout=30,
                   json={"gene": "COL1A1", "disease": "Caffey disease",
                         "verdicts": [{"submitter": "Ambry", "classification": "Moderate", "pmids": []}]})
    assert r.status_code == 200
    body = r.json()
    assert body["summary"] == ""
    assert "no papers" in body["reason"].lower()


def test_the_prompt_forbids_going_beyond_the_abstracts():
    """The failure that costs a researcher a month is a confident sentence about
    a cohort size the abstract never stated."""
    assert "Use only the abstracts provided" in EVIDENCE_SYSTEM
    assert "have not read the full papers" in EVIDENCE_SYSTEM


def test_the_prompt_refuses_to_adjudicate():
    """Showing what each side read is the job. Deciding who is right is not —
    that is a curation judgement and the model has no standing to make it."""
    assert "Do not resolve the disagreement" in EVIDENCE_SYSTEM
    assert "not adjudicating" in EVIDENCE_SYSTEM


def test_the_prompt_carries_the_no_diagnosis_rules(base_url):
    from services.ai_explainer import NO_DIAGNOSIS_RULES
    assert NO_DIAGNOSIS_RULES
