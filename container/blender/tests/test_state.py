"""Tests for the Blender state writer (state.py).

Run from container/blender/: uv run --extra dev pytest
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import state as S


@pytest.fixture
def folder(tmp_path: Path) -> str:
    """A fresh instance folder for each test."""
    return str(tmp_path)


def test_read_state_returns_empty_when_absent(folder: str) -> None:
    assert S.read_state(folder) == {}


def test_write_state_creates_file_with_required_fields(folder: str) -> None:
    S.write_state(folder, "gpu_ready")
    state = S.read_state(folder)
    assert state["phase"] == "gpu_ready"
    assert "lastUpdated" in state
    assert state["errors"] == []


def test_write_state_merges_without_clobbering(folder: str) -> None:
    S.write_state(folder, "gpu_ready", lease={"state": "ready", "gpu": "RTX 4060"})
    # A second write that touches only phase must preserve lease.
    S.write_state(folder, "rendering")
    state = S.read_state(folder)
    assert state["phase"] == "rendering"
    assert state["lease"] == {"state": "ready", "gpu": "RTX 4060"}


def test_write_state_errors_replace(folder: str) -> None:
    S.write_state(folder, "error", errors=["boom"])
    state = S.read_state(folder)
    assert state["errors"] == ["boom"]
    # A subsequent non-error write preserves the existing errors list.
    S.write_state(folder, "gpu_ready")
    assert S.read_state(folder)["errors"] == ["boom"]


def test_write_state_renders_replace(folder: str) -> None:
    S.write_state(folder, "complete", renders=[{"id": "r1"}])
    assert S.read_state(folder)["renders"] == [{"id": "r1"}]
    S.write_state(folder, "complete", renders=[{"id": "r1"}, {"id": "r2"}])
    assert len(S.read_state(folder)["renders"]) == 2


def test_append_memory_creates_then_appends(folder: str) -> None:
    S.append_memory(folder, "first note")
    S.append_memory(folder, "second note")
    text = (Path(folder) / "memory.md").read_text()
    assert "first note" in text
    assert "second note" in text


def test_next_render_number_and_padding(folder: str) -> None:
    assert S.next_render_number([]) == 1
    assert S.render_num(1) == "01"
    assert S.render_num(12) == "12"


def test_read_state_recovers_from_invalid_json(folder: str) -> None:
    (Path(folder) / "state.json").write_text("{not json")
    assert S.read_state(folder) == {}
