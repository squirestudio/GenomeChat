import anthropic
import logging
from config import get_settings
from services.safety import NO_DIAGNOSIS_RULES, detect_diagnostic_intent, reframe_directive

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT_BODY = """You are an expert clinical genomicist and molecular biologist with deep knowledge of human genetics, variant interpretation, gene-disease relationships, and population genetics.

When analyzing genomics data, structure your response using these sections (use only what's relevant):

## Overview
[1-2 sentence summary of the key finding]

## Key Findings
[Bullet points of the most important discoveries]

## Clinical Significance
[What these variants or genes mean for health and disease]

## Population Genetics
[If population allele frequency data is provided: compare frequencies across ancestry groups, explain what higher AF in a specific population means for carrier risk, note any founder effects or population-specific enrichment. Be specific with numbers when available.]

## Gene-Disease Relationships
[How this gene/these genes connect to diseases and biological mechanisms]

## What This Means for Research
[Practical implications and context]

## Your Variants
[ONLY include this section if personal variant data is present. Interpret the user's specific genotype(s) in context of the gene's known variants. Explain whether the genotype is homozygous reference (common), heterozygous carrier, or homozygous alternate. Note clinical significance if known. Always end with: "This is for educational purposes only — consult a licensed genetic counselor for clinical interpretation."]

## Worth knowing
[Optional. Context that would change how these findings should be read — family
history, current medications, ancestry, whether a diagnosis is already
suspected. Written as prose to the reader. This is the ONLY place a question
addressed to the reader may appear.]

## Explore next
[2-4 queries the reader can run in MyDNA, as a markdown list, one per line.

Each line must be a self-contained lookup MyDNA can actually perform: a gene, a
disease, a phenotype, or a comparison of two genes. Write only the query text —
no numbering, no explanation, no trailing question mark.

Never put a question to the reader here. "Do you have a family history of
early-onset cardiovascular disease?" is not a query and MyDNA cannot answer it;
"APOE variants" and "genes associated with early-onset cardiovascular disease"
are. If the useful next step depends on something only the reader knows, that
belongs under Worth knowing instead.

Good: COL1A1 pathogenic variants · genes associated with osteogenesis
imperfecta · CYP2C19 pharmacogenomics · compare COL1A1 and COL1A2]

Formatting rules:
- Use **bold** for gene names (BRCA1, TP53), population names, and key clinical terms
- Use bullet points for lists
- Be scientifically precise and write for an intelligent adult who is not a
  geneticist. Most readers are here about their own health or a family
  member's, not to review a paper
- Prefer the ordinary word. "Removes" or "switches off" rather than "ablates",
  "how likely a variant is to actually cause the condition" rather than a bare
  "penetrance", "changes one amino acid" rather than an unglossed "missense"
- When a technical term is genuinely the right one, use it and define it in the
  same sentence the first time. Precision is not the enemy; unexplained
  precision is
- Never use a Latin or Greek term where an English one exists, and never use an
  abbreviation you have not expanded once
- When population frequency data is present, always include a Population Genetics section and directly compare the groups mentioned in the query
- If a user asks about specific population comparisons (e.g. South Asian vs Non-Finnish European), address it directly using the AF data provided
- If data is limited, say so honestly
- Keep responses focused — avoid padding"""

