"""Layerre MCP server.

Exposes the full Layerre API (https://api.layerre.com/v1) as MCP tools so an
agent can:
  1. Import a Canva design as a template (layers extracted automatically),
  2. Inspect / mutate templates and their layers,
  3. Render customized variants (overrides per layer),
  4. Analyze a Canva share URL for colors, fonts, and images.

Tool names are prefixed `layerre_` so they group cleanly in tool lists.
"""
from __future__ import annotations

from typing import Any, Optional

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from .utils import (
    LayerreError,
    as_link,
    format_layer,
    format_layer_inline,
    format_template,
    format_variant,
    layerre_request,
)

mcp = FastMCP(name="Layerre MCP Server")
READONLY = ToolAnnotations(readOnlyHint=True)
DESTRUCTIVE = ToolAnnotations(destructiveHint=True)


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


@mcp.tool(annotations=READONLY)
async def layerre_create_template(canva_url: str) -> str:
    """Create a Layerre template from a Canva share URL.

    Layerre imports the design and extracts every editable layer (text,
    images, fonts, positioning). The returned template id is then used for
    layer inspection and variant rendering.

    IMPORTANT: paste the Canva URL verbatim — do NOT escape `?` or `&`
    (no backslashes). A typical value looks like
    `https://www.canva.com/design/DAxxxxx/edit`.

    Args:
        canva_url: Public Canva share/edit URL for the design.

    Returns:
        A readable summary including the new template id, dimensions, and
        the number of layers extracted.
    """
    body = {"canva_url": canva_url}
    try:
        data = await layerre_request("POST", "/template", json_body=body)
    except LayerreError as exc:
        return f"Failed to create template: {exc}"
    t = data if isinstance(data, dict) else {}
    layers = t.get("layers")
    layer_note = f" ({len(layers)} layers extracted)" if isinstance(layers, list) else ""
    return (
        f"Template created.{layer_note}\n"
        + format_template(t, include_layers=False)
    )


@mcp.tool(annotations=READONLY)
async def layerre_get_template(template_id: str) -> str:
    """Get a template by id with all of its layers.

    Refreshes signed URLs for image layers. Use this to discover layer ids
    before building overrides for `layerre_create_variant`.

    Args:
        template_id: UUID of the template.

    Returns:
        Full template summary with every layer listed (id, type, current
        text/image).
    """
    try:
        t = await layerre_request("GET", f"/template/{template_id}")
    except LayerreError as exc:
        return f"Failed to get template: {exc}"
    if not isinstance(t, dict):
        return f"Unexpected response: {t!r}"
    return format_template(t, include_layers=True)


@mcp.tool()
async def layerre_update_template(
    template_id: str,
    name: Optional[str] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    background_color: Optional[str] = None,
    layers: Optional[list[dict[str, Any]]] = None,
) -> str:
    """Update a template's metadata and/or layers (PATCH).

    Supply any subset of fields. To change a single layer you can pass a
    one-element `layers` array with the layer's `id` and the properties to
    change; for full layer field semantics see the Layerre docs. Passing
    `layers` REPLACES the layers you reference — be deliberate.

    Args:
        template_id: UUID of the template.
        name: Optional new display name.
        width: Optional new width in px.
        height: Optional new height in px.
        background_color: Optional hex color, e.g. `#FFFFFF`.
        layers: Optional list of full layer objects (with `id`) to update.

    Returns:
        The updated template summary.
    """
    body: dict[str, Any] = {}
    for key, val in (
        ("name", name),
        ("width", width),
        ("height", height),
        ("background_color", background_color),
        ("layers", layers),
    ):
        if val is not None:
            body[key] = val
    if not body:
        return "Nothing to update — supply at least one field."
    try:
        t = await layerre_request("PATCH", f"/template/{template_id}", json_body=body)
    except LayerreError as exc:
        return f"Failed to update template: {exc}"
    return format_template(t, include_layers=False) if isinstance(t, dict) else "Updated."


@mcp.tool(annotations=DESTRUCTIVE)
async def layerre_delete_template(template_id: str) -> str:
    """Soft-delete a template (DELETE).

    Variants and layers go with it. This is reversible only via the Layerre
    dashboard, if at all — confirm before calling.

    Args:
        template_id: UUID of the template.
    """
    try:
        await layerre_request("DELETE", f"/template/{template_id}")
    except LayerreError as exc:
        return f"Failed to delete template: {exc}"
    return f"Template {template_id} deleted."


