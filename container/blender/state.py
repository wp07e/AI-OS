"""
state.json + memory.md writer for the Blender pipeline.

Mirrors container/video/state.py: writes the workflow state the canvas polls
(phase, lease, scene, renders, errors) and the resume handoff. The shape
matches what the web canvas (useBlenderState.ts) parses — see
web/src/app/app/(workflow)/blender/types.ts.

state.json is merged at each phase boundary so omitted fields survive. Absence
is non-fatal per the shell contract (canvas shows "working…" and keeps polling),
but this module always writes a complete file so the canvas renders richly.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def read_state(instance_folder: str) -> dict[str, Any]:
    """Read state.json, returning {} if absent/invalid (never raises)."""
    path = os.path.join(instance_folder, "state.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_state(
    instance_folder: str,
    phase: str,
    *,
    errors: list[str] | None = None,
    active: dict[str, Any] | None = None,
    lease: dict[str, Any] | None = None,
    scene: dict[str, Any] | None = None,
    renders: list[dict[str, Any]] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Merge state.json with the provided fields (overwrites on field conflicts).

    Existing fields are preserved unless overridden here, so a caller that wants
    to update only `phase`/`lease` does not silently drop `renders`. A field set
    to ``None`` explicitly clears it. `phase` and `lastUpdated` are always set.

    NOTE: `errors`, when provided, *replaces* the existing list. `active=None`
    clears the in-flight marker.
    """
    state = read_state(instance_folder)

    state["phase"] = phase
    state["lastUpdated"] = _now_iso()

    if errors is not None:
        state["errors"] = errors
    else:
        state.setdefault("errors", [])

    if active is not None:
        state["active"] = active
    elif "active" in state:
        state["active"] = None

    if lease is not None:
        state["lease"] = lease
    if scene is not None:
        state["scene"] = scene
    if renders is not None:
        state["renders"] = renders

    if extra:
        for k, v in extra.items():
            if v is None:
                state.pop(k, None)
            else:
                state[k] = v

    path = os.path.join(instance_folder, "state.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)
    return state


def append_memory(instance_folder: str, note: str) -> None:
    """Append a short handoff note to memory.md (creates if absent)."""
    path = os.path.join(instance_folder, "memory.md")
    stamp = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    line = f"\n## {stamp}\n\n{note}\n"
    mode = "a" if os.path.exists(path) else "w"
    with open(path, mode, encoding="utf-8") as f:
        f.write(line)


def next_render_number(renders: list[dict[str, Any]]) -> int:
    """Next 1-based number for a render (render-NN)."""
    return len(renders) + 1


def render_num(n: int) -> str:
    """Zero-padded number for filenames: render-01, render-02, ..."""
    return str(n).zfill(2)
