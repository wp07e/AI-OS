"""
state.json + memory.md writer for the carousel pipeline.

Writes the workflow state the canvas polls (phase, slides[], design, candidates,
errors) and the resume handoff. The shape matches what the web canvas
(useCarouselState.ts) parses — see project memory "canva-mcp-full-pipeline-contract"
and the carousel types.

state.json is overwritten at each phase boundary. Absence is non-fatal per the
shell contract (canvas shows "working…" and keeps polling), but this module
always writes a complete file so the canvas renders richly.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_state(
    instance_folder: str,
    phase: str,
    *,
    errors: list[str] | None = None,
    brief: dict[str, Any] | None = None,
    slides: list[dict[str, Any]] | None = None,
    design: dict[str, Any] | None = None,
    candidates: list[dict[str, Any]] | None = None,
    mode: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Write state.json (overwrites). All optional fields are merged if provided."""
    state: dict[str, Any] = {
        "phase": phase,
        "lastUpdated": _now_iso(),
        "errors": errors or [],
    }
    if mode is not None:
        state["mode"] = mode
    if brief is not None:
        state["brief"] = brief
    if slides is not None:
        state["slides"] = slides
    if design is not None:
        state["design"] = design
    if candidates is not None:
        state["candidates"] = candidates
    if extra:
        state.update(extra)

    path = os.path.join(instance_folder, "state.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)  # atomic — canvas never reads a half-written file


def append_error(instance_folder: str, message: str, *, phase: str | None = None) -> None:
    """Append an error to the existing state.json without clobbering other fields.

    Reads the current state, appends to errors[], optionally updates phase, writes back.
    Used when a step fails mid-pipeline.
    """
    path = os.path.join(instance_folder, "state.json")
    state: dict[str, Any] = {}
    try:
        with open(path) as f:
            state = json.load(f)
    except (OSError, json.JSONDecodeError):
        state = {"phase": phase or "error", "lastUpdated": _now_iso(), "errors": []}
    if phase is not None:
        state["phase"] = phase
    state.setdefault("errors", []).append(message)
    state["lastUpdated"] = _now_iso()
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)


def write_memory(
    instance_folder: str,
    *,
    title: str,
    status: str,
    decisions: list[str] | None = None,
    resume_here: str = "",
    notes: list[str] | None = None,
    design_ids: list[str] | None = None,
) -> None:
    """Write/overwrite memory.md with a resume handoff (per /workspace/AGENTS.md contract)."""
    lines = [f"# {title}", "", "## Status", status, ""]
    if design_ids:
        lines.append("## Design IDs")
        for did in design_ids:
            lines.append(f"- {did}")
        lines.append("")
    if decisions:
        lines.append("## Decisions")
        for d in decisions:
            lines.append(f"- {d}")
        lines.append("")
    if resume_here:
        lines.append("## Resume Here")
        lines.append(resume_here)
        lines.append("")
    if notes:
        lines.append("## Notes")
        for n in notes:
            lines.append(f"- {n}")
        lines.append("")
    path = os.path.join(instance_folder, "memory.md")
    with open(path, "w") as f:
        f.write("\n".join(lines))


def slide_state(
    index: int,
    *,
    headline: str = "",
    body: str = "",
    cta: str = "",
    archetype: str = "",
    design_id: str = "",
    render_path: str = "",
) -> dict[str, Any]:
    """Build a slides[] entry for state.json (matches CarouselSlide in types.ts)."""
    s: dict[str, Any] = {"index": index}
    if headline:
        s["headline"] = headline
    if body:
        s["body"] = body
    if cta:
        s["cta"] = cta
    if archetype:
        s["archetype"] = archetype
    if design_id:
        s["design_id"] = design_id
    if render_path:
        s["render_path"] = render_path
    return s


def candidate_state(
    *,
    candidate_id: str,
    url: str = "",
    thumbnail_url: str = "",
    slide_count: int = 0,
    selected: bool = False,
) -> dict[str, Any]:
    """Build a candidates[] entry for state.json (deck selection UX)."""
    c: dict[str, Any] = {"id": candidate_id}
    if url:
        c["url"] = url
    if thumbnail_url:
        c["thumbnailUrl"] = thumbnail_url
    if slide_count:
        c["slideCount"] = slide_count
    if selected:
        c["selected"] = True
    return c
