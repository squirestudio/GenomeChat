"""Cross-source findings for Research mode.

**Everything here is computed, not generated.** The point of research mode is not
that the model is allowed to speculate more freely — it is that nobody is
currently joining these sources *against each other*, and the joins produce real
signals. A researcher acting on a hallucinated relationship loses a month at the
bench, which is a far worse failure than a wrong answer to a curious reader, so
the model's job downstream is to explain and prioritise these findings rather
than to invent any.

Every function is pure over the pipeline dict, takes no network, and returns
`Finding` records carrying the evidence that produced them. If a source is
missing or a field is absent the analysis yields nothing rather than guessing —
the same degrade-to-empty contract every fetcher follows.

What this deliberately does **not** do: assign clinical meaning. A flagged
variant is a variant worth a human's attention, never a reclassification.
"""

from datetime import date, datetime
from typing import Any, Optional

# Ordered weakest to strongest; the index is the rank used for spread.
_VALIDITY_RANK = [
    "no known disease relationship", "refuted", "disputed", "animal model only",
    "limited", "supportive", "moderate", "strong", "definitive",
]

# ClinVar review status, weakest first. "no assertion criteria provided" means a
# submitter asserted a classification without saying how they reached it.
_WEAK_REVIEW = {
    "no assertion criteria provided",
    "no assertion provided",
    "no classification provided",
    "flagged submission",
}

_PATHOGENIC = ("pathogenic",)
_BENIGN = ("benign",)


def _finding(kind: str, severity: str, headline: str, detail: str,
             evidence: list, sources: list) -> dict:
    return {
        "kind": kind,
        "severity": severity,          # "high" | "medium" | "low"
        "headline": headline,
        "detail": detail,
        "evidence": evidence,
        "sources": sources,
    }


def _sig(variant) -> str:
    raw = variant.get("clinical_significance") if isinstance(variant, dict) else None
    if isinstance(raw, list):
        raw = ", ".join(str(x) for x in raw)
    return str(raw or "").strip().lower()


def _is_pathogenic(sig: str) -> bool:
    # "conflicting interpretations of pathogenicity" contains the word and is
    # not a pathogenic call; excluding it matters because those rows are common.
    if "conflicting" in sig:
        return False
    return any(p in sig for p in _PATHOGENIC)


def _is_benign(sig: str) -> bool:
    if "conflicting" in sig:
        return False
    return any(b in sig for b in _BENIGN)


def curator_disagreement(gencc: Optional[list]) -> list[dict]:
    """Gene–disease pairs where curators reached different verdicts.

    The most directly useful finding in the set, because a split verdict marks
    where the evidence is genuinely unsettled — which is where there is work to
    do. `spread` is already computed upstream as the distance between the
    weakest and strongest classification on the pair.
    """
    out = []
    for row in gencc or []:
        if not isinstance(row, dict) or not row.get("disputed"):
            continue
        verdicts = row.get("verdicts") or []
        labels = [str(v.get("classification", "")) for v in verdicts if isinstance(v, dict)]
        spread = row.get("spread") or 0
        out.append(_finding(
            kind="curator_disagreement",
            severity="high" if spread >= 3 else "medium",
            headline=f"{row.get('disease', 'Unknown disease')}: curators disagree",
            detail=(
                f"{row.get('submitter_count', len(labels))} submitters, "
                f"{len(set(labels))} different classifications "
                f"({', '.join(sorted(set(labels)))}). "
                "Disagreement usually means they weighed different evidence; the "
                "cited papers below are where that becomes visible."
            ),
            evidence=[{
                "disease": row.get("disease"),
                "classifications": labels,
                "spread": spread,
                "pmids": (row.get("pmids") or [])[:10],
                "moi": row.get("moi"),
            }],
            sources=["GenCC"],
        ))
    out.sort(key=lambda f: -(f["evidence"][0]["spread"] or 0))
    return out


