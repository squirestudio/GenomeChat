import httpx
import asyncio
import logging
from typing import Optional
from models import VariantResult, GeneResult

logger = logging.getLogger(__name__)

ENSEMBL_BASE = "https://rest.ensembl.org"
CLINVAR_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
GNOMAD_BASE = "https://gnomad.broadinstitute.org/api"
UNIPROT_BASE = "https://rest.uniprot.org/uniprotkb"
NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
REACTOME_BASE = "https://reactome.org/ContentService"
GTEX_BASE = "https://gtexportal.org/api/v2"
STRING_BASE = "https://string-db.org/api"
OPENTARGETS_BASE = "https://api.platform.opentargets.org/api/v4/graphql"

HEADERS = {"Content-Type": "application/json", "Accept": "application/json"}
TIMEOUT = 30
MAX_RETRIES = 3


async def _get(client: httpx.AsyncClient, url: str, params: dict = None) -> dict | list | None:
    for attempt in range(MAX_RETRIES):
        try:
            response = await client.get(url, params=params, timeout=TIMEOUT, headers=HEADERS)
            if response.status_code == 200:
                return response.json()
            elif response.status_code == 429:
                await asyncio.sleep(2 ** attempt)
            elif response.status_code == 404:
                return None
            else:
                logger.warning(f"HTTP {response.status_code} for {url}")
                return None
        except httpx.TimeoutException:
            logger.warning(f"Timeout on attempt {attempt + 1} for {url}")
            await asyncio.sleep(1)
        except Exception as e:
            logger.error(f"Request error for {url}: {e}")
            return None
    return None


async def lookup_gene_ensembl(gene_symbol: str) -> Optional[dict]:
    async with httpx.AsyncClient() as client:
        url = f"{ENSEMBL_BASE}/lookup/symbol/homo_sapiens/{gene_symbol}"
        data = await _get(client, url, {"expand": 1})
        if data:
            return {
                "id": data.get("id"),
                "symbol": data.get("display_name"),
                "chromosome": data.get("seq_region_name"),
                "start": data.get("start"),
                "end": data.get("end"),
                "strand": data.get("strand"),
                "description": data.get("description", "").split(" [")[0],
                "biotype": data.get("biotype"),
            }
    return None


async def fetch_clinvar_variants(gene_symbol: str, max_results: int = 50) -> list[VariantResult]:
    variants = []
    async with httpx.AsyncClient() as client:
        search_url = f"{CLINVAR_BASE}/esearch.fcgi"
        search_params = {
            "db": "clinvar",
            "term": f"{gene_symbol}[gene] AND clinsig_pathogenic[Properties]",
            "retmax": max_results,
            "retmode": "json",
        }
        search_data = await _get(client, search_url, search_params)
        if not search_data:
            return variants

        ids = search_data.get("esearchresult", {}).get("idlist", [])
        if not ids:
            search_params["term"] = f"{gene_symbol}[gene]"
            search_data = await _get(client, search_url, search_params)
            ids = search_data.get("esearchresult", {}).get("idlist", []) if search_data else []

        if not ids:
            return variants

        fetch_url = f"{CLINVAR_BASE}/esummary.fcgi"
        fetch_params = {
            "db": "clinvar",
            "id": ",".join(ids[:20]),
            "retmode": "json",
        }
        fetch_data = await _get(client, fetch_url, fetch_params)
        if not fetch_data:
            return variants

        result = fetch_data.get("result", {})
        uids = result.get("uids", [])

        for uid in uids:
            item = result.get(uid, {})
            if not item:
                continue

            # ClinVar API returns significance in multiple possible locations
            clinsig = item.get("clinical_significance", {})
            if isinstance(clinsig, dict):
                significance = clinsig.get("description") or clinsig.get("review_status") or "Unknown"
            elif isinstance(clinsig, str) and clinsig:
                significance = clinsig
            else:
                # Try germline_classification (newer ClinVar API format)
                germline = item.get("germline_classification", {})
                if isinstance(germline, dict):
                    significance = germline.get("description") or "Unknown"
                else:
                    significance = str(germline) if germline else "Unknown"

            title = item.get("title", "")
            condition = item.get("trait_set", [{}])
            if isinstance(condition, list) and condition:
                condition_name = condition[0].get("trait_name") or condition[0].get("trait_xref", [{}])[0].get("db_name", "Unknown") if condition[0].get("trait_xref") else "Unknown"
            else:
                condition_name = item.get("condition_set", {}).get("trait_set", [{}])[0].get("trait_name", "Unknown") if isinstance(item.get("condition_set"), dict) else "Unknown"

            variants.append(VariantResult(
                variant_id=f"VCV{uid}",
                gene=gene_symbol,
                clinical_significance=significance,
                condition=condition_name,
                consequence=title.split(" ")[0] if title else None,
                source="ClinVar"
            ))

    return variants


