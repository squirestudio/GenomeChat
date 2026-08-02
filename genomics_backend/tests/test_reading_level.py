"""How hard the words are, and why it is a separate axis from how much is said.

The prompt used to ask for prose "accessible to a research scientist", which is
who it then wrote for — a reader looking up their own gene met "ablate" and
"penetrance" unglossed. Detail and reading level were also conflated: a worried
parent wanting a short answer and a clinician wanting a short answer need the
same length and very different language.
"""
import re

import pytest

from services.ai_explainer import (
    READING_LEVEL_INSTRUCTIONS,
    SYSTEM_PROMPT,
    build_explanation_messages,
    build_followup_messages,
)


def test_the_base_prompt_no_longer_writes_for_a_specialist():
    flat = " ".join(SYSTEM_PROMPT.lower().split())
    assert "accessible to a research scientist" not in flat, \
        "this line is why answers read like a paper"
    assert "not a geneticist" in flat


def test_the_prompt_names_the_words_to_avoid():
    """'Ablate' is the specific word that prompted this; keeping the examples
    concrete is what makes the instruction actionable rather than aspirational."""
    flat = " ".join(SYSTEM_PROMPT.lower().split())
    assert "ablat" in flat and "penetrance" in flat


@pytest.mark.parametrize("level", ["plain", "standard", "technical"])
def test_every_level_exists(level):
    assert level in READING_LEVEL_INSTRUCTIONS


def test_plain_simplifies_language_and_not_the_facts():
    """The distinction that keeps this honest: dropping a caveat to shorten a
    sentence would be simplifying the finding, not the wording."""
    plain = READING_LEVEL_INSTRUCTIONS["plain"].lower()
    assert "do not simplify the facts" in plain
    assert "never round a number or drop a caveat" in plain


def test_standard_adds_nothing_so_the_base_prompt_stands():
    assert READING_LEVEL_INSTRUCTIONS["standard"] == ""


@pytest.mark.parametrize("builder", ["explanation", "followup"])
def test_the_level_reaches_the_prompt(builder):
    if builder == "explanation":
        msgs = build_explanation_messages("BRCA1", "gene_query", {}, reading_level="technical")
    else:
        msgs = build_followup_messages("what does that mean", [], reading_level="technical")
    assert "LANGUAGE:" in msgs[-1]["content"]
    assert "clinician or researcher" in msgs[-1]["content"]


def test_plain_is_the_default_when_nothing_is_passed():
    msgs = build_followup_messages("what does that mean", [])
    assert "no biology background" in msgs[-1]["content"]


def test_detail_and_reading_level_are_independent():
    """Both must be able to apply at once — a short technical answer is a real
    thing to want, and so is a long plain one."""
    msgs = build_explanation_messages("BRCA1", "gene_query", {},
                                      response_detail="concise", reading_level="technical")
    body = msgs[-1]["content"]
    assert "INSTRUCTION:" in body and "LANGUAGE:" in body


def test_the_answer_cache_is_keyed_on_the_answer_shape():
    """The cache keyed on the question alone, so the first reader's settings
    decided everyone's answer for 24 hours: asking for technical returned
    whatever plain reply happened to be cached, with nothing to indicate it."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parent.parent / "main.py").read_text()
    key = re.search(r"cache_key = f\"(.*?)\"", src)
    assert key, "the streaming cache key moved — re-point this test, do not delete it"
    assert "response_detail" in key.group(1)
    assert "reading_level" in key.group(1)