# The output-side clinical guard is appended to every system prompt, on every
# path, rather than being passed in by callers who might forget. See
# services/safety.py for why there are two independent guards.
SYSTEM_PROMPT = f"{_SYSTEM_PROMPT_BODY}\n\n{NO_DIAGNOSIS_RULES}"


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

    # ClinGen gene-disease validity
    clingen = data.get("clingen") or []
    if clingen:
        lines.append(f"\nClinGen Gene-Disease Validity ({len(clingen)} curated):")
        for c in clingen[:6]:
            lines.append(f"  - {c.get('classification', '?')}: {c.get('disease', '?')} ({c.get('moi', '')})")

    # GWAS trait associations
    gwas = data.get("gwas") or []
    if gwas:
        lines.append(f"\nGWAS Catalog trait associations ({len(gwas)} found):")
        for g in gwas[:8]:
            pstr = g.get("p_value_str", "N/A")
            or_str = f" OR/β={g['or_beta']:.3f}" if g.get("or_beta") else ""
            lines.append(f"  - {g.get('trait', '?')}: p={pstr}{or_str}")

    # HPO phenotype terms
    hpo = data.get("hpo") or {}
    hpo_terms = hpo.get("phenotype_terms") or []
    if hpo_terms:
        lines.append(f"\nHPO Phenotype Terms ({len(hpo_terms)} associated):")
        for t in hpo_terms[:12]:
            lines.append(f"  - {t.get('id', '')}: {t.get('name', '')}")

    # Population-level allele frequencies (gnomAD)
    pop_summary = data.get("population_summary") or []
    if pop_summary:
        lines.append(f"\ngnomAD v4 Population Allele Frequencies (all variants in gene):")
        for p in pop_summary:
            af = p.get("allele_frequency", 0)
            ac = p.get("allele_count", 0)
            an = p.get("allele_number", 0)
            lines.append(
                f"  - {p.get('population', '?')}: AF={af:.2e}  (AC={ac:,} / AN={an:,})"
            )
        lines.append(
            "  NOTE: Higher AF in a population = more carriers of variants in this gene in that ancestry group."
        )

    # Pathogenic variants with per-population breakdown where available
    variants = data.get("variants", [])
    pathogenic = [v for v in variants if "pathogenic" in (v.get("clinical_significance") or "").lower()]
    lines.append(f"\nClinVar variants retrieved: {len(variants)} total, {len(pathogenic)} pathogenic/likely-pathogenic")
    for v in variants[:15]:
        sig = v.get("clinical_significance", "Unknown")
        cond = v.get("condition", "")
        cons = v.get("consequence", "")
        freq = v.get("frequency")
        freq_str = f" | AF={freq:.2e}" if freq else ""
        hgvs = v.get("hgvs", "")
        hgvs_str = f" | {hgvs}" if hgvs else ""
        all_pop = v.get("all_population_frequencies") or {}
        pop_str = ""
        if all_pop:
            notable = {k: vf for k, vf in all_pop.items() if vf and float(vf) > 0}
            if notable:
                pop_str = " | pop: " + ", ".join(f"{k}={float(vf):.2e}" for k, vf in list(notable.items())[:5])
        lines.append(f"  - {v.get('variant_id', '?')}: {sig} | {cond} | {cons}{hgvs_str}{freq_str}{pop_str}")
    if len(variants) > 15:
        lines.append(f"  ... and {len(variants) - 15} more")

    # OMIM disease phenotypes
    omim = data.get("omim") or {}
    phenotypes = omim.get("phenotypes") or []
    if phenotypes:
        lines.append(f"\nOMIM Disease Associations ({len(phenotypes)}):")
        for p in phenotypes[:5]:
            lines.append(f"  - {p.get('title', '?')} (MIM #{p.get('mim_number', '?')}) | {p.get('inheritance', '')}")

    # Pathways
    pathways = data.get("pathways") or []
    if pathways:
        lines.append(f"\nReactome Pathways ({len(pathways)}): " + ", ".join(p.get("name", "") for p in pathways[:5]))

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


# Reading level and detail are different axes and were being conflated. Detail
# is how much to say; this is how hard the words are. A researcher wanting a
# short answer and a worried parent wanting a short answer need the same length
# and very different language.
READING_LEVEL_INSTRUCTIONS = {
    "plain": (
        "Write for someone with no biology background. Short sentences. Everyday "
        "words. If a technical term is unavoidable, define it immediately in "
        "plain language, in the same sentence. Explain what something means for a "
        "person before explaining the mechanism. Do not simplify the facts — "
        "simplify only the language, and never round a number or drop a caveat to "
        "make a sentence easier."
    ),
    "standard": "",   # the base prompt, already aimed at a non-specialist adult
    "technical": (
        "The reader is a clinician or researcher. Use standard terminology "
        "without glossing it, keep the molecular detail, and include effect "
        "sizes, inheritance patterns and evidence levels precisely."
    ),
}