async def fetch_gnomad_frequencies(gene_symbol: str, population: Optional[str] = None) -> list[dict]:
    query = """
    query GeneVariants($geneSymbol: String!, $datasetId: DatasetId!) {
      gene(gene_symbol: $geneSymbol, reference_genome: GRCh38) {
        variants(dataset: $datasetId) {
          variant_id
          consequence
          exome {
            ac
            an
            af
            populations {
              id
              ac
              an
              af
            }
          }
          genome {
            ac
            an
            af
          }
        }
      }
    }
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                GNOMAD_BASE,
                json={"query": query, "variables": {"geneSymbol": gene_symbol, "datasetId": "gnomad_r4"}},
                timeout=TIMEOUT,
            )
            if response.status_code != 200:
                return []
            data = response.json()
            variants_raw = data.get("data", {}).get("gene", {}).get("variants", []) or []

            results = []
            for v in variants_raw[:30]:
                exome = v.get("exome") or {}
                genome = v.get("genome") or {}
                af = exome.get("af") or genome.get("af")

                pop_filter = None
                if population and exome.get("populations"):
                    pop_map = {"european": "nfe", "african": "afr", "east asian": "eas", "south asian": "sas"}
                    pop_key = pop_map.get(population.lower())
                    if pop_key:
                        for pop in exome["populations"]:
                            if pop["id"] == pop_key:
                                pop_filter = pop.get("af")

                results.append({
                    "variant_id": v.get("variant_id"),
                    "consequence": v.get("consequence"),
                    "allele_frequency": af,
                    "population_frequency": pop_filter,
                    "population": population,
                    "source": "gnomAD"
                })
            return results
    except Exception as e:
        logger.warning(f"gnomAD query failed for {gene_symbol}: {e}")
        return []


async def fetch_alphafold_structure(uniprot_accession: str) -> Optional[dict]:
    if not uniprot_accession:
        return None
    async with httpx.AsyncClient() as client:
        url = f"https://alphafold.ebi.ac.uk/api/prediction/{uniprot_accession}"
        data = await _get(client, url, {})
        if not data or not isinstance(data, list) or not data[0]:
            return None
        entry = data[0]
        return {
            "pdb_url": entry.get("pdbUrl"),
            "entry_id": entry.get("entryId"),
            "gene": entry.get("gene"),
            "uniprot_accession": uniprot_accession,
            "source": "AlphaFold"
        }


async def fetch_uniprot_info(gene_symbol: str) -> Optional[dict]:
    async with httpx.AsyncClient() as client:
        params = {
            "query": f"gene:{gene_symbol} AND organism_id:9606 AND reviewed:true",
            "fields": "gene_names,protein_name,cc_function,length,mass",
            "format": "json",
            "size": 1,
        }
        data = await _get(client, UNIPROT_BASE + "/search", params)
        if not data or not data.get("results"):
            return None
        entry = data["results"][0]
        protein_name = entry.get("proteinDescription", {}).get("recommendedName", {})
        full_name = protein_name.get("fullName", {}).get("value", "Unknown")
        function_comments = [
            c.get("texts", [{}])[0].get("value", "")
            for c in entry.get("comments", [])
            if c.get("commentType") == "FUNCTION"
        ]
        return {
            "protein_name": full_name,
            "function": function_comments[0][:300] if function_comments else None,
            "length": entry.get("sequence", {}).get("length"),
            "accession": entry.get("primaryAccession"),
            "source": "UniProt"
        }


async def fetch_pubmed_count(gene_symbol: str) -> int:
    async with httpx.AsyncClient() as client:
        params = {
            "db": "pubmed",
            "term": f"{gene_symbol}[TIAB] AND genomics[MeSH]",
            "retmode": "json",
            "rettype": "count",
        }
        data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", params)
        if data:
            return int(data.get("esearchresult", {}).get("count", 0))
    return 0


def _normalize_disease_name(name: str) -> str:
    """Normalize disease name for NCBI search (remove apostrophes, trailing 's)."""
    return name.replace("'s", "").replace("'s", "").strip()


async def _fetch_genes_from_clinvar(disease_name: str, client: httpx.AsyncClient) -> list[str]:
    """Search ClinVar by disease name and extract unique gene symbols."""
    gene_symbols = []
    norm = _normalize_disease_name(disease_name)

    for term in [
        f'"{disease_name}"[dis] AND "pathogenic"[clinsig] AND "homo sapiens"[orgn]',
        f'"{norm}"[dis] AND "homo sapiens"[orgn]',
        f'{norm}[dis] AND "homo sapiens"[orgn]',
    ]:
        search_params = {
            "db": "clinvar",
            "term": term,
            "retmax": 100,
            "retmode": "json",
        }
        search_data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", search_params)
        ids = (search_data or {}).get("esearchresult", {}).get("idlist", [])
        if ids:
            break

    if not ids:
        return gene_symbols

    fetch_params = {
        "db": "clinvar",
        "id": ",".join(ids[:40]),
        "retmode": "json",
    }
    fetch_data = await _get(client, f"{NCBI_BASE}/esummary.fcgi", fetch_params)
    if not fetch_data:
        return gene_symbols

    result = fetch_data.get("result", {})
    seen = set()
    for uid in result.get("uids", []):
        item = result.get(uid, {})
        genes = item.get("genes", [])
        for g in genes:
            sym = g.get("symbol", "")
            if sym and sym not in seen and len(sym) <= 12:
                seen.add(sym)
                gene_symbols.append(sym)

    return gene_symbols


async def _fetch_gene_details(gene_symbols: list[str], disease_name: str, client: httpx.AsyncClient) -> list[GeneResult]:
    """Given a list of gene symbols, fetch NCBI Gene details for each."""
    if not gene_symbols:
        return []

    # Search for gene IDs by symbol
    term = " OR ".join(f'"{s}"[Gene Symbol]' for s in gene_symbols[:20])
    search_data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", {
        "db": "gene",
        "term": f'({term}) AND "Homo sapiens"[Organism] AND alive[property]',
        "retmax": 25,
        "retmode": "json",
    })
    ids = (search_data or {}).get("esearchresult", {}).get("idlist", [])
    if not ids:
        return []

    fetch_data = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
        "db": "gene",
        "id": ",".join(ids[:20]),
        "retmode": "json",
    })
    if not fetch_data:
        return []

    results = []
    result = fetch_data.get("result", {})
    for uid in result.get("uids", []):
        item = result.get(uid, {})
        if not item or item.get("status") == "discontinued":
            continue
        symbol = item.get("name", "")
        if not symbol or symbol == "1":
            continue
        pub_count = await fetch_pubmed_count(symbol)
        results.append(GeneResult(
            gene_symbol=symbol,
            gene_id=uid,
            disease_association=disease_name,
            description=item.get("description", ""),
            publication_count=pub_count,
            chromosome=item.get("chromosome", ""),
            source="NCBI"
        ))
    return results