@mcp.tool(annotations=READONLY)
async def layerre_list_templates(
    skip: int = 0, limit: int = 100, include_layers: bool = False
) -> str:
    """List templates for the current user, newest first.

    Args:
        skip: Pagination offset (>= 0).
        limit: Page size (1–1000).
        include_layers: Include layer details per template (slower for large
            accounts). Defaults to false.

    Returns:
        Each template on its own block with id, dimensions, and variant count.
    """
    params = {"skip": skip, "limit": limit, "include_layers": str(include_layers).lower()}
    try:
        data = await layerre_request("GET", "/templates", params=params)
    except LayerreError as exc:
        return f"Failed to list templates: {exc}"
    items = data if isinstance(data, list) else (data.get("items") or [] if isinstance(data, dict) else [])
    if not items:
        return "No templates found."
    return "\n\n".join(format_template(t, include_layers=include_layers) for t in items)


# ---------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------


@mcp.tool()
async def layerre_create_layer(
    template_id: str,
    name: str,
    layer_type: str,
    x: float = 0,
    y: float = 0,
    properties: Optional[dict[str, Any]] = None,
) -> str:
    """Add a new layer to a template (POST).

    Create a TEXT layer by supplying `properties.text`, or an IMAGE layer by
    supplying `properties.img_url`. Layerre infers the type from those
    properties; pass `layer_type` (`text` or `image`) explicitly if you want
    to be unambiguous.

    Args:
        template_id: UUID of the template.
        name: Display name for the new layer.
        layer_type: `text` or `image`.
        x: X position in px.
        y: Y position in px.
        properties: Layer properties (text/img_url/font_name/font_size/color/
            width/height/rotation/etc.) — same shape as the PATCH body.

    Returns:
        The created layer's id and summary.
    """
    body: dict[str, Any] = {
        "name": name,
        "layer_type": layer_type,
        "x": x,
        "y": y,
    }
    if properties:
        body["properties"] = properties
    try:
        layer = await layerre_request(
            "POST", f"/template/{template_id}/layer", json_body=body
        )
    except LayerreError as exc:
        return f"Failed to create layer: {exc}"
    return format_layer(layer) if isinstance(layer, dict) else f"Created: {layer!r}"


@mcp.tool(annotations=READONLY)
async def layerre_get_layer(template_id: str, layer_id: str) -> str:
    """Get a specific layer by id (refreshes signed URL if it's an image).

    Args:
        template_id: UUID of the template.
        layer_id: UUID of the layer.

    Returns:
        Full layer detail including all properties.
    """
    try:
        layer = await layerre_request(
            "GET", f"/template/{template_id}/layer/{layer_id}"
        )
    except LayerreError as exc:
        return f"Failed to get layer: {exc}"
    return format_layer(layer) if isinstance(layer, dict) else f"{layer!r}"


@mcp.tool()
async def layerre_update_layer(
    template_id: str,
    layer_id: str,
    properties: dict[str, Any],
    name: Optional[str] = None,
    x: Optional[float] = None,
    y: Optional[float] = None,
    position: Optional[int] = None,
) -> str:
    """Update a layer (PATCH).

    Most edits belong in `properties`: text content, img_url, color,
    font_size, font_name, font_style, text_align, letter_spacing,
    line_spacing, vertical_align, width, height, rotation, opacity,
    flip_horizontal, flip_vertical, image_fit, image_position, etc.

    Args:
        template_id: UUID of the template.
        layer_id: UUID of the layer.
        properties: The property keys/values to change (partial update).
        name: Optional new layer name.
        x: Optional new X position.
        y: Optional new Y position.
        position: Optional z-order index.

    Returns:
        The updated layer detail.
    """
    body: dict[str, Any] = {"id": layer_id, "properties": properties}
    for key, val in (
        ("name", name),
        ("x", x),
        ("y", y),
        ("position", position),
    ):
        if val is not None:
            body[key] = val
    try:
        layer = await layerre_request(
            "PATCH", f"/template/{template_id}/layer/{layer_id}", json_body=body
        )
    except LayerreError as exc:
        return f"Failed to update layer: {exc}"
    return format_layer(layer) if isinstance(layer, dict) else "Layer updated."


@mcp.tool(annotations=DESTRUCTIVE)
async def layerre_delete_layer(template_id: str, layer_id: str) -> str:
    """Soft-delete a layer (DELETE).

    Args:
        template_id: UUID of the template.
        layer_id: UUID of the layer.
    """
    try:
        await layerre_request("DELETE", f"/template/{template_id}/layer/{layer_id}")
    except LayerreError as exc:
        return f"Failed to delete layer: {exc}"
    return f"Layer {layer_id} deleted."


# ---------------------------------------------------------------------------
# Variants
# ---------------------------------------------------------------------------