def constraint_tension(constraint: Optional[dict], variants: Optional[list]) -> list[dict]:
    """A gene the population cannot afford to break, whose variants read benign.

    LOEUF below 0.35 means loss of function is strongly selected against. If the
    curated variant set is nonetheless dominated by benign calls, one of two
    things is true and both are worth knowing: the pathogenic variation is
    somewhere nobody has looked, or the benign calls are under-powered.
    """
    if not isinstance(constraint, dict):
        return []
    loeuf = constraint.get("loeuf")
    if not isinstance(loeuf, (int, float)) or loeuf >= 0.35:
        return []

    rows = [v for v in (variants or []) if isinstance(v, dict)]
    if len(rows) < 5:
        return []

    benign = sum(1 for v in rows if _is_benign(_sig(v)))
    pathogenic = sum(1 for v in rows if _is_pathogenic(_sig(v)))
    if benign <= pathogenic:
        return []

    return [_finding(
        kind="constraint_tension",
        severity="medium",
        headline=f"Constrained gene, benign-leaning variant set (LOEUF {loeuf})",
        detail=(
            f"LOEUF of {loeuf} puts this gene among those least tolerant of loss of "
            f"function, yet {benign} of {len(rows)} curated variants read benign "
            f"against {pathogenic} pathogenic. Either the damaging variation sits "
            "where nobody has sequenced, or the benign calls are under-powered."
        ),
        evidence=[{
            "loeuf": loeuf,
            "observed_lof": constraint.get("observed_lof"),
            "expected_lof": constraint.get("expected_lof"),
            "benign": benign,
            "pathogenic": pathogenic,
            "total_curated": len(rows),
        }],
        sources=["gnomAD", "ClinVar"],
    )]


def stale_evidence(clingen: Optional[list], today: Optional[date] = None,
                   years: int = 5) -> list[dict]:
    """Validity calls old enough that the evidence behind them has moved on.

    A Definitive call from 2015 and one from last year are different claims. The
    date is already fetched and shown; nothing sorted on it, so an old call and a
    current one looked identical.
    """
    today = today or date.today()
    out = []
    for row in clingen or []:
        if not isinstance(row, dict):
            continue
        raw = row.get("classified_on")
        if not raw:
            continue
        try:
            when = datetime.strptime(str(raw)[:10], "%Y-%m-%d").date()
        except ValueError:
            continue
        age = (today - when).days / 365.25
        if age < years:
            continue
        out.append(_finding(
            kind="stale_evidence",
            severity="low",
            headline=f"{row.get('disease', 'Unknown disease')}: classification is {age:.0f} years old",
            detail=(
                f"ClinGen last classified this pair as "
                f"{row.get('classification', 'unknown')} on {when.isoformat()}. "
                "Anything published since has not been weighed into it."
            ),
            evidence=[{
                "disease": row.get("disease"),
                "classification": row.get("classification"),
                "classified_on": when.isoformat(),
                "age_years": round(age, 1),
            }],
            sources=["ClinGen"],
        ))
    out.sort(key=lambda f: -(f["evidence"][0]["age_years"] or 0))
    return out


def unsupported_assertions(variants: Optional[list]) -> list[dict]:
    """Pathogenic calls with no stated assertion criteria.

    ClinVar accepts a classification without the submitter saying how they
    reached it. Those rows render identically to expert-panel calls in most
    interfaces, including this one, and a researcher choosing which variants to
    follow up should be able to see the difference.
    """
    weak = []
    for v in variants or []:
        if not isinstance(v, dict):
            continue
        if not _is_pathogenic(_sig(v)):
            continue
        status = str(v.get("review_status") or "").strip().lower()
        if status in _WEAK_REVIEW:
            weak.append({
                "variant_id": v.get("variant_id"),
                "hgvs": v.get("hgvs"),
                "rsid": v.get("rsid"),
                "condition": v.get("condition"),
                "review_status": v.get("review_status"),
            })
    if not weak:
        return []
    return [_finding(
        kind="unsupported_assertions",
        severity="medium",
        headline=f"{len(weak)} pathogenic call{'s' if len(weak) != 1 else ''} with no assertion criteria",
        detail=(
            "These are classified pathogenic by a submitter who did not record "
            "how they reached it. They carry the same label as expert-panel "
            "calls and considerably less weight."
        ),
        evidence=weak[:20],
        sources=["ClinVar"],
    )]