async def fetch_disease_genes(disease_name: str) -> list[GeneResult]:
    async with httpx.AsyncClient() as client:
        # Step 1: get gene symbols from ClinVar disease index
        gene_symbols = await _fetch_genes_from_clinvar(disease_name, client)

        # Step 2: if ClinVar returned symbols, fetch their NCBI Gene details
        if gene_symbols:
            genes = await _fetch_gene_details(gene_symbols, disease_name, client)
            if genes:
                return sorted(genes, key=lambda g: g.publication_count or 0, reverse=True)

        # Step 3: fallback — NCBI Gene free-text search with better query
        norm = _normalize_disease_name(disease_name)
        for term in [
            f'"{norm}"[Text Word] AND "Homo sapiens"[Organism] AND alive[property]',
            f'{norm}[Text Word] AND "Homo sapiens"[Organism] AND alive[property]',
        ]:
            search_data = await _get(client, f"{NCBI_BASE}/esearch.fcgi", {
                "db": "gene",
                "term": term,
                "retmax": 20,
                "retmode": "json",
            })
            ids = (search_data or {}).get("esearchresult", {}).get("idlist", [])
            if ids:
                break

        if not ids:
            return []

        fetch_data = await _get(client, f"{NCBI_BASE}/esummary.fcgi", {
            "db": "gene",
            "id": ",".join(ids[:15]),
            "retmode": "json",
        })
        if not fetch_data:
            return []

        genes = []
        result = fetch_data.get("result", {})
        for uid in result.get("uids", []):
            item = result.get(uid, {})
            if not item or item.get("status") == "discontinued":
                continue
            symbol = item.get("name", "")
            if not symbol or symbol == "1":
                continue
            pub_count = await fetch_pubmed_count(symbol)
            genes.append(GeneResult(
                gene_symbol=symbol,
                gene_id=uid,
                disease_association=disease_name,
                description=item.get("description", ""),
                publication_count=pub_count,
                chromosome=item.get("chromosome", ""),
                source="NCBI"
            ))
        return sorted(genes, key=lambda g: g.publication_count or 0, reverse=True)


