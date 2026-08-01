import anthropic
import json
import logging
from models import InterpretedQuery, QueryType
from config import get_settings

logger = logging.getLogger(__name__)

TOOLS = [
    {
        "name": "interpret_comparison_query",
        "description": "Use when the query asks to compare two specific genes side by side — e.g. 'compare BRCA1 and BRCA2', 'EGFR vs KRAS', 'difference between TP53 and RB1'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "gene_a": {"type": "string", "description": "First gene symbol, e.g. BRCA1"},
                "gene_b": {"type": "string", "description": "Second gene symbol, e.g. BRCA2"},
            },
            "required": ["gene_a", "gene_b"]
        }
    },
    {
        "name": "interpret_gene_query",
        "description": "Use when the query is about a specific gene — looking up variants, mutations, or information about a named gene like BRCA1, TP53, APOE, etc.",
        "input_schema": {
            "type": "object",
            "properties": {
                "gene_symbol": {
                    "type": "string",
                    "description": "The official HGNC gene symbol, e.g. BRCA1, TP53, EGFR"
                },
                "population": {
                    "type": "string",
                    "description": "Population filter if specified, e.g. European, African, East Asian"
                },
                "variant_type": {
                    "type": "string",
                    "description": "Type of variant if specified, e.g. pathogenic, benign, missense"
                }
            },
            "required": ["gene_symbol"]
        }
    },
    {
        "name": "interpret_disease_query",
        "description": (
            "Use when the query is about a disease, condition, syndrome, OR an individual "
            "clinical sign, symptom or phenotype — anything that has genes associated with it. "
            "Diseases: Alzheimer's, breast cancer, Parkinson's, osteogenesis imperfecta. "
            "Signs and phenotypes belong here too, even though they are not diseases in "
            "themselves: hypotonia, ataxia, nystagmus, seizures, developmental delay, short "
            "stature, hearing loss. These are exactly the terms a reader meets in a case report "
            "and looks up, and each one has a real gene-association answer, so route them here "
            "rather than treating them as unclassifiable."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "disease_name": {
                    "type": "string",
                    "description": "The disease, condition, or phenotype name, e.g. Alzheimer's disease, hereditary breast cancer, hypotonia"
                },
                "qualifier": {
                    "type": "string",
                    "description": "Any qualifier like early-onset, familial, sporadic"
                }
            },
            "required": ["disease_name"]
        }
    },
    {
        "name": "interpret_followup_query",
        "description": (
            "Use ONLY when the query names no gene, disease or phenotype that could be looked "
            "up — a conversational follow-up about what was already said ('what does that mean?', "
            "'explain the second one', 'why is that significant?'), or a general question about "
            "genetics itself ('what is a missense mutation?'). If the query names anything with "
            "gene associations, prefer one of the other tools."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Brief note on why this is conversational rather than a lookup"
                }
            },
            "required": []
        }
    }
]

SYSTEM_PROMPT = """You are a genomics query interpreter. Your job is to analyze natural language queries about genes and diseases, then call the appropriate tool to classify the query.

Rules:
- If the query asks to compare two genes (e.g. "compare BRCA1 and BRCA2", "EGFR vs KRAS") → use interpret_comparison_query
- If the query mentions a single specific gene symbol (BRCA1, TP53, EGFR, etc.) → use interpret_gene_query
- If the query mentions a disease, condition, syndrome, sign, symptom or phenotype → use interpret_disease_query
- Only if the query names nothing lookupable at all → use interpret_followup_query
- Always call exactly one tool
- Extract gene symbols in their standard uppercase form (BRCA1, not brca1 or Brca1)
- Extract disease names in a clean searchable form

Phrasing never decides the route — only content does. "hypotonia", "what is
hypotonia", "tell me about hypotonia" and "hypotonia genes" are the same query
and must all reach interpret_disease_query. A definitional "what is X" is not a
conversational follow-up when X is a real biomedical term."""


