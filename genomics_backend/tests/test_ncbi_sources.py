"""The NCBI databases added beyond ClinVar/gene/OMIM/PubMed.

The network calls are marked `external`; everything here that can be checked
without one — parsing, filtering, the registry wiring — is a plain unit test,
because a schema change upstream should fail loudly rather than quietly return
an empty panel.
"""
import asyncio

import httpx
import pytest

from services.genomics_api_real import (
    DICT_SECTIONS,
    OPTIONAL_SECTIONS,
    SECTION_SOURCE,
    SV_MIN_SPAN_BP,
    _parse_maf,
    fetch_dbsnp_annotations,
    fetch_gene_locus_grch37,
    fetch_genetic_tests,
    fetch_medgen_concepts,
    fetch_pmc_articles,
    fetch_structural_variants,
)

NEW_SECTIONS = ["structural_variants", "genetic_tests", "medgen", "full_text"]


# ── Registry wiring ──────────────────────────────────────────────────────────
# A section missing from any one of these three maps fails in a different and
# quieter way each time: no card offered, no attribution, or `[]` handed to a
# frontend expecting `{}`.


@pytest.mark.parametrize("section", NEW_SECTIONS)
def test_every_new_section_is_offered(section):
    assert section in OPTIONAL_SECTIONS


@pytest.mark.parametrize("section", NEW_SECTIONS)
def test_every_new_section_names_its_source(section):
    assert SECTION_SOURCE.get(section)


@pytest.mark.parametrize("section", NEW_SECTIONS)
def test_every_new_section_declares_its_shape(section):
    """All four return dicts. Declaring otherwise hands the UI the wrong empty."""
    assert section in DICT_SECTIONS


def test_every_offered_section_has_a_source():
    """Guards the whole registry, not just the ones added here."""
    missing = [k for k in OPTIONAL_SECTIONS if not SECTION_SOURCE.get(k)]
    assert missing == [], f"sections with no attribution: {missing}"


# ── Minor allele frequency parsing ───────────────────────────────────────────
# dbSNP reports frequency as a list of per-study strings like "A=0.161342/808".


def test_maf_prefers_1000genomes():
    entry = {"global_mafs": [
        {"study": "SomeOtherStudy", "freq": "A=0.9/10"},
        {"study": "1000Genomes", "freq": "A=0.161342/808"},
    ]}
    assert _parse_maf(entry) == pytest.approx(0.161342)


def test_maf_falls_back_to_the_first_study_available():
    entry = {"global_mafs": [{"study": "TOPMED", "freq": "T=0.25/1000"}]}
    assert _parse_maf(entry) == pytest.approx(0.25)


@pytest.mark.parametrize("entry", [
    {},
    {"global_mafs": []},
    {"global_mafs": [{"study": "1000Genomes", "freq": ""}]},
    {"global_mafs": [{"study": "1000Genomes", "freq": "malformed"}]},
    {"global_mafs": [{"study": "1000Genomes", "freq": "A=notanumber/8"}]},
])
def test_maf_returns_none_rather_than_guessing(entry):
    assert _parse_maf(entry) is None


# ── dbSNP annotation ─────────────────────────────────────────────────────────


def test_annotating_nothing_costs_no_call():
    """An empty or junk list must not reach the shared NCBI budget."""
    assert asyncio.run(fetch_dbsnp_annotations([])) == {}
    assert asyncio.run(fetch_dbsnp_annotations(["", "not-an-rsid", "rs"])) == {}


@pytest.mark.external
def test_dbsnp_resolves_a_real_rsid():
    got = asyncio.run(fetch_dbsnp_annotations(["rs4988235"]))
    entry = got["rs4988235"]
    assert "MCM6" in entry["genes"]
    assert entry["consequences"]
    assert 0 < entry["maf"] < 1
    assert entry["url"].endswith("rs4988235")


@pytest.mark.external
def test_dbsnp_omits_an_unknown_rsid_rather_than_returning_a_blank():
    """An unknown id comes back as a record carrying an error. Passing it
    through would tell a reader their variant exists and means nothing."""
    got = asyncio.run(fetch_dbsnp_annotations(["rs4988235", "rs999999999999"]))
    assert "rs4988235" in got
    assert "rs999999999999" not in got


@pytest.mark.external
def test_dbsnp_accepts_ids_with_or_without_the_rs_prefix():
    got = asyncio.run(fetch_dbsnp_annotations(["4988235"]))
    assert "rs4988235" in got, "keys are normalised to the rs form callers hold"