async def fetch_reactome_pathways(gene_symbol: str) -> list[dict]:
    """Fetch biological pathways for a gene from Reactome."""
    async with httpx.AsyncClient() as client:
        # Map gene symbol to Reactome identifier
        search_url = f"{REACTOME_BASE}/search/query"
        search_data = await _get(client, search_url, {
            "query": gene_symbol,
            "species": "Homo sapiens",
            "types": "Protein",
            "cluster": "true",
        })
        if not search_data:
            return []

        # Extract UniProt accession from results
        accession = None
        results = search_data.get("results", [])
        for group in results:
            for entry in group.get("entries", []):
                if entry.get("species") == "Homo sapiens":
                    accession = entry.get("stId") or entry.get("id")
                    break
            if accession:
                break

        if not accession:
            return []

        # Get pathways for this entity
        pathway_url = f"{REACTOME_BASE}/data/pathways/low/entity/{accession}/allForms"
        pathways_raw = await _get(client, pathway_url, {})
        if not pathways_raw or not isinstance(pathways_raw, list):
            return []

        pathways = []
        seen = set()
        for p in pathways_raw:
            name = p.get("displayName") or p.get("name", "")
            st_id = p.get("stId", "")
            if not name or name in seen:
                continue
            seen.add(name)
            pathways.append({
                "name": name,
                "pathway_id": st_id,
                "species": p.get("speciesName", "Homo sapiens"),
                "url": f"https://reactome.org/PathwayBrowser/#/{st_id}",
                "source": "Reactome",
            })

        return pathways[:20]


async def fetch_gtex_expression(gene_symbol: str) -> list[dict]:
    """Fetch tissue expression data from GTEx."""
    async with httpx.AsyncClient() as client:
        data = await _get(client, f"{GTEX_BASE}/expression/geneExpression", {
            "tissueSiteDetailId": "all",
            "gencodeId": "",
            "geneSymbol": gene_symbol,
            "datasetId": "gtex_v8",
        })
        if not data:
            return []

        expressions = data.get("data", []) if isinstance(data, dict) else []
        results = []
        for item in expressions:
            tissue = item.get("tissueSiteDetail") or item.get("tissueSiteDetailId", "")
            median = item.get("median")
            if tissue and median is not None:
                results.append({
                    "tissue": tissue,
                    "median_tpm": round(float(median), 2),
                    "unit": "TPM",
                    "source": "GTEx",
                })

        return sorted(results, key=lambda x: x["median_tpm"], reverse=True)[:20]