@mcp.tool()
async def layerre_create_variant(
    template_id: str,
    overrides: Optional[list[dict[str, Any]]] = None,
    export_type: str = "png",
    width: Optional[int] = None,
    height: Optional[int] = None,
) -> str:
    """Render one variant from a template (POST).

    Apply targeted edits per render without touching the template itself.
    Each override is `{"layer_id": "<uuid>", "properties": {...}}`. Layers you
    omit keep their template defaults. Use `layerre_get_template` first to
    discover layer ids.

    Properties you can override include `text`, `img_url`, `color`,
    `font_size`, `font_name`, `image_fit`, `image_position`, and the rest of
    the layer property set.

    Args:
        template_id: UUID of the template.
        overrides: List of `{layer_id, properties}` objects. May be empty.
        export_type: `png`, `jpg`, `pdf`, etc. (default `png`).
        width: Optional output width override in px.
        height: Optional output height override in px.

    Returns:
        The rendered variant with its (signed) download URL.
    """
    body: dict[str, Any] = {
        "export_type": export_type,
        "overrides": overrides or [],
    }
    if width is not None:
        body["width"] = width
    if height is not None:
        body["height"] = height
    try:
        v = await layerre_request(
            "POST", f"/template/{template_id}/variant", json_body=body
        )
    except LayerreError as exc:
        return f"Failed to create variant: {exc}"
    if isinstance(v, dict):
        return format_variant(v)
    return f"{v!r}"


@mcp.tool(annotations=READONLY)
async def layerre_get_variant(template_id: str, variant_id: str) -> str:
    """Get a variant by id (refreshes signed URL if expired).

    Args:
        template_id: UUID of the template.
        variant_id: UUID of the variant.
    """
    try:
        v = await layerre_request(
            "GET", f"/template/{template_id}/variant/{variant_id}"
        )
    except LayerreError as exc:
        return f"Failed to get variant: {exc}"
    return format_variant(v) if isinstance(v, dict) else f"{v!r}"


@mcp.tool(annotations=DESTRUCTIVE)
async def layerre_delete_variant(template_id: str, variant_id: str) -> str:
    """Soft-delete a variant (DELETE).

    Args:
        template_id: UUID of the template.
        variant_id: UUID of the variant.
    """
    try:
        await layerre_request(
            "DELETE", f"/template/{template_id}/variant/{variant_id}"
        )
    except LayerreError as exc:
        return f"Failed to delete variant: {exc}"
    return f"Variant {variant_id} deleted."


@mcp.tool(annotations=READONLY)
async def layerre_list_variants(
    template_id: str, skip: int = 0, limit: int = 100
) -> str:
    """List all variants for a template (refreshes signed URLs).

    Args:
        template_id: UUID of the template.
        skip: Pagination offset (>= 0).
        limit: Page size (1–1000).
    """
    params = {"skip": skip, "limit": limit}
    try:
        data = await layerre_request(
            "GET", f"/template/{template_id}/variants", params=params
        )
    except LayerreError as exc:
        return f"Failed to list variants: {exc}"
    items = data if isinstance(data, list) else (data.get("items") or [] if isinstance(data, dict) else [])
    if not items:
        return "No variants found for this template."
    return "\n\n".join(format_variant(v) for v in items)


# ---------------------------------------------------------------------------
# Analyze
# ---------------------------------------------------------------------------


@mcp.tool(annotations=READONLY)
async def layerre_analyze_canva_design(canva_url: str) -> str:
    """Analyze a public Canva share URL.

    Extracts the design's color palette, fonts, and images without creating
    a template. Useful for reconnaissance before deciding whether to import.

    Args:
        canva_url: Public Canva share/edit URL (unescaped — no backslashes).

    Returns:
        Colors, fonts, and image URLs detected in the design.
    """
    try:
        data = await layerre_request(
            "POST", "/analyze/canva-design", json_body={"canva_url": canva_url}
        )
    except LayerreError as exc:
        return f"Failed to analyze design: {exc}"
    return _format_analysis(data) if isinstance(data, dict) else f"{data!r}"


def _format_analysis(data: dict[str, Any]) -> str:
    lines = ["Canva design analysis:"]
    colors = data.get("colors") or data.get("palette")
    if colors:
        lines.append("  colors: " + ", ".join(colors))
    fonts = data.get("fonts")
    if fonts:
        lines.append("  fonts: " + ", ".join(fonts))
    images = data.get("images")
    if images:
        lines.append(f"  images ({len(images)}):")
        for img in images:
            url = img if isinstance(img, str) else (img.get("url") if isinstance(img, dict) else None)
            lines.append(f"    - {as_link(url)}")
    extras = [k for k in data if k not in {"colors", "palette", "fonts", "images"}]
    if extras:
        lines.append("  additional fields: " + ", ".join(extras))
    return "\n".join(lines)
