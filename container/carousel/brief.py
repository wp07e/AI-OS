"""
Brief parsing + validation for the carousel pipeline.

The brief is the agent-authored input describing what to build. It follows
fixtures/brief.schema.jsonc but we validate loosely here (the agent writes it;
we surface clear errors rather than reject strictly). The key fields the
pipeline needs:
  - format.mode: "posts" | "deck"
  - format.platform: instagram | facebook | twitter | ... (posts mode routing)
  - slides[]: per-slide content (headline/body/cta) + intent
  - brand: optional brand library (colors/typography baked into the query)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from canva_ops import POSTS_DESIGN_TYPES, length_for_slide_count


@dataclass
class SlideBrief:
    """One slide's intent + content from the brief."""
    n: int                          # 1-indexed position
    intent: str
    headline: str = ""
    body: str = ""
    cta: str = ""
    archetype: str = ""             # advisory (hero/split/...) → baked into query

    def content_query_fragment(self) -> str:
        """Render this slide's copy into a query fragment for generate-design."""
        parts = [f"Slide {self.n}"]
        if self.archetype:
            parts.append(f"({self.archetype} layout)")
        parts.append(f"— {self.intent}")
        if self.headline:
            parts.append(f'\nHeadline: "{self.headline}"')
        if self.body:
            parts.append(f'\nBody: "{self.body}"')
        if self.cta:
            parts.append(f'\nCTA: "{self.cta}"')
        return " ".join(parts)


@dataclass
class Brief:
    deck_id: str
    title: str
    mode: str                       # "posts" | "deck"
    platform: str                   # "instagram" | "facebook" | ... (lowercased)
    aspect_ratio: str = ""          # advisory intent
    slides: list[SlideBrief] = field(default_factory=list)
    brand: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def design_type(self) -> str:
        """The Canva design_type this brief maps to."""
        if self.mode == "deck":
            return "presentation"
        return POSTS_DESIGN_TYPES.get(self.platform, "instagram_post")

    @property
    def length(self) -> str | None:
        """Presentation length (deck mode only). None for posts mode."""
        if self.mode != "deck":
            return None
        return length_for_slide_count(len(self.slides))


def load_brief(path: str) -> Brief:
    """Read + validate a brief.json. Raises ValueError on missing required fields."""
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise ValueError(f"cannot read brief at {path}: {e}") from e

    deck_id = data.get("deck_id") or data.get("title", "carousel").lower().replace(" ", "-")
    title = data.get("title", "Carousel")
    fmt = data.get("format") or {}
    mode = (fmt.get("mode") or "").lower()
    platform = (fmt.get("platform") or "instagram").lower()
    aspect_ratio = fmt.get("aspect_ratio", "")

    if mode not in ("posts", "deck"):
        raise ValueError(
            f"brief.format.mode must be 'posts' or 'deck' (got {mode!r}). "
            "The agent must infer the mode from the user's request before running the pipeline."
        )
    if mode == "posts" and platform not in POSTS_DESIGN_TYPES:
        raise ValueError(
            f"posts mode platform {platform!r} not supported. Supported: {sorted(POSTS_DESIGN_TYPES)}"
        )

    raw_slides = data.get("slides") or []
    if not raw_slides:
        raise ValueError("brief must have at least one slide")
    slides: list[SlideBrief] = []
    for i, s in enumerate(raw_slides):
        content = s.get("content") or {}
        slides.append(SlideBrief(
            n=int(s.get("n") or (i + 1)),
            intent=s.get("intent", ""),
            headline=content.get("headline", ""),
            body=content.get("body", ""),
            cta=content.get("cta", ""),
            archetype=s.get("archetype_suggestion", ""),
        ))

    return Brief(
        deck_id=deck_id,
        title=title,
        mode=mode,
        platform=platform,
        aspect_ratio=aspect_ratio,
        slides=slides,
        brand=data.get("brand") or {},
        raw=data,
    )


def brand_preamble(brief: Brief) -> str:
    """Render the brief's brand library into a query preamble (if present).

    Colors + typography are description-only per the fixtures model — baked
    verbatim into the generate-design prompt. Returns "" if no brand block.
    """
    b = brief.brand
    if not b:
        return ""
    lines = []
    if b.get("name") or b.get("voice"):
        if b.get("name"):
            lines.append(f"Brand: {b['name']}.")
        if b.get("voice"):
            lines.append(f"Voice: {b['voice']}")
    colors = b.get("colors") or {}
    usage = b.get("color_usage") or {}
    if colors:
        lines.append("Colors (use exactly as specified):")
        for role, hex_ in colors.items():
            note = usage.get(role, "")
            lines.append(f"  {role} {hex_}" + (f" — {note}" if note else ""))
    typo = b.get("typography") or {}
    if typo:
        if typo.get("pairing"):
            lines.append(f"Typography: {typo['pairing']}")
        roles = typo.get("roles") or {}
        if roles:
            lines.append("Roles:")
            for role, spec in roles.items():
                family = spec.get("family", "")
                weight = spec.get("weight", "")
                lines.append(f"  {role} — {family} {weight}".rstrip())
        if typo.get("fallback"):
            lines.append(f"Fallback: {typo['fallback']}")
    if lines:
        lines.append("Preserve this identity on every slide. Vary composition for pacing; do not vary the palette or typography.")
    return "\n".join(lines)
