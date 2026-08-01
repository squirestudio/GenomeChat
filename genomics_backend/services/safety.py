"""The line between explaining data and diagnosing a person.

MyDNA states plainly that it is not a medical service. Uploaded documents make
that harder to hold: a reader who brings their own genome *and* a paper about
their own condition is one sentence away from asking "so do I have it?", and a
model handed both will happily answer unless told not to.

The rule is not silence. Refusing to engage would be both unhelpful and
faintly dishonest, since the gene–phenotype relationship in the paper is a real
fact that the reader is entitled to. So a diagnostic question is answered by
**restating the relationship in the data and naming the limit** — what is
associated with what, in whose cohort, at what strength — followed by the
reminder that none of it is a finding about them.

Two guards, deliberately independent, because a single one that misses ships a
diagnosis:

  input   detect_diagnostic_intent() reads the question before generation and
          injects a reframing directive when it finds first-person clinical
          intent.
  output  NO_DIAGNOSIS_RULES is always in the system prompt, whether or not
          the input guard fired.

The input guard is the one that can be wrong in both directions, so it is
tuned to leave factual questions alone: "do I have the rs334 variant" is a
question about the reader's own uploaded file and has a true answer, while "do
I have sickle cell" is a request for a diagnosis. The difference is only ever
what follows the verb.
"""
import re

# Questions of the form "do I have X" where X is explicitly a variant are
# lookups against the reader's own uploaded file, and have a true answer.
#
# Deliberately narrow: matching bare uppercase tokens as gene symbols was tried
# and is wrong, because disease abbreviations wear the same clothes. "Do I have
# OI" would read as a gene symbol and escape the guard, and DMD is *both* a gene
# and Duchenne muscular dystrophy. A missed diagnosis question is the costly
# error here, so the object must name a variant in so many words.
_FACTUAL_OBJECT = re.compile(
    r"\b(rs\d+|variants?|alleles?|genotypes?|mutations?|snps?|markers?|"
    r"polymorphisms?|c\.\d+|p\.[A-Z][a-z]{2}\d+)\b",
    re.IGNORECASE,
)

# First-person (or immediate-family) clinical intent. Each pattern is written to
# need a personal subject: "is this treatable" is a general question about a
# condition, "am I going to need treatment" is not.
# Order matters: the first match wins, so narrower phrasings come first.
# "how long do i have" also matches the generic "do i have" and would otherwise
# be reported as a diagnosis question rather than a prognosis one. It is caught
# either way — only the wording of the reframe differs — but the reframe is the
# whole point, so it should be the right one.
_DIAGNOSTIC_PATTERNS = [
    (r"\bhow\s+long\s+(?:do|have)\s+i\b", "prognosis"),
    (r"\bdo\s+i\s+need\s+(?:surgery|treatment|a\s+doctor|to\s+worry)\b", "treatment"),
    (r"\bdo(?:es)?\s+(?:i|my|our)\b.{0,30}\bhave\b", "diagnosis"),
    (r"\bdo\s+i\s+have\b", "diagnosis"),
    (r"\bam\s+i\s+(?:going\s+to|likely\s+to|at\s+risk|a\s+carrier|going\s+to\s+get)\b", "risk"),
    (r"\bwill\s+i\s+(?:get|develop|have|pass|die|need)\b", "prognosis"),
    (r"\bwill\s+my\s+(?:child|son|daughter|baby|kids?|children)\b", "prognosis"),
    (r"\bis\s+(?:this|that|it)\s+why\s+i\b", "diagnosis"),
    (r"\bdoes\s+this\s+mean\s+i\b", "diagnosis"),
    (r"\b(?:what|which)\s+(?:treatment|drug|dose|medication|therapy)\s+should\s+i\b", "treatment"),
    (r"\bshould\s+i\s+(?:take|stop|start|switch|avoid|get\s+tested|see\s+a)\b", "treatment"),
    (r"\bis\s+it\s+safe\s+for\s+(?:me|my)\b", "treatment"),
    (r"\bhow\s+long\s+(?:do|have)\s+i\b", "prognosis"),
    (r"\bdiagnose\s+(?:me|my)\b", "diagnosis"),
    (r"\bwhat(?:'s|\s+is)\s+wrong\s+with\s+(?:me|my)\b", "diagnosis"),
    (r"\bdo\s+i\s+need\s+(?:surgery|treatment|a\s+doctor|to\s+worry)\b", "treatment"),
]
_COMPILED = [(re.compile(p, re.IGNORECASE), kind) for p, kind in _DIAGNOSTIC_PATTERNS]