DETAIL_INSTRUCTIONS = {
    "concise": "Be brief. Respond in 3-5 bullet points maximum. Skip population genetics and research context sections. Lead with the single most important clinical finding.",
    "standard": "",  # default prompt, no override
    "detailed": "Provide a thorough, in-depth analysis. Include all relevant sections: population genetics with specific numbers, molecular mechanisms, gene-disease relationships, research implications, and 3-4 specific follow-up queries. Do not abbreviate any section.",
}

def _format_documents(personal_documents: list) -> str:
    """The reader's own uploaded literature, as prompt text.

    Held to the same rule as personal_variants: passed per-request, used, and
    never written anywhere. The instruction to attribute and to keep the
    document separate from the databases is not politeness — merging a single
    paper's cohort into MyDNA's curated sources is how one study's finding
    starts sounding like established fact.
    """
    if not personal_documents:
        return ""

    out = [
        "\n\n## Documents the reader uploaded (session only — never stored)\n"
        "These are the reader's own materials, not MyDNA's sources. Cite them by title "
        "when you use them, keep their claims distinct from the curated databases above, "
        "and state the cohort size whenever a claim rests on one study. If a document "
        "contradicts a database, say so rather than silently preferring either.\n"
    ]
    for doc in personal_documents[:10]:
        title = (doc.get("title") or "Untitled document").strip()
        citation = (doc.get("citation") or "").strip()
        out.append(f"\n### {title}" + (f"\n*{citation}*" if citation else ""))
        for passage in (doc.get("passages") or [])[:12]:
            text = (passage or "").strip()
            if text:
                out.append(f"\n> {text}")
        out.append("\n")
    return "".join(out)


def build_explanation_messages(
    query: str,
    query_type: str,
    data: dict,
    conversation_history: list = None,
    personal_variants: list = None,
    response_detail: str = "standard",
    personal_documents: list = None,
    reading_level: str = "plain",
) -> list:
    """Build the message list for an explanation. Shared by the streaming and
    non-streaming paths so both send byte-identical prompts."""
    formatted = (
        _format_gene_data(data)
        if query_type == "gene_query"
        else _format_disease_data(data)
    )

    personal_section = ""
    if personal_variants:
        personal_section = (
            "\n\n## User's Personal Variants (from uploaded DNA file — session only, not stored)\n"
            "IMPORTANT: The user has uploaded their own genetic data. The following variants from this gene "
            "were found in their DNA file. Interpret these results carefully and note them specifically "
            "in your response. Always remind the user this is not a clinical diagnosis.\n"
        )
        for v in personal_variants[:30]:
            rsid = v.get("rsid", "unknown")
            genotype = v.get("genotype", "?")
            chrom = v.get("chromosome", "")
            personal_section += f"- {rsid}: genotype {genotype}"
            if chrom:
                personal_section += f" (chr{chrom})"
            personal_section += "\n"

    user_content = (
        f'User query: "{query}"\n\n'
        f"Genomics data retrieved:\n{formatted}{personal_section}"
        f"{_format_documents(personal_documents)}\n\n"
        f"Please analyze this data. Explain the findings, clinical significance, "
        f"gene-disease relationships, and suggest follow-up research directions."
        + ("\n\nNOTE: The user has personal genetic data loaded for this gene. Address their specific variants directly, but remind them this is for research purposes only and not a substitute for clinical genetic counseling." if personal_variants else "")
    )

    detail_note = DETAIL_INSTRUCTIONS.get(response_detail or "standard", "")
    if detail_note:
        user_content += f"\n\nINSTRUCTION: {detail_note}"

    level_note = READING_LEVEL_INSTRUCTIONS.get(reading_level or "plain", "")
    if level_note:
        user_content += f"\n\nLANGUAGE: {level_note}"

    # The input-side guard, last so it is the most recent thing the model reads.
    # Its job is to redirect a diagnostic question to the data relationship
    # behind it, not to refuse the turn.
    directive = reframe_directive(detect_diagnostic_intent(query))
    if directive:
        user_content += f"\n\n{directive}"

    messages = list((conversation_history or [])[-6:])
    messages.append({"role": "user", "content": user_content})
    return messages