async def fetch_string_interactions(gene_symbol: str, species: int = 9606, limit: int = 15) -> list[dict]:
    """Fetch protein-protein interactions from STRING DB."""
    async with httpx.AsyncClient() as client:
        # Get STRING IDs for the gene
        map_url = f"{STRING_BASE}/json/get_string_ids"
        map_data = await _get(client, map_url, {
            "identifiers": gene_symbol,
            "species": species,
            "limit": 1,
            "caller_identity": "genomechat",
        })
        if not map_data or not isinstance(map_data, list):
            return []

        string_id = map_data[0].get("stringId")
        if not string_id:
            return []

        # Get interactions
        interact_url = f"{STRING_BASE}/json/interaction_partners"
        partners = await _get(client, interact_url, {
            "identifiers": string_id,
            "species": species,
            "limit": limit,
            "caller_identity": "genomechat",
        })
        if not partners or not isinstance(partners, list):
            return []

        results = []
        for p in partners:
            partner_name = p.get("preferredName_B") or p.get("stringId_B", "")
            score = p.get("score", 0)
            if partner_name and partner_name != gene_symbol:
                results.append({
                    "gene": partner_name,
                    "interaction_score": round(score, 3),
                    "score_pct": round(score * 100, 1),
                    "source": "STRING",
                })

        return sorted(results, key=lambda x: x["interaction_score"], reverse=True)


async def fetch_open_targets_drugs(ensembl_id: str) -> list[dict]:
    """Fetch approved and investigational drugs targeting a gene via Open Targets."""
    if not ensembl_id:
        return []
    query = """
    query KnownDrugs($ensemblId: String!) {
      target(ensemblId: $ensemblId) {
        knownDrugs {
          count
          rows {
            drug {
              id
              name
              drugType
              maximumClinicalTrialPhase
              isApproved
            }
            mechanismOfAction
            disease {
              name
            }
            phase
            status
          }
        }
      }
    }
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                OPENTARGETS_BASE,
                json={"query": query, "variables": {"ensemblId": ensembl_id}},
                headers=HEADERS,
                timeout=TIMEOUT,
            )
            if response.status_code != 200:
                return []
            data = response.json()
            rows = (data.get("data", {}).get("target", {}) or {}).get("knownDrugs", {}).get("rows") or []

            seen = set()
            drugs = []
            for row in rows:
                drug = row.get("drug") or {}
                name = drug.get("name", "").strip()
                if not name or name in seen:
                    continue
                seen.add(name)
                drugs.append({
                    "name": name,
                    "drug_type": drug.get("drugType", ""),
                    "phase": row.get("phase") or drug.get("maximumClinicalTrialPhase"),
                    "is_approved": drug.get("isApproved", False),
                    "mechanism": row.get("mechanismOfAction", ""),
                    "indication": (row.get("disease") or {}).get("name", ""),
                    "status": row.get("status", ""),
                })
            return sorted(drugs, key=lambda d: (not d["is_approved"], -(d["phase"] or 0)))
    except Exception as e:
        logger.warning(f"Open Targets drug query failed for {ensembl_id}: {e}")
        return []


async def fetch_gnomad_population_summary(gene_symbol: str) -> list[dict]:
    """Fetch per-ancestry allele frequency summary for a gene from gnomAD."""
    POP_LABELS = {
        "afr": "African/African Am.",
        "amr": "Admixed American",
        "asj": "Ashkenazi Jewish",
        "eas": "East Asian",
        "fin": "Finnish",
        "nfe": "Non-Finnish Eur.",
        "sas": "South Asian",
        "mid": "Middle Eastern",
    }
    query = """
    query PopSummary($geneSymbol: String!) {
      gene(gene_symbol: $geneSymbol, reference_genome: GRCh38) {
        variants(dataset: gnomad_r4) {
          exome {
            ac
            an
            populations {
              id
              ac
              an
            }
          }
        }
      }
    }
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                GNOMAD_BASE,
                json={"query": query, "variables": {"geneSymbol": gene_symbol}},
                headers=HEADERS,
                timeout=TIMEOUT,
            )
            if response.status_code != 200:
                return []
            data = response.json()
            variants_raw = (data.get("data", {}).get("gene", {}) or {}).get("variants", []) or []

            # Aggregate allele counts per population across all variants
            pop_ac: dict[str, int] = {}
            pop_an: dict[str, int] = {}
            for v in variants_raw:
                exome = v.get("exome") or {}
                for pop in exome.get("populations") or []:
                    pid = pop.get("id", "").lower()
                    if pid not in POP_LABELS:
                        continue
                    pop_ac[pid] = pop_ac.get(pid, 0) + (pop.get("ac") or 0)
                    pop_an[pid] = pop_an.get(pid, 0) + (pop.get("an") or 0)

            summary = []
            for pid, label in POP_LABELS.items():
                an = pop_an.get(pid, 0)
                ac = pop_ac.get(pid, 0)
                if an == 0:
                    continue
                summary.append({
                    "population_id": pid,
                    "population": label,
                    "allele_count": ac,
                    "allele_number": an,
                    "allele_frequency": round(ac / an, 8) if an > 0 else 0,
                })
            return sorted(summary, key=lambda x: x["allele_frequency"], reverse=True)
    except Exception as e:
        logger.warning(f"gnomAD population summary failed for {gene_symbol}: {e}")
        return []


