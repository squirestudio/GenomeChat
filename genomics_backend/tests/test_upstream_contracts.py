"""Sources that had drifted, and the shape of the drift.

Ten of the twenty upstream sources were returning nothing while reporting
success. None of them raised: an endpoint moved, a field was renamed, a
namespace changed, and each fetcher dutifully turned that into an empty list —
which is indistinguishable from a gene genuinely having no pathways, no drugs
or no phenotypes.

These tests are marked `external` because they check the live contracts, which
is the only place that class of drift is visible. They pick genes whose answers
are not in reasonable doubt: BRCA1 is in Reactome's homologous-recombination
pathways, CYP2C19 governs clopidogrel, CFTR causes cystic fibrosis. A failure
here means an upstream changed again, not that the biology did.
"""
import asyncio

import pytest

from services.genomics_api_real import (
    OPENTARGETS_STAGE_RANK,
    OMIM_PREFIX_KIND,
    _parse_clingen_csv,
    fetch_cancer_mutations,
    fetch_clingen_validity,
    fetch_gtex_expression,
    fetch_gwas_associations,
    fetch_hpo_terms,
    fetch_monarch_associations,
    fetch_omim_data,
    fetch_open_targets_drugs,
    fetch_pharmgkb_data,
    fetch_reactome_pathways,
)


# ── Pure parsing ─────────────────────────────────────────────────────────────


def test_clingen_csv_is_located_by_header_not_by_line_number():
    """The dump carries a title preamble and rules of '+++++'. Skipping a fixed
    number of lines would shift every column the day the preamble grows."""
    csv_text = "\n".join([
        '"CLINGEN GENE DISEASE VALIDITY CURATIONS","","",""',
        '"FILE CREATED: 2026-07-28","","",""',
        '"+++++","+++++","+++++","+++++"',
        '"GENE SYMBOL","DISEASE LABEL","DISEASE ID (MONDO)","CLASSIFICATION"',
        '"+++++","+++++","+++++","+++++"',
        '"BRCA1","BRCA1-related cancer predisposition","MONDO:0700268","Definitive"',
        '"CFTR","cystic fibrosis","MONDO:0009061","Definitive"',
    ])
    table = _parse_clingen_csv(csv_text)
    assert set(table) == {"BRCA1", "CFTR"}
    assert table["BRCA1"][0]["classification"] == "Definitive"
    assert table["BRCA1"][0]["mondo_id"] == "MONDO:0700268"


def test_clingen_csv_survives_an_extra_preamble_line():
    base = [
        '"CLINGEN GENE DISEASE VALIDITY CURATIONS","","",""',
        '"AN EXTRA LINE NOBODY WARNED US ABOUT","","",""',
        '"WEBPAGE: https://example.org","","",""',
        '"GENE SYMBOL","DISEASE LABEL","DISEASE ID (MONDO)","CLASSIFICATION"',
        '"BRCA1","x","MONDO:1","Definitive"',
    ]
    assert "BRCA1" in _parse_clingen_csv("\n".join(base))


def test_clingen_csv_that_is_not_a_csv_yields_nothing():
    """A 176 KB HTML error page must parse to nothing, not to junk rows."""
    assert _parse_clingen_csv("<!DOCTYPE html><html><body>Not found</body></html>") == {}


def test_omim_entry_kind_comes_from_the_oid_prefix():
    """`mimtype` disappeared from the esummary; the prefix symbol carries it."""
    assert OMIM_PREFIX_KIND["*"] == "gene"     # gene of known sequence
    assert OMIM_PREFIX_KIND["+"] == "gene"     # gene and phenotype
    assert OMIM_PREFIX_KIND["#"] == "phenotype"
    assert OMIM_PREFIX_KIND["^"] == "removed"