def frequency_conflicts(variants: Optional[list], prevalence: Optional[list]) -> list[dict]:
    """Pathogenic calls too common in the population to fit the stated prevalence.

    The published approach (Whiffin et al. 2017): a variant causing a disease of
    prevalence P cannot itself be much more common than P. This is deliberately
    crude — it uses the **upper** bound of Orphanet's band and assumes a single
    variant could account for the whole disease, both of which make it *harder*
    to flag something. A finding here means the frequency is hard to reconcile
    even on the most generous reading.

    Yields nothing when per-variant frequency is absent, which is common: ClinVar
    summaries do not always carry one. Silence here means "not checkable", never
    "nothing wrong" — and the caller must not present it as a clean bill.
    """
    ceiling = _prevalence_ceiling(prevalence)
    if ceiling is None:
        return []

    hits = []
    for v in variants or []:
        if not isinstance(v, dict):
            continue
        freq = v.get("frequency")
        if not isinstance(freq, (int, float)) or freq <= 0:
            continue
        if not _is_pathogenic(_sig(v)):
            continue
        if freq > ceiling:
            hits.append({
                "variant_id": v.get("variant_id"),
                "hgvs": v.get("hgvs"),
                "rsid": v.get("rsid"),
                "frequency": freq,
                "population": v.get("population"),
                "max_credible": ceiling,
                "excess_fold": round(freq / ceiling, 1),
            })
    if not hits:
        return []
    hits.sort(key=lambda h: -h["excess_fold"])
    return [_finding(
        kind="frequency_conflict",
        severity="high",
        headline=f"{len(hits)} pathogenic call{'s' if len(hits) != 1 else ''} more common than the disease",
        detail=(
            f"Orphanet puts prevalence at no more than {ceiling:.2g}. A variant "
            "causing that disease cannot be much more common than the disease "
            "itself, so these are hard to reconcile — the usual explanation is a "
            "classification that predates population-scale frequency data."
        ),
        evidence=hits[:20],
        sources=["ClinVar", "Orphanet"],
    )]


def _prevalence_ceiling(prevalence: Optional[list]) -> Optional[float]:
    """Upper bound of Orphanet's prevalence band, as a fraction.

    The upper bound on purpose: it is the generous reading, so anything flagged
    against it is flagged on the disease's own best case. Bands look like
    "1-9 / 100 000" or "1-5 / 10 000".
    """
    import re
    best = None
    for row in prevalence or []:
        if not isinstance(row, dict):
            continue
        band = str(row.get("band") or "")
        m = re.search(r"([\d.]+)\s*-\s*([\d.]+)\s*/\s*([\d\s]+)", band.replace(",", ""))
        if not m:
            m2 = re.search(r"([\d.]+)\s*/\s*([\d\s]+)", band.replace(",", ""))
            if not m2:
                continue
            num, denom = float(m2.group(1)), float(m2.group(2).replace(" ", ""))
        else:
            num, denom = float(m.group(2)), float(m.group(3).replace(" ", ""))
        if denom <= 0:
            continue
        value = num / denom
        best = value if best is None else max(best, value)
    return best


# Highest-signal first. Curator disagreement leads because it is the one that
# most often points at publishable work rather than at a data-quality artefact.
_ANALYSES = ("frequency_conflict", "curator_disagreement", "unsupported_assertions",
             "constraint_tension", "stale_evidence")
_SEVERITY = {"high": 0, "medium": 1, "low": 2}


def research_findings(pipeline: Optional[dict], today: Optional[date] = None) -> dict:
    """Every cross-source finding for one gene, ranked.

    `checked` names the analyses that ran and `skipped` those whose inputs were
    absent — the distinction the upstream-drift audit exists to preserve. An
    empty `findings` with a populated `skipped` means "could not look", which is
    not the same as "nothing found", and the interface must not render them
    alike.
    """
    data = pipeline if isinstance(pipeline, dict) else {}
    variants = data.get("variants") or []

    produced, checked, skipped = [], [], []

    def run(name, fn, *inputs):
        if not any(inputs):
            skipped.append(name)
            return
        checked.append(name)
        produced.extend(fn())

    run("frequency_conflict", lambda: frequency_conflicts(variants, data.get("prevalence")),
        variants, data.get("prevalence"))
    run("curator_disagreement", lambda: curator_disagreement(data.get("gencc")),
        data.get("gencc"))
    run("unsupported_assertions", lambda: unsupported_assertions(variants), variants)
    run("constraint_tension", lambda: constraint_tension(data.get("constraint"), variants),
        data.get("constraint"), variants)
    run("stale_evidence", lambda: stale_evidence(data.get("clingen"), today),
        data.get("clingen"))

    produced.sort(key=lambda f: (_SEVERITY.get(f["severity"], 3),
                                 _ANALYSES.index(f["kind"]) if f["kind"] in _ANALYSES else 99))
    return {
        "findings": produced,
        "checked": checked,
        "skipped": skipped,
        "gene": data.get("gene_symbol") or data.get("gene"),
    }
