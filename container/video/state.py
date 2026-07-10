"""
state.json + memory.md writer for the video pipeline.

Writes the workflow state the canvas polls (phase, clips[], images[],
finalVideo, errors) and the resume handoff. The shape matches what the web
canvas (useVideoState.ts) parses — see web/src/app/app/(workflow)/video/types.ts.

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
    clips: list[dict[str, Any]] | None = None,
    images: list[dict[str, Any]] | None = None,
    final_video: dict[str, Any] | None = None,
    mode: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Merge state.json with the provided fields (overwrites on field conflicts).

    Existing fields are preserved unless overridden here, so a caller that wants
    to update only `clips`/`phase` does not silently drop `images`. A field set
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

    if clips is not None:
        state["clips"] = clips
    if images is not None:
        state["images"] = images
    if final_video is not None:
        state["finalVideo"] = final_video
    elif final_video is None and "finalVideo" in state and phase == "complete" and active is None:
        # Leave finalVideo alone on normal completion unless caller overrides.
        pass
    if mode is not None:
        state["mode"] = mode

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


def next_clip_index(clips: list[dict[str, Any]]) -> int:
    """Next 0-based index for a new clip."""
    if not clips:
        return 0
    return max(int(c.get("index", -1)) for c in clips) + 1


def next_image_number(images: list[dict[str, Any]]) -> int:
    """Next 1-based number for a generated image (img-NN)."""
    return len(images) + 1


def clip_num(index: int) -> str:
    """1-based zero-padded number for filenames: clip-01, clip-02, ..."""
    return str(index + 1).zfill(2)
