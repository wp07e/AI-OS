"""
Deck mode: one multi-page presentation, with human-in-the-loop candidate selection.

Flow:
  1. generate-design (presentation, length from slide count) → N candidate decks
  2. Write candidates to state.json → phase "awaiting_candidate_selection" → EXIT.
     (The canvas surfaces an interactive pick; the user selects one.)
  3. On resume (--selected-candidate <id>): create-design-from-candidate →
     verify page_count → export PNG per page → write slides[].

The candidate selection is the one judgment point in deck mode — each candidate
is a complete alternative deck with a coherent visual identity, so the user
genuinely picks. Posts mode has no such pause (per-slide candidates are
interchangeable).
"""

from __future__ import annotations

import json
import os

from brief import Brief, brand_preamble
from canva_ops import McpClient, generate_design, create_from_candidate, get_design_pages
from brand_merge import resolve_asset_ids
from export_util import export_and_save
from state import write_state, append_error, slide_state, candidate_state


def run_deck_to_candidates(
    client: McpClient,
    instance_folder: str,
    brief: Brief,
) -> str:
    """Phase 1: generate candidates and pause for selection.

    Returns the job_id (needed for create-design-from-candidate on resume).
    Writes state.json with phase "awaiting_candidate_selection" and the
    candidate list, then returns. The caller exits; the host re-invokes with
    --selected-candidate after the user picks.
    """
    preamble = brand_preamble(brief)
    query = _build_deck_query(preamble, brief)

    # Initial slide state (copy only — no designs yet).
    slides_state = [
        slide_state(index=i, headline=s.headline, body=s.body, cta=s.cta, archetype=s.archetype)
        for i, s in enumerate(brief.slides)
    ]
    write_state(
        instance_folder,
        "planning",
        mode=brief.mode,
        brief={"topic": brief.title, "aspect_ratio": brief.aspect_ratio, "slide_count": len(brief.slides), "platform": brief.platform},
        slides=slides_state,
    )
    # Tier 2: upload selected brand assets (when PUBLIC_BASE_URL set) so the
    # generated deck embeds them. Empty list in dev (Tier 1 describe-only).
    asset_ids = resolve_asset_ids(instance_folder, client)
    write_state(instance_folder, "generating_design", mode=brief.mode, slides=slides_state)

    gen = generate_design(
        client,
        query=query,
        design_type=brief.design_type,
        length=brief.length,
        asset_ids=asset_ids or None,
    )

    # Surface all candidates with their first-slide thumbnail for the picker.
    candidates_state = [
        candidate_state(
            candidate_id=c.candidate_id,
            url=c.url,
            thumbnail_url=c.thumbnails[0] if c.thumbnails else "",
            slide_count=len(c.thumbnails),
        )
        for c in gen.candidates
    ]
    write_state(
        instance_folder,
        "awaiting_candidate_selection",
        mode=brief.mode,
        slides=slides_state,
        candidates=candidates_state,
        # Stash the job_id + candidates for the resume path.
        extra={"_job_id": gen.job_id, "_candidates_raw": [{"candidate_id": c.candidate_id, "thumbnails": c.thumbnails} for c in gen.candidates]},
    )
    return gen.job_id


def run_deck_from_candidate(
    client: McpClient,
    instance_folder: str,
    brief: Brief,
    job_id: str,
    candidate_id: str,
) -> list[dict]:
    """Phase 2 (resume): create the design from the chosen candidate, export pages.

    Returns the final slides[] state entries.
    """
    exports_dir = os.path.join(instance_folder, "exports")

    # Preserve the slide copy from the existing state (planning wrote it).
    slides_state = _read_slides_state(instance_folder, fallback_count=len(brief.slides), brief=brief)

    created = create_from_candidate(client, job_id=job_id, candidate_id=candidate_id)
    pages = get_design_pages(client, created.design_id)

    if len(pages) < len(brief.slides):
        # Canva returned fewer pages than requested — surface but continue with
        # what we have (better a short deck than a hang; the user can regenerate).
        append_error(
            instance_folder,
            f"Canva produced {len(pages)} pages but {len(brief.slides)} were requested. Exporting what's available.",
        )

    write_state(
        instance_folder,
        "generating_design",
        mode=brief.mode,
        slides=slides_state,
        design={"design_id": created.design_id, "canva_url": created.edit_url},
    )

    # Export the presentation → one PNG per page.
    render_paths = export_and_save(client, created.design_id, exports_dir)

    # Map exported pages to slide entries (one design_id for the whole deck;
    # render_path per slide from the page-ordered URLs).
    for i, path in enumerate(render_paths):
        if i < len(slides_state):
            slides_state[i]["design_id"] = created.design_id
            slides_state[i]["render_path"] = path
    # If fewer renders than slides, the trailing slides keep their copy but no render.

    write_state(
        instance_folder,
        "generating_design",
        mode=brief.mode,
        slides=slides_state,
        design={"design_id": created.design_id, "canva_url": created.edit_url},
    )

    # Capture template.json — the element contract the AI edits against. One
    # design with multiple pages; elements carry page_index for slide mapping.
    from template import capture_and_write_template
    capture_and_write_template(
        client,
        instance_folder,
        designs=[{"design_id": created.design_id, "slide_index": 0, "title": created.title}],
    )

    return slides_state


def _read_slides_state(instance_folder: str, *, fallback_count: int, brief: Brief) -> list[dict]:
    """Read slides[] from existing state.json (preserves planning-phase copy)."""
    path = os.path.join(instance_folder, "state.json")
    try:
        with open(path) as f:
            state = json.load(f)
        slides = state.get("slides")
        if slides and len(slides) >= fallback_count:
            return slides
    except (OSError, json.JSONDecodeError):
        pass
    # Fallback: rebuild from the brief.
    return [
        slide_state(index=i, headline=s.headline, body=s.body, cta=s.cta, archetype=s.archetype)
        for i, s in enumerate(brief.slides)
    ]


def _build_deck_query(preamble: str, brief: Brief) -> str:
    """Build the generate-design query for the whole deck."""
    parts: list[str] = []
    if preamble:
        parts.append(preamble)
        parts.append("")
    parts.append(f"Create a {len(brief.slides)}-slide presentation about: {brief.title}")
    parts.append("")
    parts.append("Slides:")
    for s in brief.slides:
        parts.append(s.content_query_fragment())
    parts.append(f"\nDesign type: presentation. Exactly {len(brief.slides)} slides.")
    return "\n".join(parts)
