"""The prompt's view list must match what the renderer can actually draw.

A prompt advertising a view the frontend does not have produces a dangling
sentence and an apology box — the exact failure the grammar replaced.
"""
import pathlib
import re

import pytest

from services.ai_explainer import VIEW_INSTRUCTIONS, SYSTEM_PROMPT

_FRONTEND = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "src" / "views.js"

# The backend container mounts only `genomics_backend`, so the frontend source
# is not reachable from inside it. CI checks out the whole repository and runs
# pytest from the repo, where this does resolve — which is the run that matters,
# because drift between the two lists is exactly what this guards.
_cross_repo = pytest.mark.skipif(
    not _FRONTEND.exists(),
    reason="frontend/ is not mounted in the backend container; runs in CI",
)


def _views_the_frontend_knows():
    src = _FRONTEND.read_text()
    block = src[src.index("const VIEWS = {"):src.index("/** The fence the model writes. */")]
    return set(re.findall(r"^  ([a-z_]+): \{", block, re.M))


@_cross_repo
def test_every_advertised_view_exists_in_the_renderer():
    advertised = set(re.findall(r"^- `([a-z_]+)`", VIEW_INSTRUCTIONS, re.M))
    assert advertised, "the prompt lists no views"
    assert advertised <= _views_the_frontend_knows()


@_cross_repo
def test_every_renderable_view_is_advertised():
    """The other direction: a view nobody is told about is dead code."""
    advertised = set(re.findall(r"^- `([a-z_]+)`", VIEW_INSTRUCTIONS, re.M))
    assert _views_the_frontend_knows() <= advertised


def test_the_prompt_forbids_raw_html():
    """The bug this came from: the model wrote <details> because it had no
    other way to ask for structure, and the renderer printed the tags."""
    assert "Never write raw HTML" in VIEW_INSTRUCTIONS
    assert "<div>" in VIEW_INSTRUCTIONS


def test_the_prompt_forbids_data_inside_a_view_block():
    """A transcribed number reaching a chart looks as authoritative as a real one."""
    assert "Never put data inside the block" in VIEW_INSTRUCTIONS


@_cross_repo
def test_the_fence_name_matches_the_frontend():
    assert "mydna-view" in VIEW_INSTRUCTIONS
    assert "mydna-view" in _FRONTEND.read_text()


def test_view_instructions_reach_the_system_prompt():
    assert "mydna-view" in SYSTEM_PROMPT