async def interpret_query(query_text: str) -> InterpretedQuery:
    settings = get_settings()

    if not settings.anthropic_api_key:
        return _fallback_interpret(query_text)

    # Async client: the sync one blocks the event loop for every other request.
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    try:
        response = await client.messages.create(
            # Classification into three well-described tools — Haiku is as
            # accurate here (8/8 on the regression cases) and roughly 3x faster,
            # which is ~2s off every query's time-to-first-anything.
            model="claude-haiku-4-5-20251001",
            max_tokens=256,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            # "Always call exactly one tool" was only ever a request, and the
            # model declined it reliably for some inputs: "what is hypotonia"
            # returned prose instead of a tool call 10 times out of 10, and
            # "what is ataxia" roughly 1 time in 10. A prose reply matched no
            # branch below, fell through to _fallback_interpret(), and became
            # UNKNOWN — routing a perfectly answerable query (ClinVar has 20
            # genes for hypotonia) to the path that runs no pipeline at all.
            #
            # tool_choice makes it a constraint. This is only safe because
            # interpret_followup_query exists: forcing a call without it would
            # shove "what does that mean?" into a gene lookup and break
            # conversational follow-ups, which depend on reaching UNKNOWN.
            tool_choice={"type": "any"},
            messages=[{"role": "user", "content": query_text}]
        )

        for block in response.content:
            if block.type == "tool_use":
                if block.name == "interpret_comparison_query":
                    gene_a = block.input["gene_a"].upper()
                    gene_b = block.input["gene_b"].upper()
                    return InterpretedQuery(
                        query_type=QueryType.COMPARISON_QUERY,
                        target=f"{gene_a} vs {gene_b}",
                        filters={"gene_a": gene_a, "gene_b": gene_b},
                        confidence=0.95
                    )
                elif block.name == "interpret_gene_query":
                    return InterpretedQuery(
                        query_type=QueryType.GENE_QUERY,
                        target=block.input["gene_symbol"].upper(),
                        population=block.input.get("population"),
                        filters={"variant_type": block.input.get("variant_type")} if block.input.get("variant_type") else {},
                        confidence=0.95
                    )
                elif block.name == "interpret_disease_query":
                    return InterpretedQuery(
                        query_type=QueryType.DISEASE_QUERY,
                        target=block.input["disease_name"],
                        filters={"qualifier": block.input.get("qualifier")} if block.input.get("qualifier") else {},
                        confidence=0.95
                    )
                elif block.name == "interpret_followup_query":
                    # Deliberately routed to the conversational path, not a
                    # failure to classify. The confidence is what tells the two
                    # apart downstream and in logs: 0.9 here, 0.2 from the
                    # regex fallback. They used to be indistinguishable.
                    return InterpretedQuery(
                        query_type=QueryType.UNKNOWN,
                        target=query_text.strip(),
                        confidence=0.9
                    )

        # Unreachable while tool_choice is enforced, and worth an ERROR rather
        # than a silent fallback if it ever becomes reachable again: it means
        # every such query is quietly skipping the genomics pipeline.
        logger.error("Interpreter returned no tool call for %r; using heuristic", query_text)

    except Exception as e:
        logger.warning(f"Claude interpretation failed: {e}, falling back to heuristic")

    return _fallback_interpret(query_text)


def _fallback_interpret(query_text: str) -> InterpretedQuery:
    """Simple heuristic fallback when Claude API is unavailable."""
    import re

    # Check for comparison intent
    vs_match = re.search(r'\b([A-Z][A-Z0-9]{1,7})\b\s+(?:vs\.?|versus|and|compared? to)\s+\b([A-Z][A-Z0-9]{1,7})\b', query_text, re.IGNORECASE)
    if vs_match or any(kw in query_text.lower() for kw in ["compare ", "vs ", "versus ", "difference between"]):
        genes = re.findall(r'\b([A-Z][A-Z0-9]{1,7})\b', query_text)
        if len(genes) >= 2:
            return InterpretedQuery(
                query_type=QueryType.COMPARISON_QUERY,
                target=f"{genes[0]} vs {genes[1]}",
                filters={"gene_a": genes[0], "gene_b": genes[1]},
                confidence=0.7
            )

    gene_pattern = r'\b([A-Z][A-Z0-9]{1,7})\b'
    disease_keywords = [
        "disease", "syndrome", "disorder", "cancer", "tumor", "carcinoma",
        "alzheimer", "parkinson", "diabetes", "epilepsy", "autism", "leukemia",
        "lymphoma", "melanoma", "hereditary", "familial",
        # Clinical signs and phenotypes. Not diseases, but each has real gene
        # associations (HPO lists 1,956 genes under hypotonia alone) and these
        # are the words a reader lifts straight out of a case report. Omitting
        # them meant the heuristic answered "syndromic hypotonia" and gave up
        # on "hypotonia".
        "hypotonia", "hypertonia", "ataxia", "nystagmus", "seizure", "dystonia",
        "myopathy", "neuropathy", "dystrophy", "atrophy", "deficiency",
        "malformation", "dysplasia", "developmental delay", "intellectual disability",
        "short stature", "hearing loss", "vision loss", "phenotype", "symptom",
    ]

    text_lower = query_text.lower()

    for keyword in disease_keywords:
        if keyword in text_lower:
            return InterpretedQuery(
                query_type=QueryType.DISEASE_QUERY,
                target=query_text.strip(),
                confidence=0.6
            )

    matches = re.findall(gene_pattern, query_text)
    known_gene_prefixes = ("BRCA", "TP", "EGFR", "KRAS", "PTEN", "ATM", "APOE", "MLH", "MSH", "APC", "VHL", "RB1")
    for match in matches:
        if any(match.startswith(p) for p in known_gene_prefixes) or len(match) <= 6:
            return InterpretedQuery(
                query_type=QueryType.GENE_QUERY,
                target=match,
                confidence=0.5
            )

    return InterpretedQuery(
        query_type=QueryType.UNKNOWN,
        target=query_text.strip(),
        confidence=0.2
    )