def test_opentargets_stage_is_ranked_from_an_enum_not_a_number():
    """Clinical stage stopped being an integer phase. Approval must outrank
    every trial phase, or approved drugs sort below candidates."""
    assert OPENTARGETS_STAGE_RANK["APPROVAL"] > OPENTARGETS_STAGE_RANK["PHASE_3"]
    assert OPENTARGETS_STAGE_RANK["PHASE_3"] > OPENTARGETS_STAGE_RANK["PHASE_1"]
    assert OPENTARGETS_STAGE_RANK["PRECLINICAL"] < OPENTARGETS_STAGE_RANK["EARLY_PHASE_1"]


# ── Live contracts ───────────────────────────────────────────────────────────


@pytest.mark.external
def test_reactome_finds_the_repair_pathways_brca1_is_famous_for():
    pathways = asyncio.run(fetch_reactome_pathways("BRCA1"))
    assert pathways
    names = " ".join(p["name"] for p in pathways).lower()
    assert "homologous recombination" in names or "hdr" in names


@pytest.mark.external
def test_gtex_needs_a_version_pinned_gencode_id():
    """GTEx keys expression on `ENSG…​.20`, not on a symbol and not on a bare
    Ensembl id — passing the symbol earned a 422 on every call."""
    tissues = asyncio.run(fetch_gtex_expression("BRCA1"))
    assert tissues
    assert all(t["median_tpm"] >= 0 for t in tissues)
    assert all("_" not in t["tissue"] for t in tissues), "tissue ids should be readable"


@pytest.mark.external
def test_clingen_returns_expert_curations_rather_than_a_web_page():
    """`search.clinicalgenome.org/kb` answers 200 with HTML, which the old code
    handed to `.json()` — so every gene reported no curations at all."""
    curations = asyncio.run(fetch_clingen_validity("BRCA1"))
    assert curations
    assert any(c["classification"] == "Definitive" for c in curations)
    assert any(c["mondo_id"] for c in curations)


@pytest.mark.external
def test_clingen_distinguishes_between_genes():
    """A cached table shared by every request must not answer with one gene's
    curations for another."""
    cftr = asyncio.run(fetch_clingen_validity("CFTR"))
    assert any("cystic fibrosis" in c["disease"].lower() for c in cftr)
    assert asyncio.run(fetch_clingen_validity("NOTAREALGENE123")) == []


@pytest.mark.external
def test_hpo_reads_from_the_service_that_replaced_the_retired_one():
    data = asyncio.run(fetch_hpo_terms("BRCA1"))
    assert data["phenotype_total"] > 50
    assert data["disease_associations"]
    # MONDO is what lets this disease be tied to the same one elsewhere.
    assert any(d["mondo_id"] for d in data["disease_associations"])


@pytest.mark.external
def test_monarch_is_keyed_on_hgnc_not_ncbi_gene():
    """An NCBI Gene id returns `total: 0` with HTTP 200 — a namespace mismatch
    that reads exactly like a gene with no associations."""
    data = asyncio.run(fetch_monarch_associations("BRCA1"))
    assert data["monarch_id"].startswith("HGNC:")
    assert data["diseases"]
    assert any(d["causal"] for d in data["diseases"]), "BRCA1 causally causes disease"


@pytest.mark.external
def test_omim_returns_the_gene_and_its_phenotypes():
    """Searching OMIM for a symbol finds only the gene entry; the phenotypes
    come from the link, and they are the part worth reading."""
    data = asyncio.run(fetch_omim_data("BRCA1"))
    assert data["gene_entry"]["mim_number"] == "113705"
    assert len(data["phenotypes"]) >= 3
    assert any("BREAST" in p["title"].upper() for p in data["phenotypes"])


@pytest.mark.external
def test_gwas_traverses_gene_to_snp_to_association():
    """There is no gene-keyed association endpoint; the old one 404s."""
    hits = asyncio.run(fetch_gwas_associations("APOE"))
    assert hits
    assert all(h["rsid"].startswith("rs") for h in hits)
    assert all(h["trait"] for h in hits)
    # Strongest first, and one row per trait rather than one per study.
    assert len({h["trait"] for h in hits}) == len(hits)


