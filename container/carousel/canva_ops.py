"""
High-level Canva operations for the carousel pipeline.

Wraps the verified generate → create → export sequence into clean functions.
Each returns typed dicts; raises McpError on any failure. Response shapes are
documented in project memory topic "canva-mcp-full-pipeline-contract".

Design_type routing:
  - posts mode (distinct slides): instagram_post / facebook_post / twitter_post
    (single-page; called once per slide)
  - deck mode (narrative): presentation (multi-page; length controls slide count)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from mcp_client import McpClient, McpError

# Platform → Canva design_type for the "posts" mode (single-page, native aspect).
POSTS_DESIGN_TYPES: dict[str, str] = {
    "instagram": "instagram_post",
    "facebook": "facebook_post",
    "twitter": "twitter_post",
    "x": "twitter_post",
    "pinterest": "pinterest_pin",
    "linkedin": "facebook_post",  # closest single-page analog; refine if Canva adds linkedin_post
}

# Slide count → presentation `length` (deck mode).
def length_for_slide_count(n: int) -> str:
    if n <= 5:
        return "short"
    if n <= 15:
        return "balanced"
    return "comprehensive"


@dataclass
class Candidate:
    """One alternative design from generate-design."""
    candidate_id: str
    url: str                       # Canva design URL
    thumbnails: list[str] = field(default_factory=list)  # one per page; public PNG URLs


@dataclass
class GeneratedDesign:
    """Result of a generate-design call."""
    job_id: str
    candidates: list[Candidate]


@dataclass
class CreatedDesign:
    """Result of create-design-from-candidate."""
    design_id: str
    title: str
    edit_url: str
    view_url: str
    page_count: int


@dataclass
class DesignPage:
    page_id: str
    page_number: int        # 1-indexed
    width: int
    height: int


@dataclass
class ExportResult:
    """Result of export-design. urls[] are signed S3 links, one per page, in order."""
    urls: list[str]


@dataclass
class TextElement:
    """One captured text element — the contract for edits (replace_text etc.)."""
    element_id: str
    page_index: int          # 1-indexed
    text: str                # current text content
    top: float               # position (for role inference: largest on page ≈ headline)
    left: float
    width: float
    height: float


def capture_text_elements(
    client: McpClient,
    design_id: str,
    user_intent: str = "capture element inventory for edits",
) -> list[TextElement]:
    """Open a transaction, read the richtext inventory, cancel (read-only capture).

    start-editing-transaction returns every text element with its element_id,
    position, dimensions, and current text — the contract that replace_text and
    other edit operations need. We cancel immediately since we only opened to
    read (no changes to commit).
    """
    resp = client.call_tool("start-editing-transaction", {
        "design_id": design_id,
        "user_intent": user_intent,
    })
    transaction = (resp or {}).get("transaction") or {}
    transaction_id = transaction.get("transaction_id")
    richtexts = (resp or {}).get("richtexts") or []

    elements: list[TextElement] = []
    for rt in richtexts:
        eid = rt.get("element_id")
        if not eid:
            continue
        container = rt.get("containerElement") or {}
        pos = container.get("position") or {}
        dim = container.get("dimension") or {}
        # Concatenate region text.
        text = "".join(
            (r.get("text") or "") for r in (rt.get("regions") or [])
        )
        elements.append(TextElement(
            element_id=eid,
            page_index=int(rt.get("page_index") or 1),
            text=text,
            top=float(pos.get("top") or 0),
            left=float(pos.get("left") or 0),
            width=float(dim.get("width") or 0),
            height=float(dim.get("height") or 0),
        ))

    # Cancel the transaction (read-only capture — nothing to commit).
    if transaction_id:
        try:
            client.call_tool("cancel-editing-transaction", {
                "transaction_id": transaction_id,
                "user_intent": "cancel after read-only capture",
            })
        except McpError:
            # Non-fatal: an uncanceled transaction eventually expires. Don't fail
            # the whole capture because cancel didn't ack.
            pass

    return elements


def generate_design(
    client: McpClient,
    query: str,
    design_type: str,
    length: str | None = None,
    asset_ids: list[str] | None = None,
    user_intent: str = "carousel pipeline",
) -> GeneratedDesign:
    """Call generate-design (synchronous) and parse the candidate list.

    Returns all candidates Canva produced. The caller decides which to use
    (posts mode: candidate[0] per slide; deck mode: surface all to the user).
    """
    args: dict[str, Any] = {
        "query": query,
        "design_type": design_type,
        "user_intent": user_intent,
    }
    if length is not None:
        args["length"] = length
    if asset_ids:
        args["asset_ids"] = asset_ids

    resp = client.call_tool("generate-design", args)
    job = (resp or {}).get("job") or {}
    job_id = job.get("id")
    if not job_id:
        raise McpError(f"generate-design returned no job id: {resp}")
    if job.get("status") not in (None, "success", "completed"):
        raise McpError(f"generate-design job status not success: {job.get('status')}")

    designs = (job.get("result") or {}).get("generated_designs") or []
    candidates = [
        Candidate(
            candidate_id=d.get("candidate_id", ""),
            url=d.get("url", ""),
            thumbnails=[t.get("url", "") for t in (d.get("thumbnails") or []) if t.get("url")],
        )
        for d in designs
    ]
    # Filter out any candidate missing an id (unusable for create step).
    candidates = [c for c in candidates if c.candidate_id]
    if not candidates:
        raise McpError("generate-design returned no usable candidates")
    return GeneratedDesign(job_id=job_id, candidates=candidates)


def upload_asset_from_url(
    client: McpClient,
    url: str,
    name: str,
) -> str:
    """Upload an image into the user's Canva media library and return its asset_id.

    Used for Tier 2 brand-asset embedding: brand logos/photos/components/icons
    are uploaded once, then their asset_ids are passed to generate-design so
    Canva embeds the real files. The URL must be publicly reachable by Canva's
    servers (provided by the host's signed asset proxy when PUBLIC_BASE_URL set).

    Raises McpError on any failure. Returns the asset_id.
    """
    print(f"[canva] upload-asset-from-url: url={url[:90]} name={name}")
    resp = client.call_tool("upload-asset-from-url", {"url": url, "name": name})
    print(f"[canva] upload-asset-from-url: response={str(resp)[:300]}")
    asset = (resp or {}).get("asset") or {}
    asset_id = asset.get("id")
    if not asset_id:
        raise McpError(f"upload-asset-from-url returned no asset id: {resp}")
    return asset_id


def create_from_candidate(
    client: McpClient,
    job_id: str,
    candidate_id: str,
    user_intent: str = "carousel pipeline",
) -> CreatedDesign:
    """Convert a candidate into an editable design. Requires both ids."""
    resp = client.call_tool("create-design-from-candidate", {
        "job_id": job_id,
        "candidate_id": candidate_id,
        "user_intent": user_intent,
    })
    summary = (resp or {}).get("design_summary") or {}
    design_id = summary.get("id")
    if not design_id:
        raise McpError(f"create-design-from-candidate returned no design id: {resp}")
    urls = summary.get("urls") or {}
    return CreatedDesign(
        design_id=design_id,
        title=summary.get("title", ""),
        edit_url=urls.get("edit_url", ""),
        view_url=urls.get("view_url", ""),
        page_count=int(summary.get("page_count") or 0),
    )


def get_design_pages(
    client: McpClient,
    design_id: str,
    user_intent: str = "carousel pipeline",
) -> list[DesignPage]:
    """List the pages of a design. Use to verify page_count ≥ requested slides."""
    resp = client.call_tool("get-design-pages", {
        "design_id": design_id,
        "user_intent": user_intent,
    })
    items = (resp or {}).get("items") or []
    pages = []
    for it in items:
        dims = it.get("dimensions") or {}
        pages.append(DesignPage(
            page_id=it.get("id", ""),
            page_number=int(it.get("page_number") or it.get("index") or 0),
            width=int(dims.get("width") or 0),
            height=int(dims.get("height") or 0),
        ))
    # Sort by page number for stable ordering.
    pages.sort(key=lambda p: p.page_number)
    return pages


def export_design(
    client: McpClient,
    design_id: str,
    fmt: str = "png",
    pages: list[int] | None = None,
    user_intent: str = "carousel pipeline",
) -> ExportResult:
    """Export a design. Returns signed S3 download URLs (one per page, in order).

    `fmt`: png | pdf | jpg | gif | pptx | mp4 | csv.
    `pages`: 1-indexed page numbers to export; omit for all pages.
    Fetch the URLs immediately — they're time-limited (hours).
    """
    format_obj: dict[str, Any] = {"type": fmt}
    if pages is not None:
        format_obj["pages"] = pages
    resp = client.call_tool("export-design", {
        "design_id": design_id,
        "format": format_obj,
        "user_intent": user_intent,
    })
    job = (resp or {}).get("job") or {}
    if job.get("status") not in (None, "success", "completed"):
        raise McpError(f"export-design job status not success: {job.get('status')}")
    urls = job.get("urls") or []
    if not urls:
        raise McpError("export-design returned no download urls")
    # Filter to non-empty strings.
    urls = [u for u in urls if isinstance(u, str) and u]
    if not urls:
        raise McpError("export-design returned no usable download urls")
    return ExportResult(urls=urls)
