"""The guard that keeps MyDNA on the right side of "not a medical service".

Uploaded documents are what make this urgent: a reader holding their own genome
and a paper about their own condition is one sentence from asking for a
diagnosis, and the model will answer unless stopped.

Both directions are tested, because both are real failures. Missing a
diagnostic question ships a diagnosis. Flagging a factual one — "do I have the
rs334 variant", a question about the reader's own file with a true answer —
turns the product into a wall of disclaimers and teaches people to ignore them.
"""
import pytest

from services.safety import (
    NO_DIAGNOSIS_RULES,
    detect_diagnostic_intent,
    reframe_directive,
)


# ── questions that must be caught ────────────────────────────────────────────

@pytest.mark.parametrize("question,kind", [
    ("Do I have osteogenesis imperfecta?", "diagnosis"),
    ("do i have OI", "diagnosis"),
    ("Does my son have this condition?", "diagnosis"),
    ("Is this why I'm always tired?", "diagnosis"),
    ("Does this mean I have the disease?", "diagnosis"),
    ("diagnose me based on my DNA", "diagnosis"),
    ("what's wrong with me", "diagnosis"),
    ("Am I at risk for this?", "risk"),
    ("Am I a carrier?", "risk"),
    ("Will I develop ataxia?", "prognosis"),
    ("Will my child have hypotonia?", "prognosis"),
    ("how long do i have", "prognosis"),
    ("What treatment should I take?", "treatment"),
    ("Should I stop taking clopidogrel?", "treatment"),
    ("should i see a specialist", "treatment"),
    ("Is it safe for me to take this drug?", "treatment"),
    ("Do I need surgery?", "treatment"),
])
def test_clinical_questions_are_caught(question, kind):
    assert detect_diagnostic_intent(question) == kind


def test_a_disease_abbreviation_is_not_mistaken_for_a_gene():
    """OI, MS, CF and DMD look exactly like gene symbols, and DMD *is* one.
    Treating uppercase tokens as evidence of a variant lookup let 'do I have OI'
    slip the guard entirely."""
    for abbrev in ["OI", "ALS", "MS", "CF", "SMA", "DMD"]:
        assert detect_diagnostic_intent(f"do I have {abbrev}") == "diagnosis"


# ── questions that must NOT be caught ────────────────────────────────────────

@pytest.mark.parametrize("question", [
    "Do I have the rs334 variant?",
    "do i have any variants in COL1A1",
    "Do I have a mutation in TMEM38B?",
    "do i have the c.507 allele",
    "Do I have any pathogenic SNPs in this gene?",
])
def test_questions_about_the_uploaded_file_are_left_alone(question):
    """These ask what is in the reader's own data. They have true answers and
    disclaiming them would be both unhelpful and slightly dishonest."""
    assert detect_diagnostic_intent(question) is None


@pytest.mark.parametrize("question", [
    "What is hypotonia?",
    "Is osteogenesis imperfecta treatable?",
    "What genes are associated with ataxia?",
    "How does WNT1 affect bone mineralization?",
    "Compare BRCA1 and BRCA2",
    "What does that mean?",
    "",
])
def test_general_questions_are_left_alone(question):
    """The subject matter is legitimate — the reader came for it. Only a
    personal clinical conclusion is off limits."""
    assert detect_diagnostic_intent(question) is None


def test_it_is_safe_on_nothing():
    assert detect_diagnostic_intent(None) is None


# ── what the model is told ───────────────────────────────────────────────────

def test_the_reframe_redirects_rather_than_refuses():
    """The reader asked something reasonable and there is a real answer nearby.
    Refusing outright would be unhelpful; the directive must ask for the data
    relationship, not silence."""
    d = reframe_directive("diagnosis")
    assert "state what the data actually shows" in d.lower()
    assert "not a diagnosis" in d.lower()


@pytest.mark.parametrize("kind", ["diagnosis", "risk", "prognosis", "treatment"])
def test_every_kind_carries_the_reminder(kind):
    assert "licensed clinician or genetic counselor" in reframe_directive(kind)


def test_nothing_is_injected_when_nothing_fired():
    assert reframe_directive(None) == ""
    assert reframe_directive("unrecognised") == ""


def test_the_output_guard_stands_alone():
    """It is in the system prompt on every request, whether or not the input
    guard fired — two independent guards, so one miss does not ship."""
    # Whitespace-normalised: the prompt is hard-wrapped for readability and a
    # rewrap should not fail the test.
    rules = " ".join(NO_DIAGNOSIS_RULES.lower().split())
    assert "never diagnoses" in rules
    assert "genotype is not a phenotype" in rules
    assert "no treatment guidance" in rules
    assert "attribute everything" in rules
