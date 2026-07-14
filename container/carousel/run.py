#!/usr/bin/env python3
"""
Carousel pipeline entry point.

Reads brief.json from an instance folder, runs the deterministic generation
pipeline (posts or deck mode), and writes state.json + memory.md at each step.

Usage:
  python3 run.py <instance_folder>                           # full generation
  python3 run.py <instance_folder> --selected-candidate <id> # deck resume

The agent (skill) writes brief.json then invokes this script. The agent does
NOT call Canva generation tools itself — this script owns that, deterministically.
Edits remain the agent's job (Phase 6 of the skill, via opencode tool-calling).

Exit codes: 0 = complete, 0 = paused (awaiting_candidate_selection), 1 = error.
Errors are written to state.json's errors[] before exiting so the canvas surfaces them.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from datetime import datetime, timezone


class _Tee:
    """Mirrors a stream (stdout/stderr) to a second file while keeping the
    original destination. Used to capture the pipeline's print() output to
    <instance>/pipeline.log, since opencode captures the script's stdout when
    it runs via a tool call (so docker logs never sees it). pipeline.log makes
    the output durably inspectable after a run.
    """

    def __init__(self, primary, log_file):
        self.primary = primary
        self.log_file = log_file

    def write(self, data):
        try:
            self.log_file.write(data)
            self.log_file.flush()
        except Exception:
            pass
        return self.primary.write(data)

    def flush(self):
        try:
            self.log_file.flush()
        except Exception:
            pass
        return self.primary.flush()

    def isatty(self):
        return getattr(self.primary, "isatty", lambda: False)()


def _install_pipeline_log(instance_folder: str):
    """Tee stdout+stderr to <instance>/pipeline.log. Returns nothing; safe-noop
    if the log can't be opened. Each run is delineated by a timestamp header."""
    try:
        log_path = os.path.join(instance_folder, "pipeline.log")
        log_file = open(log_path, "a", encoding="utf-8")  # noqa: SIM115 — kept open for run lifetime
        header = f"\n===== pipeline run {datetime.now(timezone.utc).isoformat()} =====\n"
        log_file.write(header)
        sys.stdout = _Tee(sys.stdout, log_file)  # type: ignore[assignment]
        sys.stderr = _Tee(sys.stderr, log_file)  # type: ignore[assignment]
    except Exception as exc:
        # Logging is best-effort — never block a generation over it.
        print(f"[run] could not open pipeline.log: {exc}", file=sys.__stderr__)

# Allow running both from /app/carousel (image) and /workspace (dev copy).
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from brief import Brief, load_brief  # noqa: E402
from mcp_client import McpClient, McpError  # noqa: E402
from state import _read_state, write_state, append_error, write_memory  # noqa: E402


