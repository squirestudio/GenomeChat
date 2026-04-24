import anthropic
import logging
from config import get_settings

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are an expert clinical genomicist and molecular biologist with deep knowledge of human genetics, variant interpretation, and gene-disease relationships.

When analyzing genomics data, structure your response using these sections (use only what's relevant):

## Overview
[1-2 sentence summary of the key finding]

## Key Findings
[Bullet points of the most important discoveries]

## Clinical Significance
[What these variants or genes mean for health and disease]

## Gene-Disease Relationships
[How this gene/these genes connect to diseases and biological mechanisms]

## What This Means for Research
[Practical implications and context]

## Suggested Follow-up Queries
[2-3 specific follow-up questions the researcher might want to ask]

Formatting rules:
- Use **bold** for gene names (BRCA1, TP53) and key clinical terms
- Use bullet points for lists
- Be scientifically precise but accessible to a research scientist
- If data is limited, say so honestly
- Keep responses focused — avoid padding"""


def _format_gene_data(data: dict) -> str:
    lines = []

    gene_info = data.get("gene_info") or {}
    if gene_info:
        lines.append(f"Gene: {gene_info.get('symbol', '?')} ({gene_info.get('id', '')})")
        lines.append(f"Location: Chromosome {gene_info.get('chromosome', '?')}")
        if gene_info.get("description"):
            lines.append(f"Description: {gene_info['description']}")

    protein_info = data.get("protein_info") or {}
    if protein_info:
        lines.append(f"Protein: {protein_info.get('protein_name', '')}")
        if protein_info.get("function"):
            lines.append(f"Function: {protein_info['function'][:300]}")

    pub_count = data.get("publication_count", 0)
    if pub_count:
        lines.append(f"PubMed publications: {pub_count:,}")

    variants = data.get("variants", [])
    lines.append(f"\nVariants retrieved: {len(variants)}")
    for v in variants[:15]:
        sig = v.get("clinical_significance", "Unknown")
        cond = v.get("condition", "")
        cons = v.get("consequence", "")
        freq = v.get("frequency")
        freq_str = f" | AF={freq:.2e}" if freq else ""
        lines.append(f"  - {v.get('variant_id', '?')}: {sig} | {cond} | {cons}{freq_str}")
    if len(variants) > 15:
        lines.append(f"  ... and {len(variants) - 15} more")

    return "\n".join(lines)


def _format_disease_data(data: dict) -> str:
    lines = []
    lines.append(f"Disease/Condition queried: {data.get('disease', '?')}")

    genes = data.get("genes", [])
    lines.append(f"Associated genes found: {len(genes)}")
    for g in genes[:20]:
        symbol = g.get("gene_symbol", "?")
        desc = (g.get("description") or "")[:100]
        chrom = g.get("chromosome", "?")
        pubs = g.get("publication_count", 0)
        lines.append(f"  - {symbol}: {desc} | Chr {chrom} | {pubs:,} publications")

    return "\n".join(lines)


async def explain_results(
    query: str,
    query_type: str,
    data: dict,
    conversation_history: list = None,
) -> str:
    settings = get_settings()
    if not settings.anthropic_api_key:
        return _fallback_explanation(query_type, data)

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    formatted = (
        _format_gene_data(data)
        if query_type == "gene_query"
        else _format_disease_data(data)
    )

    user_content = (
        f'User query: "{query}"\n\n'
        f"Genomics data retrieved:\n{formatted}\n\n"
        f"Please analyze this data. Explain the findings, clinical significance, "
        f"gene-disease relationships, and suggest follow-up research directions."
    )

    messages = list((conversation_history or [])[-6:])
    messages.append({"role": "user", "content": user_content})

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1200,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        return response.content[0].text
    except Exception as e:
        logger.error(f"AI explanation failed: {e}")
        return _fallback_explanation(query_type, data)


async def explain_comparison(
    gene_a: str,
    gene_b: str,
    data_a: dict,
    data_b: dict,
    conversation_history: list = None,
) -> str:
    settings = get_settings()
    if not settings.anthropic_api_key:
        return f"## {gene_a} vs {gene_b}\n\nComparison data retrieved. Add an Anthropic API key for AI-powered analysis."

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    def summarize(symbol, data):
        gi = data.get("gene_info") or {}
        pi = data.get("protein_info") or {}
        variants = data.get("variants", [])
        pathogenic = [v for v in variants if "pathogenic" in (v.get("clinical_significance") or "").lower()]
        clingen = data.get("clingen") or []
        drugs = data.get("drugs") or []
        cancer = data.get("cancer_mutations") or {}
        top_cancer = cancer.get("cancer_types", [{}])[0].get("cancer_type", "") if cancer.get("cancer_types") else ""
        top_validity = clingen[0].get("classification", "") if clingen else ""
        return (
            f"{symbol}:\n"
            f"  Location: Chr {gi.get('chromosome','?')}, {pi.get('length','?')} aa\n"
            f"  Function: {(pi.get('function') or '')[:200]}\n"
            f"  Publications: {data.get('publication_count',0):,}\n"
            f"  ClinVar variants: {len(variants)} total, {len(pathogenic)} pathogenic\n"
            f"  Pathways: {len(data.get('pathways',[]))}\n"
            f"  ClinGen top validity: {top_validity}\n"
            f"  Key drugs: {', '.join(d['name'] for d in drugs[:4])}\n"
            f"  Top cancer type: {top_cancer}"
        )

    content = (
        f'Comparing {gene_a} and {gene_b}.\n\n'
        f'{summarize(gene_a, data_a)}\n\n'
        f'{summarize(gene_b, data_b)}\n\n'
        f'Please compare these two genes. Address: functional similarities/differences, '
        f'clinical significance differences, overlapping vs. distinct disease associations, '
        f'research context, and when a researcher might study one vs the other.'
    )

    messages = list((conversation_history or [])[-4:])
    messages.append({"role": "user", "content": content})

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1400,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        return response.content[0].text
    except Exception as e:
        logger.error(f"Comparison explanation failed: {e}")
        return f"## {gene_a} vs {gene_b}\n\nData retrieved for both genes. Error generating AI comparison: {e}"


async def answer_followup(question: str, conversation_history: list) -> str:
    settings = get_settings()
    if not settings.anthropic_api_key:
        return "Configure an Anthropic API key to enable AI responses."

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    messages = list(conversation_history[-12:])
    messages.append({"role": "user", "content": question})

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=900,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        return response.content[0].text
    except Exception as e:
        logger.error(f"Follow-up failed: {e}")
        return f"Error processing question: {e}"


def _fallback_explanation(query_type: str, data: dict) -> str:
    if query_type == "gene_query":
        variants = data.get("variants", [])
        gene_info = data.get("gene_info") or {}
        symbol = gene_info.get("symbol", "this gene")
        bullet_lines = "\n".join(
            f"- **{v.get('variant_id')}**: {v.get('clinical_significance', 'Unknown')}"
            for v in variants[:5]
        )
        return (
            f"## Overview\nFound **{len(variants)} variants** for **{symbol}**.\n\n"
            f"## Variants (sample)\n{bullet_lines}\n\n"
            f"*Add your Anthropic API key for full AI-powered analysis.*"
        )
    else:
        genes = data.get("genes", [])
        disease = data.get("disease", "this condition")
        bullet_lines = "\n".join(
            f"- **{g.get('gene_symbol')}**: {(g.get('description') or '')[:80]}"
            for g in genes[:5]
        )
        return (
            f"## Overview\nFound **{len(genes)} genes** associated with **{disease}**.\n\n"
            f"## Associated Genes\n{bullet_lines}\n\n"
            f"*Add your Anthropic API key for full AI-powered analysis.*"
        )
