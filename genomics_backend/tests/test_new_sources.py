"""The sources added after the original nineteen.

Two of them are core (MedlinePlus, gnomAD constraint) because their job is to
be in the prompt, not only on the page; two are optional sections
(ClinicalTrials.gov, PanelApp) because they are heavier and not every reader
wants them.

The registry checks run in CI. The contract checks are `external` and assert
answers that are not in reasonable doubt — the lesson from the upstream-drift
audit is that a test asserting "returned a list" passes forever while the data
quietly goes away.
"""
import pytest

from services.genomics_api_real import (
    DICT_SECTIONS,
    OPTIONAL_SECTIONS,
    SECTION_SOURCE,
    fetch_clinical_trials,
    fetch_gene_panels,
    fetch_gnomad_constraint,
    fetch_medlineplus_summary,
)

NEW_SECTIONS = {"clinical_trials", "panels"}


# ── registration ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("section", sorted(NEW_SECTIONS))
def test_the_section_is_offered_and_attributed(section):
    """Half the registries and the section exists but cannot be reached, or is
    reached and shown with no source. Each omission fails quietly and
    differently — see the five-places note in CLAUDE.md."""
    assert section in OPTIONAL_SECTIONS
    assert section in SECTION_SOURCE


@pytest.mark.parametrize("section", sorted(NEW_SECTIONS))
def test_list_sections_are_not_registered_as_dicts(section):
    """DICT_SECTIONS decides whether an empty result is {} or []. Both of these
    return lists, and getting it wrong makes an empty result render as an
    object the panel cannot iterate."""
    assert section not in DICT_SECTIONS


def test_the_dispatch_map_can_reach_them():
    import inspect

    from services import genomics_api_real as g
    src = inspect.getsource(g.fetch_gene_section)
    for section in NEW_SECTIONS:
        assert f'"{section}"' in src, f"{section} is offered but has no fetcher wired"


# ── contracts, against the live sources ──────────────────────────────────────

@pytest.mark.external
def test_medlineplus_returns_plain_language():
    """BRCA1's MedlinePlus entry opens with "provides instructions for making".
    That phrasing is the reason this source is here at all — it is the register
    nothing else in the pipeline writes in."""
    import asyncio
    data = asyncio.run(fetch_medlineplus_summary("BRCA1"))
    assert data.get("summary"), "MedlinePlus returned nothing for BRCA1"
    assert "provides instructions" in data["summary"].lower()
    assert data["url"].startswith("https://medlineplus.gov")


@pytest.mark.external
def test_medlineplus_absence_is_not_an_error():
    """Coverage is partial and hand-written, so a gene with no page is normal.
    It must return {} rather than raising or inventing a summary."""
    import asyncio
    assert asyncio.run(fetch_medlineplus_summary("NOTAREALGENE123")) == {}


@pytest.mark.external
def test_constraint_separates_essential_genes_from_tolerant_ones():
    """SCN1A is among the most constrained genes in the genome — haploinsufficiency
    causes Dravet syndrome — so its LOEUF must sit in the intolerant range. A
    test asserting only "a number came back" would not notice the scale
    inverting."""
    import asyncio
    scn1a = asyncio.run(fetch_gnomad_constraint("SCN1A"))
    assert scn1a["loeuf"] < 0.35
    assert scn1a["tolerance"] == "highly intolerant"


@pytest.mark.external
def test_trials_put_recruiting_studies_first():
    """The ordering is the feature: a completed 2011 trial and one recruiting
    this month are not the same information."""
    import asyncio
    trials = asyncio.run(fetch_clinical_trials("BRCA1"))
    assert trials, "ClinicalTrials.gov returned nothing for BRCA1"
    assert all(t["nct_id"].startswith("NCT") for t in trials)
    recruiting = [i for i, t in enumerate(trials) if t["recruiting"]]
    closed = [i for i, t in enumerate(trials) if not t["recruiting"]]
    if recruiting and closed:
        assert max(recruiting) < min(closed), "recruiting trials must sort above closed ones"


@pytest.mark.external
def test_panels_report_clinical_use_not_just_association():
    """BRCA1 is on diagnostic-grade NHS panels. If nothing comes back green,
    either PanelApp moved or the confidence mapping inverted."""
    import asyncio
    panels = asyncio.run(fetch_gene_panels("BRCA1"))
    assert panels, "PanelApp returned nothing for BRCA1"
    assert any(p["diagnostic"] for p in panels)
    assert panels[0]["diagnostic"], "diagnostic-grade panels must sort first"


# ── Ensembl VEP ──────────────────────────────────────────────────────────────

@pytest.mark.external
def test_vep_predicts_a_known_damaging_variant():
    """rs6025 is Factor V Leiden — a missense change in F5 that SIFT and
    PolyPhen both call damaging. If this comes back tolerated, either the
    transcript selection broke or the fields moved."""
    import asyncio
    from services.genomics_api_real import fetch_vep_predictions
    got = asyncio.run(fetch_vep_predictions(["rs6025"]))["rs6025"]
    assert got["gene"] == "F5"
    assert "missense" in got["consequence"]
    assert got["sift"] == "deleterious"


@pytest.mark.external
def test_vep_keeps_the_score_next_to_the_label():
    """A 'deleterious' at 0.04 and one at 0.00 are not the same claim, and the
    panel shows both — so the score has to survive the mapping."""
    import asyncio
    from services.genomics_api_real import fetch_vep_predictions
    got = asyncio.run(fetch_vep_predictions(["rs6025"]))["rs6025"]
    assert got["sift_score"] is not None


@pytest.mark.external
def test_vep_ignores_input_that_is_not_an_rsid():
    """Callers pass whatever the reader's file contained. Anything that is not
    an rsID must be dropped before the request rather than sent."""
    import asyncio
    from services.genomics_api_real import fetch_vep_predictions
    assert asyncio.run(fetch_vep_predictions(["not-an-rsid", "", "chr1:12345"])) == {}