EXPLAIN_MODEL = "claude-haiku-4-5-20251001"
# A gene answer with a full data panel behind it does not fit in 1200 tokens.
# It was being cut mid-sentence, and because "Explore next" is the last section
# the model writes, the suggestions were usually the part that vanished — the
# reader saw an answer that simply stopped. The conversational path has always
# had 2500; this was the outlier, not the norm.
EXPLAIN_MAX_TOKENS = 2000

# Transcription is the one place a bigger model earns its cost. A photographed
# journal page is rotated, two-column, and full of variant notation where a
# single wrong character (c.507G>A vs c.507C>A) makes it a different variant —
# and a plausible-looking wrong transcription is worse than no transcription,
# because nothing downstream can tell it is wrong.
VISION_MODEL = "claude-sonnet-5"
VISION_MAX_TOKENS = 8000

TRANSCRIBE_PROMPT = (
    "Transcribe this page of a scientific paper as plain text. Preserve paragraph "
    "breaks, headings, table contents and any DOI, PMID or citation line. Read "
    "multi-column layouts in reading order, finishing one column before starting the "
    "next. Correct obvious scanning artefacts but never invent text: if something is "
    "illegible, write [illegible] rather than guessing. Gene symbols, variant notation "
    "(c.507G>A, p.Cys170Leufs) and numbers must be transcribed exactly. Output only the "
    "transcription, with no preamble."
)


async def transcribe_pages(images: list[str], media_type: str = "image/jpeg",
                           user_api_key: str = None) -> str:
    """Read photographed or scanned pages into plain text.

    Privacy: the images and the resulting text are returned to the caller and
    never stored or logged here. The error path deliberately says how many pages
    failed and nothing about their content.
    """
    settings = get_settings()
    api_key = user_api_key or settings.anthropic_api_key
    if not api_key:
        raise RuntimeError("no Anthropic API key configured")

    content = [
        {"type": "image",
         "source": {"type": "base64", "media_type": media_type, "data": img}}
        for img in images
    ]
    content.append({"type": "text", "text": TRANSCRIBE_PROMPT})

    client = anthropic.AsyncAnthropic(api_key=api_key)
    response = await client.messages.create(
        model=VISION_MODEL,
        max_tokens=VISION_MAX_TOKENS,
        messages=[{"role": "user", "content": content}],
    )
    return "".join(b.text for b in response.content if getattr(b, "type", "") == "text")


