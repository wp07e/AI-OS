"""
template.json capture: writes the element contract the AI edits against.

For each design, opens a transaction (read-only), extracts every text element's
id + text + position, infers a role (headline/body/cta), cancels, and writes
template.json. This is what makes LLM-driven edits reliable — the AI resolves
"change the headline on slide 1" to a specific element_id instead of guessing.
"""

from __future__ import annotations

import json
import os
from typing import Any

from canva_ops import McpClient, TextElement, capture_text_elements


def infer_role(el: TextElement, all_on_page: list[TextElement]) -> str:
    """Best-effort role from position + size (advisory, per the fixtures model).

    Largest text by height → headline. Short text with →/swipe → cta. Multi-word
    below headline → body. Leave None-equivalent ("text") if unclear.
    """
    text = el.text.lower()
    # CTA: short text containing a swipe/arrow cue.
    if len(el.text) < 40 and any(k in text for k in ("→", "->", "swipe", "tap", "click", "start", "learn")):
        return "cta"
    # Headline: the tallest text on the page.
    tallest = max(all_on_page, key=lambda e: e.height)
    if el.element_id == tallest.element_id and el.height > 80:
        return "headline"
    # Body: multi-word, non-headline.
    if len(el.text.split()) > 3:
        return "body"
    return "text"


def capture_and_write_template(
    client: McpClient,
    instance_folder: str,
    *,
    designs: list[dict[str, Any]],
) -> None:
    """Capture text elements for each design, write template.json.

    `designs`: list of {design_id, slide_index (0-based), title} entries — one per
    design in posts mode, or one entry (the deck) repeated for each page in deck
    mode. The slide_index maps elements to slides in the canvas.
    """
    pages: list[dict[str, Any]] = []

    for d in designs:
        design_id = d["design_id"]
        slide_index = d.get("slide_index", 0)
        title = d.get("title", "")
        try:
            elements = capture_text_elements(client, design_id)
        except Exception as e:
            # Capture is best-effort — if it fails, the slide just won't have a
            # template entry. Edits to it will need to open a transaction live.
            pages.append({
                "slide_index": slide_index,
                "design_id": design_id,
                "title": title,
                "elements": [],
                "capture_error": str(e),
            })
            continue

        # Group by page for role inference (within a page, tallest = headline).
        by_page: dict[int, list[TextElement]] = {}
        for el in elements:
            by_page.setdefault(el.page_index, []).append(el)

        els_json: list[dict[str, Any]] = []
        for el in elements:
            siblings = by_page.get(el.page_index, [el])
            els_json.append({
                "element_id": el.element_id,
                "page_index": el.page_index,
                "slide_index": slide_index,
                "text": el.text,
                "inferred_role": infer_role(el, siblings),
                "position": {"top": el.top, "left": el.left},
                "dimension": {"width": el.width, "height": el.height},
            })

        pages.append({
            "slide_index": slide_index,
            "design_id": design_id,
            "title": title,
            "elements": els_json,
        })

    template = {
        "constraint": {"cannot_add_elements": True, "deletion_leaves_gap": True},
        "pages": pages,
        "note": "Element IDs captured at generation time. For edits, resolve the target via inferred_role or text match, then call replace_text with the element_id. Always re-read before editing.",
    }
    path = os.path.join(instance_folder, "template.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(template, f, indent=2)
    os.replace(tmp, path)
