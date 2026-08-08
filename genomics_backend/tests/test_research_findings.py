"""Cross-source findings for Research mode.

Every one is computed rather than generated, so every one is testable without a
network. The assertions worth reading are the negative ones: an analysis that
fires on thin evidence is worse than no analysis, because a researcher acting on
a false flag loses time at the bench.
"""
from datetime import date

import pytest

from services.research import (
    curator_disagreement, constraint_tension, stale_evidence,
    unsupported_assertions, frequency_conflicts, research_findings,
    _prevalence_ceiling,
)


# ── curator disagreement ──────────────────────────────────────────────────────

def test_disputed_pairs_surface_widest_first():
    gencc = [
        {"disease": "Mild", "disputed": True, "spread": 1, "submitter_count": 2,
         "verdicts": [{"classification": "Strong"}, {"classification": "Moderate"}]},
        {"disease": "Wide", "disputed": True, "spread": 4, "submitter_count": 4,
         "verdicts": [{"classification": "Definitive"}, {"classification": "Limited"}]},
    ]
    out = curator_disagreement(gencc)
    assert [f["evidence"][0]["disease"] for f in out] == ["Wide", "Mild"]
    assert out[0]["severity"] == "high"      # spread >= 3
    assert out[1]["severity"] == "medium"


def test_agreed_pairs_are_not_findings():
    """The common case. Flagging consensus would bury the real disagreements."""
    assert curator_disagreement([{"disease": "Agreed", "disputed": False, "spread": 0}]) == []


# ── constraint tension ────────────────────────────────────────────────────────

def _variants(benign, pathogenic):
    return ([{"clinical_significance": "Benign"}] * benign
            + [{"clinical_significance": "Pathogenic"}] * pathogenic)


def test_constrained_gene_with_benign_leaning_variants_is_flagged():
    out = constraint_tension({"loeuf": 0.21, "observed_lof": 2, "expected_lof": 30},
                             _variants(8, 2))
    assert len(out) == 1
    assert out[0]["evidence"][0]["benign"] == 8


def test_a_tolerant_gene_is_not_flagged():
    """LOEUF above the threshold means loss of function is tolerated; benign
    calls are then the expected finding rather than a tension."""
    assert constraint_tension({"loeuf": 1.4}, _variants(8, 2)) == []


def test_a_pathogenic_leaning_set_is_not_flagged():
    assert constraint_tension({"loeuf": 0.2}, _variants(2, 8)) == []


def test_too_few_variants_to_say_anything():
    """Three benign calls is not a benign-leaning landscape, it is three calls."""
    assert constraint_tension({"loeuf": 0.2}, _variants(3, 0)) == []


def test_conflicting_interpretations_count_as_neither():
    """"Conflicting interpretations of pathogenicity" contains the word
    "pathogenic" and is not a pathogenic call. These rows are common."""
    rows = [{"clinical_significance": "Conflicting interpretations of pathogenicity"}] * 8
    assert constraint_tension({"loeuf": 0.2}, rows) == []


# ── stale evidence ────────────────────────────────────────────────────────────

def test_old_classifications_surface_oldest_first():
    out = stale_evidence(
        [{"disease": "Old", "classification": "Definitive", "classified_on": "2014-03-01"},
         {"disease": "Recent", "classification": "Definitive", "classified_on": "2024-01-01"},
         {"disease": "Middle", "classification": "Strong", "classified_on": "2018-06-01"}],
        today=date(2026, 8, 8))
    assert [f["evidence"][0]["disease"] for f in out] == ["Old", "Middle"]


def test_an_unparseable_date_is_skipped_rather_than_guessed():
    assert stale_evidence([{"disease": "X", "classified_on": "sometime in 2015"}],
                          today=date(2026, 8, 8)) == []


# ── unsupported assertions ────────────────────────────────────────────────────

def test_pathogenic_calls_without_criteria_are_flagged():
    out = unsupported_assertions([
        {"variant_id": "1", "clinical_significance": "Pathogenic",
         "review_status": "no assertion criteria provided"},
        {"variant_id": "2", "clinical_significance": "Pathogenic",
         "review_status": "reviewed by expert panel"},
    ])
    assert len(out) == 1
    assert [e["variant_id"] for e in out[0]["evidence"]] == ["1"]


def test_a_weakly_reviewed_benign_call_is_not_flagged():
    """The finding is about pathogenic calls a researcher might chase."""
    assert unsupported_assertions([
        {"clinical_significance": "Benign", "review_status": "no assertion criteria provided"},
    ]) == []


# ── frequency conflicts ───────────────────────────────────────────────────────