async def run_gene_pipeline(gene_symbol: str, population: Optional[str] = None) -> dict:
    ensembl_info, variants, frequencies, uniprot_info, pub_count = await asyncio.gather(
        lookup_gene_ensembl(gene_symbol),
        fetch_clinvar_variants(gene_symbol),
        fetch_gnomad_frequencies(gene_symbol, population),
        fetch_uniprot_info(gene_symbol),
        fetch_pubmed_count(gene_symbol),
        return_exceptions=True
    )

    def safe(val):
        return val if not isinstance(val, Exception) else None

    results = []
    variant_list = safe(variants) or []
    freq_list = safe(frequencies) or []

    freq_map = {f["variant_id"]: f for f in freq_list if f.get("variant_id")}
    for v in variant_list:
        v_dict = v.dict()
        if v.variant_id in freq_map:
            v_dict["frequency"] = freq_map[v.variant_id].get("allele_frequency")
            v_dict["population_frequency"] = freq_map[v.variant_id].get("population_frequency")
        results.append(v_dict)

    if not results and freq_list:
        for f in freq_list:
            results.append({
                "variant_id": f.get("variant_id"),
                "gene": gene_symbol,
                "consequence": f.get("consequence"),
                "frequency": f.get("allele_frequency"),
                "source": "gnomAD"
            })

    uniprot_safe = safe(uniprot_info)
    ensembl_safe = safe(ensembl_info)
    ensembl_id = (ensembl_safe or {}).get("id", "")

    # Fetch AlphaFold, Reactome, GTEx, STRING, Open Targets drugs, gnomAD population summary in parallel
    alphafold_info, pathways, expression, interactions, drugs, pop_summary = await asyncio.gather(
        fetch_alphafold_structure(uniprot_safe["accession"]) if uniprot_safe and uniprot_safe.get("accession") else asyncio.sleep(0),
        fetch_reactome_pathways(gene_symbol),
        fetch_gtex_expression(gene_symbol),
        fetch_string_interactions(gene_symbol),
        fetch_open_targets_drugs(ensembl_id),
        fetch_gnomad_population_summary(gene_symbol),
        return_exceptions=True
    )

    def safe2(val):
        return val if not isinstance(val, Exception) and val is not None else None

    return {
        "gene_info": ensembl_safe,
        "protein_info": uniprot_safe,
        "publication_count": safe(pub_count) or 0,
        "variants": results,
        "alphafold": safe2(alphafold_info),
        "pathways": safe2(pathways) or [],
        "expression": safe2(expression) or [],
        "interactions": safe2(interactions) or [],
        "drugs": safe2(drugs) or [],
        "population_summary": safe2(pop_summary) or [],
        "sources": list(filter(None, [
            "Ensembl" if ensembl_safe else None,
            "ClinVar" if variant_list else None,
            "gnomAD" if freq_list else None,
            "UniProt" if uniprot_safe else None,
            "AlphaFold" if safe2(alphafold_info) else None,
            "Reactome" if safe2(pathways) else None,
            "GTEx" if safe2(expression) else None,
            "STRING" if safe2(interactions) else None,
            "OpenTargets" if safe2(drugs) else None,
            "PubMed"
        ]))
    }


async def run_disease_pipeline(disease_name: str) -> dict:
    genes = await fetch_disease_genes(disease_name)
    gene_dicts = [g.dict() for g in genes]

    return {
        "disease": disease_name,
        "genes": gene_dicts,
        "gene_count": len(gene_dicts),
        "sources": ["NCBI", "PubMed"] if gene_dicts else []
    }