def _read_state_field(instance_folder: str, key: str):
    """Read a single top-level field from state.json, or return None."""
    return _read_state(instance_folder).get(key)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: run.py <instance_folder> [--selected-candidate <id>]", file=sys.stderr)
        return 1
    instance_folder = os.path.abspath(argv[1])
    selected_candidate = None
    if "--selected-candidate" in argv:
        i = argv.index("--selected-candidate")
        if i + 1 >= len(argv):
            print("--selected-candidate requires a value", file=sys.stderr)
            return 1
        selected_candidate = argv[i + 1]

    if not os.path.isdir(instance_folder):
        print(f"instance folder not found: {instance_folder}", file=sys.stderr)
        return 1

    # Tee pipeline output to <instance>/pipeline.log so it's inspectable after a
    # run (opencode captures stdout when it runs us via a tool call, hiding it
    # from docker logs; the log file makes it durable + debuggable).
    _install_pipeline_log(instance_folder)

    brief_path = os.path.join(instance_folder, "brief.json")
    if not os.path.isfile(brief_path):
        # Write a clear error to state.json so the canvas surfaces it.
        try:
            append_error(instance_folder, f"brief.json not found at {brief_path}. The agent must write brief.json before running the pipeline.", phase="error")
        except Exception:
            pass
        print(f"brief.json not found at {brief_path}", file=sys.stderr)
        return 1

    try:
        brief = load_brief(brief_path)
    except ValueError as e:
        append_error(instance_folder, f"invalid brief: {e}", phase="error")
        print(f"invalid brief: {e}", file=sys.stderr)
        return 1

    client = McpClient()
    try:
        client.start()
    except McpError as e:
        append_error(instance_folder, f"cannot start Canva MCP client: {e}", phase="error")
        print(f"MCP start failed: {e}", file=sys.stderr)
        return 1

    try:
        if brief.mode == "posts":
            return _run_posts(client, instance_folder, brief)
        elif brief.mode == "deck":
            return _run_deck(client, instance_folder, brief, selected_candidate)
        else:
            # load_brief already validated mode, but guard defensively.
            raise ValueError(f"unknown mode {brief.mode!r}")
    except McpError as e:
        append_error(instance_folder, f"Canva pipeline failed: {e}")
        print(f"pipeline failed: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        append_error(instance_folder, f"unexpected pipeline error: {e}")
        traceback.print_exc(file=sys.stderr)
        return 1
    finally:
        client.close()


def _run_posts(client: McpClient, instance_folder: str, brief: Brief) -> int:
    """Posts mode: N distinct single-page designs, end-to-end (no pause)."""
    import posts_carousel
    slides = posts_carousel.run_posts(client, instance_folder, brief)
    _finalize(instance_folder, brief, slides, design_ids=[s.get("design_id", "") for s in slides if s.get("design_id")])
    print(f"posts pipeline complete: {len(slides)} slides")
    return 0


def _run_deck(client: McpClient, instance_folder: str, brief: Brief, selected_candidate: str | None) -> int:
    """Deck mode: generate → (pause for selection) → resume → export."""
    import deck_carousel

    if selected_candidate is None:
        # Phase 1: generate candidates and pause.
        job_id = deck_carousel.run_deck_to_candidates(client, instance_folder, brief)
        # Stash is already in state.json (run_deck_to_candidates wrote _job_id).
        print(f"deck candidates ready; paused for selection (job_id={job_id})")
        return 0  # paused — not an error; the host re-invokes on selection

    # Phase 2: resume from the selected candidate. Read the stashed job_id.
    state_path = os.path.join(instance_folder, "state.json")
    job_id = None
    try:
        with open(state_path) as f:
            state = json.load(f)
        job_id = state.get("_job_id")
    except (OSError, json.JSONDecodeError):
        pass
    if not job_id:
        append_error(instance_folder, "cannot resume deck: no _job_id in state.json (the candidate selection context was lost). Re-run generation without --selected-candidate.", phase="error")
        print("resume failed: missing _job_id", file=sys.stderr)
        return 1

    slides = deck_carousel.run_deck_from_candidate(client, instance_folder, brief, job_id, selected_candidate)
    # Clear the candidates + stash now that selection is consumed.
    # Preserve the canva_url that deck_carousel wrote into state.json earlier
    # (it lives on the top-level design dict, not per-slide).
    _prev_design = _read_state_field(instance_folder, "design")
    prev_canva_url = (_prev_design or {}).get("canva_url")
    design_dict = slides[0].get("design_id") and {"design_id": slides[0]["design_id"]} or None
    if design_dict and prev_canva_url:
        design_dict["canva_url"] = prev_canva_url
    write_state(instance_folder, "template_captured", mode=brief.mode, slides=slides,
                design=design_dict,
                candidates=[])
    _finalize(instance_folder, brief, slides, design_ids=[s.get("design_id", "") for s in slides if s.get("design_id")])
    print(f"deck pipeline complete: {len(slides)} slides")
    return 0


def _finalize(instance_folder: str, brief: Brief, slides: list[dict], *, design_ids: list[str]) -> None:
    """Common finalization: mark complete + write memory.md."""
    # Re-read current state to preserve fields, then set phase=complete.
    state_path = os.path.join(instance_folder, "state.json")
    state: dict = {}
    try:
        with open(state_path) as f:
            state = json.load(f)
    except (OSError, json.JSONDecodeError):
        state = {}
    state["phase"] = "complete"
    state["slides"] = slides
    from state import _now_iso
    state["lastUpdated"] = _now_iso()
    # Drop the internal stash fields.
    state.pop("_job_id", None)
    state.pop("_candidates_raw", None)
    tmp = state_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, state_path)

    # memory.md resume handoff.
    write_memory(
        instance_folder,
        title=brief.title,
        status=f"{len(slides)}-slide {brief.mode} carousel exported.",
        decisions=[f"Mode: {brief.mode}", f"Platform/design_type: {brief.platform} → {brief.design_type}"],
        resume_here="To edit copy or swap assets, read template.json (if captured) and use Canva MCP edit tools (replace_text, update_fill) via opencode. Do not re-run generation.",
        notes=[f"design_ids: {', '.join(d for d in design_ids if d)}"] if design_ids else [],
        design_ids=design_ids,
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv))