async def explain_results(
    query: str,
    query_type: str,
    data: dict,
    conversation_history: list = None,
    personal_variants: list = None,
    response_detail: str = "standard",
    user_api_key: str = None,
    personal_documents: list = None,
    reading_level: str = "plain",
) -> str:
    settings = get_settings()
    api_key = user_api_key or settings.anthropic_api_key
    if not api_key:
        return _fallback_explanation(query_type, data)

    messages = build_explanation_messages(
        query, query_type, data, conversation_history, personal_variants, response_detail,
        personal_documents=personal_documents, reading_level=reading_level,
    )
    # AsyncAnthropic: the sync client blocks the event loop for the whole
    # generation, which stalls every other request on the server.
    client = anthropic.AsyncAnthropic(api_key=api_key)
    try:
        response = await client.messages.create(
            model=EXPLAIN_MODEL,
            max_tokens=EXPLAIN_MAX_TOKENS,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        return response.content[0].text
    except Exception as e:
        logger.error(f"AI explanation failed: {e}")
        return _fallback_explanation(query_type, data)


async def stream_explanation(
    query: str,
    query_type: str,
    data: dict,
    conversation_history: list = None,
    personal_variants: list = None,
    response_detail: str = "standard",
    user_api_key: str = None,
    personal_documents: list = None,
    reading_level: str = "plain",
):
    """Yield the explanation in chunks as the model produces it."""
    settings = get_settings()
    api_key = user_api_key or settings.anthropic_api_key
    if not api_key:
        yield _fallback_explanation(query_type, data)
        return

    messages = build_explanation_messages(
        query, query_type, data, conversation_history, personal_variants, response_detail,
        personal_documents=personal_documents, reading_level=reading_level,
    )
    client = anthropic.AsyncAnthropic(api_key=api_key)
    try:
        async with client.messages.stream(
            model=EXPLAIN_MODEL,
            max_tokens=EXPLAIN_MAX_TOKENS,
            system=SYSTEM_PROMPT,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text
    except Exception as e:
        logger.error(f"AI explanation stream failed: {e}")
        yield _fallback_explanation(query_type, data)


async def stream_followup(
    question: str,
    conversation_history: list,
    personal_variants: list = None,
    response_detail: str = "standard",
    user_api_key: str = None,
    personal_documents: list = None,
    reading_level: str = "plain",
):
    """Streaming counterpart of answer_followup."""
    settings = get_settings()
    api_key = user_api_key or settings.anthropic_api_key
    if not api_key:
        yield "Configure an Anthropic API key to enable AI responses."
        return

    messages = build_followup_messages(question, conversation_history, personal_variants,
                                       response_detail, personal_documents=personal_documents,
                                       reading_level=reading_level)
    client = anthropic.AsyncAnthropic(api_key=api_key)
    try:
        async with client.messages.stream(
            model=EXPLAIN_MODEL,
            max_tokens=2500,
            system=SYSTEM_PROMPT,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text
    except Exception as e:
        logger.error(f"Follow-up stream failed: {e}")
        yield f"Error processing question: {e}"


async def explain_comparison(
    gene_a: str,
    gene_b: str,
    data_a: dict,
    data_b: dict,
    conversation_history: list = None,
    user_api_key: str = None,
) -> str:
    settings = get_settings()
    api_key = user_api_key or settings.anthropic_api_key
    if not api_key:
        return f"## {gene_a} vs {gene_b}\n\nComparison data retrieved. Add an Anthropic API key for AI-powered analysis."

    client = anthropic.AsyncAnthropic(api_key=api_key)

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
        response = await client.messages.create(
            model=EXPLAIN_MODEL,
            max_tokens=1400,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        return response.content[0].text
    except Exception as e:
        logger.error(f"Comparison explanation failed: {e}")
        return f"## {gene_a} vs {gene_b}\n\nData retrieved for both genes. Error generating AI comparison: {e}"


def build_followup_messages(question: str, conversation_history: list, personal_variants: list = None,
                            response_detail: str = "standard", personal_documents: list = None,
                            reading_level: str = "plain") -> list:
    """Shared by the streaming and non-streaming follow-up paths."""
    messages = list((conversation_history or [])[-12:])

    content = question
    if personal_variants:
        lines = [f"- {v.get('rsid', '?')}: genotype {v.get('genotype', '?')}" for v in personal_variants[:200]]
        content = (
            f"{question}\n\n"
            f"## User's Personal Variants (uploaded DNA file — session only, not stored)\n"
            + "\n".join(lines)
            + "\n\nPlease interpret these variants. Address them specifically and remind the user this is educational only, not a clinical diagnosis."
        )

    content += _format_documents(personal_documents)

    detail_note = DETAIL_INSTRUCTIONS.get(response_detail or "standard", "")
    if detail_note:
        content += f"\n\nINSTRUCTION: {detail_note}"

    level_note = READING_LEVEL_INSTRUCTIONS.get(reading_level or "plain", "")
    if level_note:
        content += f"\n\nLANGUAGE: {level_note}"

    # Follow-ups need the input guard as much as pipeline answers do — arguably
    # more, since "so do I have it?" is exactly the shape of a follow-up.
    directive = reframe_directive(detect_diagnostic_intent(question))
    if directive:
        content += f"\n\n{directive}"

    messages.append({"role": "user", "content": content})
    return messages


async def answer_followup(question: str, conversation_history: list, personal_variants: list = None,
                          response_detail: str = "standard", user_api_key: str = None,
                          personal_documents: list = None, reading_level: str = "plain") -> str:
    settings = get_settings()
    api_key = user_api_key or settings.anthropic_api_key
    if not api_key:
        return "Configure an Anthropic API key to enable AI responses."

    messages = build_followup_messages(question, conversation_history, personal_variants,
                                       response_detail, personal_documents=personal_documents,
                                       reading_level=reading_level)
    client = anthropic.AsyncAnthropic(api_key=api_key)
    try:
        response = await client.messages.create(
            model=EXPLAIN_MODEL,
            max_tokens=2500,
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
