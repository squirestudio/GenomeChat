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


@pytest.mark.parametrize("level", ["plain", "clinical"])
def test_the_two_live_levels_exist(level):
    assert level in READING_LEVEL_INSTRUCTIONS


def test_the_old_technical_value_still_means_clinical():
    """The setting was three options and is now two. A browser that has not
    reloaded still sends "technical", and letting that fall through to the
    default would quietly downgrade a clinician's answer to plain language."""
    assert READING_LEVEL_INSTRUCTIONS["technical"] == READING_LEVEL_INSTRUCTIONS["clinical"]


def test_the_old_standard_value_is_still_accepted():
    """It maps to no override, which is right: the base prompt is now aimed at
    a non-specialist adult anyway. What matters is that it does not KeyError."""
    assert READING_LEVEL_INSTRUCTIONS["standard"] == ""


def test_plain_simplifies_language_and_not_the_facts():
    """The distinction that keeps this honest: dropping a caveat to shorten a
    sentence would be simplifying the finding, not the wording."""
    plain = READING_LEVEL_INSTRUCTIONS["plain"].lower()
    assert "do not simplify the facts" in plain
    assert "never round a number or drop a caveat" in plain


def test_plain_is_a_real_override_not_a_no_op():
    """Plain is the default and must actually instruct, or the default does
    nothing and the base prompt decides everything."""
    assert READING_LEVEL_INSTRUCTIONS["plain"].strip() != ""


@pytest.mark.parametrize("builder", ["explanation", "followup"])
def test_the_level_reaches_the_prompt(builder):
    if builder == "explanation":
        msgs = build_explanation_messages("BRCA1", "gene_query", {}, reading_level="clinical")
    else:
        msgs = build_followup_messages("what does that mean", [], reading_level="clinical")
    assert "LANGUAGE:" in msgs[-1]["content"]
    assert "clinician or researcher" in msgs[-1]["content"]


def test_plain_is_the_default_when_nothing_is_passed():
    msgs = build_followup_messages("what does that mean", [])
    assert "no biology background" in msgs[-1]["content"]


def test_detail_and_reading_level_are_independent():
    """Both must be able to apply at once — a short technical answer is a real
    thing to want, and so is a long plain one."""
    msgs = build_explanation_messages("BRCA1", "gene_query", {},
                                      response_detail="concise", reading_level="clinical")
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


def test_every_env_var_the_code_reads_is_declared_in_settings():
    """Settings forbids extras, and pydantic treats the two config sources
    asymmetrically: it pulls only *declared* fields from OS environment
    variables, but loads **every** key out of a .env file and hands them all to
    the model. So an undeclared variable works fine in production — where
    Railway injects real env vars — and crash-loops the app the moment someone
    adds the same line to their local .env.

    NCBI_API_KEY did exactly that. It is read via os.environ in
    genomics_api_real, was set in Railway for weeks, and took the container
    down on boot the first time it was written into a .env file.
    """
    import pathlib
    import re

    from config import Settings

    root = pathlib.Path(__file__).resolve().parent.parent
    declared = {f.upper() for f in Settings.model_fields}
    read = set()
    for path in root.rglob("*.py"):
        if "test" in path.parts or path.name.startswith("test_"):
            continue
        for m in re.finditer(r"os\.environ(?:\.get)?\(\s*[\"']([A-Z_]+)[\"']", path.read_text()):
            read.add(m.group(1))

    # Variables the app reads but never declares. PORT and friends are set by
    # the platform and never appear in a .env, so they are exempt.
    PLATFORM = {"PORT", "PATH", "HOME", "RAILWAY_ENVIRONMENT", "PYTHONPATH",
                "MYDNA_TEST_BASE_URL", "STRIPE_TEST_KEY", "DATABASE_URL"}
    missing = sorted(read - declared - PLATFORM)
    assert not missing, (
        f"read from os.environ but not declared in Settings: {missing}. "
        "Adding any of these to a .env file will crash the app on boot."
    )