def test_prevalence_ceiling_takes_the_generous_upper_bound():
    # "1-9 / 100 000" → 9/100000, the disease's own best case.
    assert _prevalence_ceiling([{"band": "1-9 / 100 000"}]) == pytest.approx(9e-5)
    assert _prevalence_ceiling([{"band": "1 / 1 000 000"}]) == pytest.approx(1e-6)
    assert _prevalence_ceiling([{"band": "Unknown"}]) is None
    assert _prevalence_ceiling([]) is None


def test_a_pathogenic_call_commoner_than_the_disease_is_flagged():
    out = frequency_conflicts(
        [{"variant_id": "v1", "clinical_significance": "Pathogenic", "frequency": 0.012}],
        [{"band": "1-9 / 100 000"}])
    assert len(out) == 1
    assert out[0]["evidence"][0]["excess_fold"] > 100


def test_a_rare_pathogenic_call_is_not_flagged():
    assert frequency_conflicts(
        [{"clinical_significance": "Pathogenic", "frequency": 1e-6}],
        [{"band": "1-9 / 100 000"}]) == []


def test_no_frequency_means_no_finding_rather_than_a_guess():
    """ClinVar summaries do not always carry a frequency. Silence here means
    "not checkable", and must never be presented as a clean bill."""
    assert frequency_conflicts(
        [{"clinical_significance": "Pathogenic"}], [{"band": "1-9 / 100 000"}]) == []


# ── orchestration ─────────────────────────────────────────────────────────────

def test_skipped_is_distinct_from_found_nothing():
    """The distinction the upstream-drift audit exists to preserve: an empty
    result and a query that could not run are not the same thing."""
    out = research_findings({"gene_symbol": "BRCA1", "variants": []})
    assert out["findings"] == []
    assert "curator_disagreement" in out["skipped"]
    assert "curator_disagreement" not in out["checked"]


def test_an_analysis_that_ran_and_found_nothing_is_checked_not_skipped():
    out = research_findings({"gencc": [{"disease": "Agreed", "disputed": False, "spread": 0}]})
    assert "curator_disagreement" in out["checked"]
    assert out["findings"] == []


def test_findings_are_ranked_by_severity():
    out = research_findings({
        "gencc": [{"disease": "D", "disputed": True, "spread": 4, "submitter_count": 3,
                   "verdicts": [{"classification": "Definitive"}, {"classification": "Limited"}]}],
        "clingen": [{"disease": "D", "classification": "Definitive", "classified_on": "2013-01-01"}],
    }, today=date(2026, 8, 8))
    severities = [f["severity"] for f in out["findings"]]
    assert severities == sorted(severities, key=lambda s: {"high": 0, "medium": 1, "low": 2}[s])


def test_it_is_safe_on_nothing():
    for junk in (None, {}, {"variants": None}, {"gencc": "not a list"}):
        out = research_findings(junk)
        assert out["findings"] == []


def test_every_finding_names_the_sources_behind_it():
    """Traceability is the product's whole argument; a research finding with no
    provenance is exactly the speculation this module exists to avoid."""
    out = research_findings({
        "gencc": [{"disease": "D", "disputed": True, "spread": 3, "submitter_count": 2,
                   "verdicts": [{"classification": "Strong"}, {"classification": "Limited"}]}],
        "constraint": {"loeuf": 0.2},
        "variants": _variants(8, 1),
    })
    assert out["findings"]
    for f in out["findings"]:
        assert f["sources"], f["kind"]
        assert f["evidence"], f["kind"]


def test_disagreement_carries_who_said_what():
    """"Curators disagree" is a headline; the verdicts are the research lead.

    The two ends of a disagreement usually read different papers, and naming
    them is what lets someone go and find out which. This was fetched from
    GenCC and discarded before being shown.
    """
    out = curator_disagreement([{
        "disease": "Caffey disease", "disputed": True, "spread": 3, "submitter_count": 2,
        "pmids": ["1", "2"],
        "verdicts": [
            {"submitter": "Invitae", "classification": "Definitive", "date": "2019-04-01", "pmids": ["111"]},
            {"submitter": "PanelApp", "classification": "Limited", "date": "2023-09-01", "pmids": ["222"]},
        ],
    }])
    ev = out[0]["evidence"][0]
    assert [v["submitter"] for v in ev["verdicts"]] == ["Invitae", "PanelApp"]
    assert ev["verdicts"][0]["date"] == "2019-04-01"
    assert ev["verdicts"][1]["pmids"] == ["222"]


def test_a_verdict_list_that_is_junk_does_not_break_the_finding():
    out = curator_disagreement([{
        "disease": "D", "disputed": True, "spread": 2,
        "verdicts": [None, "not a dict", {"submitter": "Real", "classification": "Strong"}],
    }])
    assert [v["submitter"] for v in out[0]["evidence"][0]["verdicts"]] == ["Real"]
