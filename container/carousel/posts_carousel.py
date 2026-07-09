"""
Posts mode: generate N distinct single-page designs (one per slide).

Each slide is a visually distinct {platform}_post design (instagram_post,
facebook_post, twitter_post). generate-design is called once per slide with
that slide's content + brand preamble. candidate[0] is used deterministically
(per-slide candidates are interchangeable treatments; no judgment to surface).

The pipeline writes state.json at each step so the canvas polls live.
"""

from __future__ import annotations

import os

from brief import Brief, SlideBrief, brand_preamble
from canva_ops import Candidate, CreatedDesign, McpClient, generate_design, create_from_candidate
from brand_merge import resolve_asset_ids
from export_util import export_and_save
from state import write_state, slide_state


def run_posts(
    client: McpClient,
    instance_folder: str,
    brief: Brief,
) -> list[dict]:
    """Run the full posts pipeline. Returns the final slides[] state entries.

    Raises on failure; caller catches and writes the error to state.json.
    """
    exports_dir = os.path.join(instance_folder, "exports")
    preamble = brand_preamble(brief)

    # Initial slide state — populate copy up front so the canvas filmstrip +
    # copy panel render before any generation happens.
    slides_state: list[dict] = [
        slide_state(
            index=i,
            headline=s.headline,
            body=s.body,
            cta=s.cta,
            archetype=s.archetype,
        )
        for i, s in enumerate(brief.slides)
    ]
    write_state(
        instance_folder,
        "planning",
        mode=brief.mode,
        brief={"topic": brief.title, "aspect_ratio": brief.aspect_ratio, "slide_count": len(brief.slides), "platform": brief.platform},
        slides=slides_state,
    )

    write_state(instance_folder, "resolving_assets", mode=brief.mode, slides=slides_state)
    # Tier 2: when PUBLIC_BASE_URL is set, upload selected brand assets to
    # Canva once and pass their asset_ids to every generate-design call so
    # they're really embedded. When unset, returns [] (Tier 1 describe-only —
    # the preamble's text guidance still applies, Canva picks stock).
    asset_ids = resolve_asset_ids(instance_folder, client)
    write_state(instance_folder, "assets_resolved", mode=brief.mode, slides=slides_state)

    write_state(instance_folder, "generating_design", mode=brief.mode, slides=slides_state)

    design_ids: list[str] = []
    collection_design: dict | None = None
    for i, slide in enumerate(brief.slides):
        query = _build_slide_query(preamble, slide, brief)
        gen = generate_design(
            client,
            query=query,
            design_type=brief.design_type,
            asset_ids=asset_ids or None,
        )
        # Deterministic pick: first candidate.
        chosen = gen.candidates[0]
        created = create_from_candidate(client, job_id=gen.job_id, candidate_id=chosen.candidate_id)

        # Export this single-page design → one PNG. Offset the filename by the
        # slide index so each slide gets a unique file (slide-01, slide-02, ...).
        render_paths = export_and_save(client, created.design_id, exports_dir, filename_start_index=i + 1)
        render_path = render_paths[0] if render_paths else ""

        slides_state[i]["design_id"] = created.design_id
        slides_state[i]["render_path"] = render_path
        slides_state[i]["canva_url"] = created.edit_url
        design_ids.append(created.design_id)

        # Update state after each slide so the filmstrip populates incrementally.
        # Keep a stable collection-level `design` (slide 0's) so the canvas can
        # show "Designed in Canva" continuously — the toolbar surfaces the
        # *selected* slide's own canva_url from slides[] for per-slide links.
        if i == 0:
            collection_design = {"design_id": created.design_id, "canva_url": created.edit_url}
        write_state(
            instance_folder,
            "generating_design",
            mode=brief.mode,
            slides=slides_state,
            design=collection_design,
        )

    # Capture template.json — the element contract the AI edits against.
    write_state(instance_folder, "capturing_template", mode=brief.mode, slides=slides_state)
    from template import capture_and_write_template
    capture_and_write_template(
        client,
        instance_folder,
        designs=[{"design_id": did, "slide_index": idx, "title": brief.title} for idx, did in enumerate(design_ids)],
    )

    return slides_state


def _build_slide_query(preamble: str, slide: SlideBrief, brief: Brief) -> str:
    """Build the generate-design query for one slide."""
    parts: list[str] = []
    if preamble:
        parts.append(preamble)
        parts.append("")
    parts.append(f"Single {brief.platform} post slide:")
    parts.append(slide.content_query_fragment())
    parts.append(f"\nDesign type: {brief.design_type}. One slide only.")
    return "\n".join(parts)