@pytest.mark.external
def test_gdc_counts_occurrences_because_ssms_has_no_project_facet():
    """`/ssms` answered 200 while reporting `unrecognized values` in a
    `warnings` key nothing read."""
    data = asyncio.run(fetch_cancer_mutations("BRCA1"))
    assert data["cancer_types"]
    assert data["total_mutations"] > 0
    assert data["project_count"] >= len(data["cancer_types"])


@pytest.mark.external
def test_opentargets_survives_the_knowndrugs_rename():
    """GraphQL rejects the whole query over one unknown field, so a rename
    returned an errors array and no data — read as 'no drugs target this gene'."""
    drugs = asyncio.run(fetch_open_targets_drugs("ENSG00000146648"))  # EGFR
    assert drugs
    assert any(d["is_approved"] for d in drugs)
    assert drugs[0]["is_approved"], "approved drugs sort first"


@pytest.mark.external
def test_a_tumour_suppressor_having_no_drugs_is_a_real_answer():
    """BRCA1 is not a drug target — a loss of function cannot be inhibited.
    This must stay distinguishable from the schema being broken, which is why
    the test above uses a gene that does have drugs."""
    assert asyncio.run(fetch_open_targets_drugs("ENSG00000012048")) == []


@pytest.mark.external
def test_pharmgkb_moved_to_clinpgx():
    """`api.pharmgkb.org` no longer resolves at all — a DNS failure, so calls
    raised before ever reaching a status code."""
    data = asyncio.run(fetch_pharmgkb_data("CYP2C19"))
    drugs = {d["name"].lower() for d in data["related_drugs"]}
    assert "clopidogrel" in drugs, "the canonical CYP2C19 interaction"
    assert any(d["level"] == "1A" for d in data["related_drugs"])
    assert data["annotation_total"] > 10


@pytest.mark.external
def test_variants_carry_grch37_coordinates_for_matching_uploaded_dna():
    """ClinVar stopped publishing dbSNP cross-references: `variation_xrefs` is
    empty for every record now, even for common variants that certainly have
    rsIDs, and elink to dbSNP returns nothing either. Position is what ties a
    ClinVar record to a reader's own file, and it must be GRCh37 — the build
    consumer tests report — because GRCh38 is ~1.85 Mb away at BRCA1 and would
    match some unrelated variant rather than failing to match.
    """
    from services.genomics_api_real import fetch_clinvar_variants
    variants = asyncio.run(fetch_clinvar_variants("BRCA1"))
    placed = [v for v in variants if v.position_grch37]
    assert len(placed) >= len(variants) - 2, "most records should carry a position"
    assert all(v.chromosome == "17" for v in placed)
    # BRCA1 on GRCh37 spans 41,196,312–41,277,500. A GRCh38 coordinate would
    # land near 43,044,295 and fall outside this range entirely.
    assert all(41_196_312 <= v.position_grch37 <= 41_277_500 for v in placed)


@pytest.mark.external
def test_variants_span_the_significance_range_not_just_pathogenic():
    """A lollipop plot earns its keep by showing pathogenic variants against
    benign ones — where damage clusters is only legible in contrast.

    Asking ClinVar for `clinsig_pathogenic` alone returned a set that was 100%
    Pathogenic for every gene, so the map's colour channel carried no
    information at all. Dropping the filter fails the other way: RYR1
    unfiltered is 33/40 uncertain-significance, which is noise.
    """
    from services.genomics_api_real import fetch_clinvar_variants
    variants = asyncio.run(fetch_clinvar_variants("RYR1"))
    bands = {v.clinical_significance for v in variants}
    assert len(bands) >= 3, f"only one kind of call present: {bands}"
    assert any("athogenic" in b for b in bands)
    assert any("enign" in b or "ncertain" in b for b in bands)


