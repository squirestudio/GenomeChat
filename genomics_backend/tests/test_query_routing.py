"""Which pipeline a question reaches.

This file exists because of a bug that no other test could have caught: it
lived in the model's tool-calling behaviour, not in our branching. Asked "what
is hypotonia", Haiku answered in prose instead of calling a tool — 10 times out
of 10 — and the loop over `response.content`, finding no `tool_use` block, fell
through to the regex heuristic and returned UNKNOWN. `/chat` then routed a
question with a real answer (ClinVar returns 20 genes for hypotonia; HPO lists
1,956) to `answer_followup`, which runs no pipeline at all.

The same failure hit "what is ataxia" about 1 time in 10, so the symptom was an
occasional answer that arrived thin for no visible reason and worked on retry.

Two properties are asserted here, and the cheap ones deliberately run in CI:

  - a tool call is *forced*, so "no tool call" can never silently mean UNKNOWN
  - phenotypes are lookups, not conversation — phrasing must not decide routing
"""
import asyncio
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

import pytest

from models import QueryType
from services.query_interpreter import TOOLS, _fallback_interpret, interpret_query


def _tool(name):
    return next((t for t in TOOLS if t["name"] == name), None)


def _block(name, **inp):
    """A stand-in for one anthropic tool_use content block."""
    b = type("Block", (), {})()
    b.type, b.name, b.input = "tool_use", name, inp
    return b


def _reply(*blocks):
    r = type("Reply", (), {})()
    r.content = list(blocks)
    return r


def _mock_anthropic(reply):
    """Patch the async client so routing can be tested without the network.

    The settings patch is not incidental. `interpret_query` returns the regex
    fallback immediately when no API key is configured, and CI runs without one
    — so without this the mocked client is never reached and these tests pass
    locally while failing on every push.
    """
    client = type("Client", (), {})()
    client.messages = type("Messages", (), {})()
    client.messages.create = AsyncMock(return_value=reply)

    settings = type("Settings", (), {})()
    settings.anthropic_api_key = "sk-ant-test-not-a-real-key"

    stack = ExitStack()
    stack.enter_context(patch("services.query_interpreter.get_settings", return_value=settings))
    stack.enter_context(patch("services.query_interpreter.anthropic.AsyncAnthropic",
                              return_value=client))
    return stack, client


# ── the registry ─────────────────────────────────────────────────────────────

def test_a_followup_tool_exists():
    """Forcing a tool call is only safe because there is somewhere to put a
    conversational turn. Without this tool, tool_choice would shove "what does
    that mean?" into a gene lookup and break every follow-up in the app."""
    assert _tool("interpret_followup_query") is not None


def test_the_disease_tool_still_claims_phenotypes():
    """Narrowing this description back to diseases is what caused the bug: a
    clinical sign is not a disease, and the model classified it accordingly."""
    desc = _tool("interpret_disease_query")["description"].lower()
    assert "phenotype" in desc
    for sign in ("hypotonia", "ataxia"):
        assert sign in desc, f"{sign} is the regression case; keep it named"


# ── the forced tool call ─────────────────────────────────────────────────────

def test_a_tool_call_is_forced():
    patcher, client = _mock_anthropic(_reply(_block("interpret_disease_query", disease_name="hypotonia")))
    with patcher:
        asyncio.run(interpret_query("what is hypotonia"))
    assert client.messages.create.await_args.kwargs["tool_choice"] == {"type": "any"}, \
        "without this the model may answer in prose and the query silently becomes UNKNOWN"


def test_a_prose_reply_still_degrades_rather_than_crashing():
    """Belt and braces: tool_choice should make this unreachable, but if it is
    ever removed the endpoint must not hard-fail on interpretation."""
    text = type("Block", (), {})()
    text.type = "text"
    patcher, _ = _mock_anthropic(_reply(text))
    with patcher:
        result = asyncio.run(interpret_query("what is hypotonia"))
    # The heuristic now knows the word, so even this path routes it correctly.
    assert result.query_type == QueryType.DISEASE_QUERY


def test_a_deliberate_followup_is_distinguishable_from_a_failure():
    """Both reach UNKNOWN and both go to answer_followup — correctly. The
    confidence is what separates "this is conversation" from "interpretation
    broke", and they used to be indistinguishable in logs and metrics."""
    patcher, _ = _mock_anthropic(_reply(_block("interpret_followup_query", reason="refers to prior turn")))
    with patcher:
        routed = asyncio.run(interpret_query("what does that mean?"))
    assert routed.query_type == QueryType.UNKNOWN
    assert routed.confidence == 0.9
    assert _fallback_interpret("what does that mean?").confidence == 0.2


# ── the heuristic fallback ───────────────────────────────────────────────────

@pytest.mark.parametrize("query", [
    "hypotonia",
    "what is hypotonia",
    "tell me about hypotonia",
    "hypotonia genes",
    "what is ataxia",
    "nystagmus",
    "what causes developmental delay",
])
def test_phenotype_phrasings_all_reach_the_disease_pipeline(query):
    """Phrasing must never decide the route. Before the fix the heuristic
    answered "syndromic hypotonia" and gave up on "hypotonia"."""
    assert _fallback_interpret(query).query_type == QueryType.DISEASE_QUERY


def test_conversation_is_not_mistaken_for_a_lookup():
    for chatty in ["what does that mean?", "explain the second one", "thanks!"]:
        assert _fallback_interpret(chatty).query_type == QueryType.UNKNOWN


def test_genes_and_comparisons_still_route_as_before():
    assert _fallback_interpret("BRCA1 variants").query_type == QueryType.GENE_QUERY
    assert _fallback_interpret("compare BRCA1 and BRCA2").query_type == QueryType.COMPARISON_QUERY


# ── against the real model ───────────────────────────────────────────────────

@pytest.mark.external
@pytest.mark.parametrize("query", ["what is hypotonia", "hypotonia", "tell me about hypotonia"])
def test_hypotonia_reaches_the_pipeline_for_real(query):
    """The original bug, end to end. 'what is hypotonia' failed 10/10 before."""
    result = asyncio.run(interpret_query(query))
    assert result.query_type == QueryType.DISEASE_QUERY
    assert "hypotonia" in result.target.lower()


@pytest.mark.external
def test_a_real_followup_still_reaches_the_conversational_path():
    """The other half of the forced tool call: this must NOT become a lookup."""
    result = asyncio.run(interpret_query("what does that mean?"))
    assert result.query_type == QueryType.UNKNOWN