def detect_diagnostic_intent(question: str) -> str | None:
    """The kind of clinical conclusion being asked for, or None.

    Returns one of "diagnosis", "risk", "prognosis", "treatment". A question
    that asks after a specific variant is never diagnostic, because the reader
    is asking what is in the file they uploaded.
    """
    if not question:
        return None

    for pattern, kind in _COMPILED:
        m = pattern.search(question)
        if not m:
            continue
        # "do I have the BRCA1 c.68_69del variant" — a lookup. Only the span
        # after the matched verb counts: the condition may be named later in a
        # genuinely diagnostic question too.
        if kind == "diagnosis" and _FACTUAL_OBJECT.search(question[m.end():]):
            continue
        return kind
    return None


# What the model is told when the input guard fires. Phrased as a redirection
# rather than a refusal: the reader asked a reasonable question and there is a
# real answer nearby, so give them that answer and be explicit about the gap
# between it and what they asked.
_REFRAME = {
    "diagnosis": (
        "The reader is asking whether they have a condition. You cannot answer that and "
        "must not imply an answer. Instead: state what the data actually shows — which "
        "variants are present in their file, which genes and phenotypes those are "
        "associated with in the sources, and how strong that association is. Then say "
        "plainly that an association is not a diagnosis, that a genotype does not "
        "establish a phenotype in any individual, and that only a clinician who can "
        "examine them can answer what they asked."
    ),
    "risk": (
        "The reader is asking for a personal risk estimate. Give population-level "
        "figures only, always attributed and always as a group statistic — 'carriers in "
        "this cohort showed X' — and state that a population frequency is not a personal "
        "probability. Do not compute, imply or endorse a number for this individual."
    ),
    "prognosis": (
        "The reader is asking what will happen to them or to a family member. Describe "
        "only what the literature reports about the condition in general, attributed to "
        "its source. State that MyDNA cannot forecast an individual course and that "
        "prognosis requires clinical assessment."
    ),
    "treatment": (
        "The reader is asking for a treatment decision. Do not give one, and do not "
        "endorse, discourage, or rank any drug, dose or procedure for them. You may "
        "describe documented gene–drug relationships as published facts. Say clearly "
        "that treatment decisions require a prescribing clinician who knows their full "
        "history, and that pharmacogenomic guidance is written for clinicians to apply, "
        "not for patients to self-administer."
    ),
}

_CLOSING_REMINDER = (
    "End with: \"This is an educational summary of published data, not a diagnosis or "
    "medical advice. Only a licensed clinician or genetic counselor can interpret what "
    "any of this means for you.\""
)


def reframe_directive(kind: str | None) -> str:
    """The instruction to append to the user turn, or "" when nothing fired."""
    if not kind or kind not in _REFRAME:
        return ""
    return f"CLINICAL SAFETY INSTRUCTION: {_REFRAME[kind]} {_CLOSING_REMINDER}"


# The output-side guard. Always present, regardless of the input guard, and
# written as constraints on the *conclusion* rather than on the topic — the
# subject matter is legitimate and the reader came for it. What is forbidden is
# collapsing a population-level association into a statement about the person.
NO_DIAGNOSIS_RULES = """
## Non-negotiable limits

MyDNA explains published data and the relationships within it. It never
diagnoses, and never advises on treatment. These hold in every answer, and they
hold most tightly when the reader has uploaded their own DNA or their own
documents — that combination is what makes overreach easy.

- **State relationships, never conclusions about the person.** "Variants in
  TMEM38B are associated with osteogenesis imperfecta, and hypotonia and ataxia
  were the most frequently reported neural symptoms in this cohort" is correct.
  "You have osteogenesis imperfecta" is not, and neither is "this explains your
  symptoms" or "you are likely to develop this".
- **A genotype is not a phenotype.** Carrying a variant reported in a condition
  is not having the condition. Penetrance is usually incomplete, usually
  unquantified, and never established by a single paper.
- **Attribute everything.** Every clinical claim names its source — the
  database, or the uploaded document by title and author. If a claim rests on a
  single small study, say so, including the cohort size.
- **Distinguish the reader's data from the literature.** Say which statements
  come from their uploaded file and which come from published work on other
  people. Never merge them into one voice.
- **No treatment guidance.** Documented gene–drug relationships may be
  described as published facts. Whether the reader should take, stop or change
  anything is a question for their prescriber, and you say so rather than
  answering it.
- **Uncertainty is information.** If the data does not support an answer, say
  that. A hedge dressed as a finding is worse than an honest "this is not
  known".
""".strip()