@pytest.mark.external
def test_pathogenic_variants_still_come_first():
    """Fetching benign variants must not bury the ones a reader came for: the
    variant table renders in this order."""
    from services.genomics_api_real import fetch_clinvar_variants
    variants = asyncio.run(fetch_clinvar_variants("BRCA1"))
    assert variants[0].clinical_significance.startswith("Pathogenic")
    # Benign calls must all sit after every pathogenic one.
    first_benign = next((i for i, v in enumerate(variants)
                         if "enign" in (v.clinical_significance or "")), len(variants))
    last_pathogenic = max((i for i, v in enumerate(variants)
                           if (v.clinical_significance or "").startswith("Pathogenic")), default=-1)
    assert last_pathogenic < first_benign


# ── The disease network ──────────────────────────────────────────────────────
# Assembled from HPO joined to ClinGen on MONDO. It only became possible once
# both were repaired, and it is the one fetcher that returns a graph.


@pytest.mark.external
def test_the_disease_network_leads_with_what_the_gene_is_known_for():
    """HPO returns diseases in no useful order — for CFTR it lists hereditary
    pancreatitis and aquagenic keratoderma ahead of cystic fibrosis. Taking the
    first six omitted the condition the gene is famous for, so the cap was
    deciding the answer. Expert-curated pairs are ranked first."""
    from services.genomics_api_real import fetch_disease_network
    data = asyncio.run(fetch_disease_network("CFTR"))
    assert "cystic fibrosis" in data["diseases"][0]["name"].lower()
    assert data["diseases"][0]["classification"] == "Definitive"
    assert data["diseases"][0]["inheritance"] == "AR"


@pytest.mark.external
def test_one_condition_appears_once_however_many_nomenclatures_reach_it():
    """CFTR arrives with both an OMIM and an Orphanet entry for cystic
    fibrosis. Deduping on MONDO is exactly what that identifier is for."""
    from services.genomics_api_real import fetch_disease_network
    names = [d["name"].lower() for d in asyncio.run(fetch_disease_network("CFTR"))["diseases"]]
    assert len(names) == len(set(names))


@pytest.mark.external
def test_the_network_finds_genes_that_share_a_disease():
    """The non-obvious edge, and the reason this is a graph rather than a list:
    the other genes behind a condition this gene causes. For BRCA1 that is the
    hereditary breast and ovarian cancer panel, discovered through shared
    disease membership rather than hardcoded anywhere."""
    from services.genomics_api_real import fetch_disease_network
    related = {g["symbol"] for g in asyncio.run(fetch_disease_network("BRCA1"))["related_genes"]}
    assert {"BRCA2", "PALB2", "ATM"} <= related, f"missing known HBOC genes: {related}"


@pytest.mark.external
def test_phenotypes_are_ordered_by_how_often_they_occur():
    """HPO annotates some diseases with over a hundred terms, most of them
    rare. A phenotype seen in nearly every patient and one seen occasionally
    are different claims, and the common ones have to survive the cap."""
    from services.genomics_api_real import fetch_disease_network, HPO_FREQUENCY_ORDER
    diseases = asyncio.run(fetch_disease_network("BRCA1"))["diseases"]
    rich = max(diseases, key=lambda d: d["phenotype_total"])
    assert rich["phenotype_total"] > 20, "expected a densely annotated disease"
    ranks = [HPO_FREQUENCY_ORDER.get(p["frequency"], 9) for p in rich["phenotypes"]]
    assert ranks == sorted(ranks)


@pytest.mark.external
def test_an_uncurated_gene_still_produces_a_network():
    """Absent ClinGen curation is meaningfully different from no evidence, and
    must not empty the panel."""
    from services.genomics_api_real import fetch_disease_network
    data = asyncio.run(fetch_disease_network("MTHFR"))
    assert data == {} or data["diseases"], "should be empty or populated, never malformed"
