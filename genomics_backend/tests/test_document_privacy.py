"""Uploaded documents reach the prompt and nothing else.

`personal_documents` carries three separate obligations, and all three are
discharged by the same rule — use it for this request, then forget it:

  privacy    A paper someone uploads about their own condition discloses a
             suspected diagnosis. That is health data, and arguably more
             revealing than the variants: a genome needs interpretation,
             "I am reading about osteogenesis imperfecta" does not.
  copyright  MyDNA has no licence to hold a publisher's text. It needs none to
             help someone read their own lawful copy, and would need one to
             keep a copy.
  honesty    The upload notice promises outright that nothing is stored.

So the persistence test here is not a nice-to-have. Adding these to the stored
payload would break a published commitment, and would do it silently.
"""
import pathlib
import re

import pytest

from services.ai_explainer import (
    _format_documents,
    build_explanation_messages,
    build_followup_messages,
)

PAPER = {
    "title": "Novel mutations in WNT1, TMEM38B, P4HB and PLS3",
    "citation": "2019 · doi:10.4158/EP-2018-0443",
    "passages": [
        "Hypotonia and ataxia were the most frequently reported neural symptoms.",
        "TMEM38B encodes trimeric intracellular cation channel type B.",
    ],
}


# ── never stored ─────────────────────────────────────────────────────────────

def _main_source():
    return (pathlib.Path(__file__).resolve().parent.parent / "main.py").read_text()


def test_the_stored_payload_does_not_carry_documents():
    """The dict written to queries.results is built field by field. If
    personal_documents ever appears in it, a publisher's text and a reader's
    suspected diagnosis both land in the database."""
    src = _main_source()
    stored = re.search(r"stored = \{(.*?)\n            \}", src, re.S)
    assert stored, "the stored payload literal moved — re-point this test, do not delete it"
    assert "personal_documents" not in stored.group(1)


def test_no_document_ever_reaches_a_database_row():
    """Belt and braces on the above: nothing constructing a persisted row may
    mention the field at all."""
    src = _main_source()
    for call in re.findall(r"QueryModel\((.*?)\)", src, re.S):
        assert "personal_documents" not in call


def test_the_field_is_bounded():
    """Every element is forwarded into the prompt, so an unbounded list is an
    unbounded bill — the same reasoning as personal_variants."""
    src = _main_source()
    line = next(l for l in src.splitlines() if "personal_documents: Optional" in l)
    assert "max_length" in line


# ── what the model is given ──────────────────────────────────────────────────

def test_documents_reach_the_prompt():
    block = _format_documents([PAPER])
    assert "Novel mutations in WNT1" in block
    assert "Hypotonia and ataxia" in block
    assert "10.4158/EP-2018-0443" in block


def test_the_prompt_says_the_documents_are_not_ours():
    """A single paper's cohort must not start sounding like established fact,
    so the model is told to attribute it and to keep it separate from the
    curated sources."""
    block = _format_documents([PAPER]).lower()
    assert "reader's own materials" in block
    assert "cite them by title" in block
    assert "distinct from the curated databases" in block
    assert "never stored" in block


def test_contradictions_must_be_surfaced_not_smoothed_over():
    assert "contradicts" in _format_documents([PAPER]).lower()


@pytest.mark.parametrize("builder", ["explanation", "followup"])
def test_both_prompt_paths_carry_documents(builder):
    """A follow-up is where "so what does that mean for me?" gets asked, so the
    documents have to be present there too."""
    if builder == "explanation":
        messages = build_explanation_messages(
            "what does this say about TMEM38B", "gene_query", {},
            personal_documents=[PAPER])
    else:
        messages = build_followup_messages(
            "what does this say about TMEM38B", [], personal_documents=[PAPER])
    assert "Hypotonia and ataxia" in messages[-1]["content"]


def test_nothing_is_added_when_no_documents_were_uploaded():
    assert _format_documents(None) == ""
    assert _format_documents([]) == ""
    assert "reader uploaded" not in build_followup_messages("hello", [])[-1]["content"]


def test_documents_and_passages_are_capped_in_the_prompt():
    many = [{"title": f"Paper {i}", "passages": [f"passage {j}" for j in range(40)]}
            for i in range(30)]
    block = _format_documents(many)
    assert "Paper 10" not in block, "more than 10 documents reached the prompt"
    assert "passage 12" not in block, "more than 12 passages of one document reached the prompt"


def test_a_document_with_no_passages_does_not_break_the_prompt():
    block = _format_documents([{"title": "Empty", "passages": []}])
    assert "Empty" in block


def test_the_clinical_guard_is_present_alongside_documents():
    """The combination of someone's own genome and their own paper is exactly
    where overreach is easiest, so the no-diagnosis rules must not be something
    the document path can bypass."""
    from services.ai_explainer import SYSTEM_PROMPT
    assert "never diagnoses" in " ".join(SYSTEM_PROMPT.lower().split())