# ── Genome build ─────────────────────────────────────────────────────────────


@pytest.mark.external
def test_locus_is_grch37_not_grch38():
    """Consumer DNA files report GRCh37. BRCA1 sits ~1.85 Mb away on GRCh38, so
    intersecting uploaded positions against the wrong build selects a different
    stretch of chromosome 17 entirely."""
    locus = asyncio.run(fetch_gene_locus_grch37("BRCA1"))
    assert locus["assembly"] == "GRCh37"
    assert locus["chromosome"] == "17"
    # The GRCh37 coordinates, an order of magnitude further from the GRCh38 ones
    # (43,044,292) than any tolerance worth expressing.
    assert 41_190_000 < locus["start"] < 41_200_000


@pytest.mark.external
def test_a_nonexistent_gene_yields_no_locus():
    assert asyncio.run(fetch_gene_locus_grch37("NOTAREALGENE123")) is None


# ── dbVar, GTR, MedGen, PMC ──────────────────────────────────────────────────


@pytest.mark.external
def test_structural_variants_are_actually_structural():
    """dbVar's clinical filter admits single-base events. A 1 bp insertion under
    a heading promising deletions and duplications is simply wrong."""
    data = asyncio.run(fetch_structural_variants("BRCA1"))
    assert data["variants"], "BRCA1 has known pathogenic large rearrangements"
    for v in data["variants"]:
        vtype = (v["variant_type"] or "").lower()
        is_copy_number = "copy number" in vtype or "duplication" in vtype
        assert is_copy_number or v["span_bp"] >= SV_MIN_SPAN_BP


@pytest.mark.external
def test_structural_variants_report_the_kept_count_not_the_matched_count():
    data = asyncio.run(fetch_structural_variants("BRCA1"))
    assert data["total"] == len(data["variants"])
    assert data["matched"] >= data["total"]


@pytest.mark.external
def test_structural_variants_are_largest_first():
    spans = [v["span_bp"] or 0 for v in asyncio.run(fetch_structural_variants("BRCA1"))["variants"]]
    assert spans == sorted(spans, reverse=True)


@pytest.mark.external
def test_genetic_tests_report_the_real_total_not_the_page_size():
    data = asyncio.run(fetch_genetic_tests("BRCA1"))
    assert data["tests"]
    assert data["total"] >= len(data["tests"]), "'25 of 450' is the honest framing"
    assert all(t["name"] for t in data["tests"])


@pytest.mark.external
def test_medgen_returns_curated_concepts():
    data = asyncio.run(fetch_medgen_concepts("BRCA1"))
    assert data["concepts"]
    assert all(c["name"] for c in data["concepts"])


@pytest.mark.external
def test_pmc_returns_readable_articles():
    data = asyncio.run(fetch_pmc_articles("BRCA1"))
    assert data["articles"]
    assert all(a["url"].startswith("https://www.ncbi.nlm.nih.gov/pmc/") for a in data["articles"])


@pytest.mark.parametrize("fetch", [
    fetch_structural_variants, fetch_genetic_tests, fetch_medgen_concepts, fetch_pmc_articles,
])
@pytest.mark.external
def test_a_nonsense_gene_returns_empty_rather_than_raising(fetch):
    """The pipeline invariant: any source may have nothing, and the response
    must still be well-formed."""
    assert asyncio.run(fetch("NOTAREALGENE123")) == {}


# ── The annotate endpoint ────────────────────────────────────────────────────


def test_annotate_rejects_an_empty_request(base_url):
    r = httpx.post(f"{base_url}/dna/annotate", json={"rsids": []}, timeout=30)
    assert r.status_code == 400


def test_annotate_refuses_to_be_a_bulk_dbsnp_proxy(base_url):
    r = httpx.post(f"{base_url}/dna/annotate",
                   json={"rsids": [f"rs{i}" for i in range(500)]}, timeout=30)
    assert r.status_code == 400


@pytest.mark.external
def test_annotate_reports_what_it_could_not_resolve(base_url):
    r = httpx.post(f"{base_url}/dna/annotate",
                   json={"rsids": ["rs4988235", "rs999999999999"]}, timeout=60)
    assert r.status_code == 200
    body = r.json()
    assert body["requested"] == 2
    assert body["resolved"] == 1
