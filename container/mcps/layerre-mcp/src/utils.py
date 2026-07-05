"""Shared utilities for the Layerre MCP server.

A thin, typed wrapper around the Layerre REST API. Tools in server.py call
`layerre_request` and either get back parsed JSON or a ready-to-show error
string. We return human-readable strings (not raw dicts) for the same reason
the Grok MCP does: terminal/IDE renderers show raw JSON as one long line.
"""
from __future__ import annotations

import os
from typing import Any

import httpx

# Endpoint version prefix documented at https://api.layerre.com/v1.
API_BASE = "https://api.layerre.com/v1"
DEFAULT_TIMEOUT = 120.0  # variant rendering can take a while; be generous.

# Rate limit envelope from Layerre: 10 rps sustained, 20 burst, 600/min.
# Single-thread tool calls won't hit this; we just surface 429 cleanly.
RATE_LIMIT_STATUS = 429


class LayerreError(Exception):
    """Raised with an actionable, agent-facing message."""


def _api_key() -> str:
    key = os.getenv("LAYERRE_API_KEY")
    if not key:
        raise LayerreError(
            "LAYERRE_API_KEY is not set. Get a key at "
            "https://layerre.com and set it in the environment before calling "
            "Layerre tools."
        )
    return key


async def layerre_request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
    timeout: float | None = None,
) -> Any:
    """Perform a Layerre API request and return parsed JSON.

    Raises `LayerreError` with a concise, agent-actionable message on auth
    failures, rate limiting, HTTP errors, and network issues.
    """
    headers = {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    url = f"{API_BASE}{path}"

    try:
        async with httpx.AsyncClient(timeout=timeout or DEFAULT_TIMEOUT) as client:
            resp = await client.request(
                method, url, headers=headers, params=params, json=json_body
            )
    except httpx.RequestError as exc:
        raise LayerreError(f"Network error contacting Layerre: {exc}") from exc

    if resp.status_code == RATE_LIMIT_STATUS:
        retry = resp.headers.get("Retry-After")
        wait_msg = f" Retry in {retry}s." if retry else ""
        raise LayerreError(
            f"Layerre rate limit exceeded (429).{wait_msg} Slow down and retry."
        )

    # Layerre returns empty bodies on some DELETEs; don't force JSON parsing.
    if resp.status_code == 204 or not resp.content:
        if resp.is_success:
            return {"status": "ok", "http_status": resp.status_code}
        _raise_http_error(resp)

    try:
        payload = resp.json()
    except ValueError:
        payload = {"raw": resp.text}

    if not resp.is_success:
        _raise_http_error(resp, payload)

    return payload


def _raise_http_error(resp: httpx.Response, payload: Any = None) -> None:
    """Convert a non-2xx response into a helpful message."""
    detail = ""
    if isinstance(payload, dict):
        for key in ("message", "error", "detail"):
            if payload.get(key):
                detail = f" Detail: {payload[key]}"
                break
    raise LayerreError(
        f"Layerre API error {resp.status_code} on {resp.request.method} "
        f"{resp.request.url.path}.{detail}"
    )


# ---------------------------------------------------------------------------
# Formatting helpers — turn API JSON into readable strings for the model.
# ---------------------------------------------------------------------------


def format_template(t: dict[str, Any], include_layers: bool = False) -> str:
    """Render a template object as a compact, readable block."""
    lines = [
        f"Template: {t.get('name', '(unnamed)')}",
        f"  id: {t.get('id')}",
        f"  dimensions: {t.get('width')}×{t.get('height')}",
        f"  background: {t.get('background_color', 'n/a')}",
    ]
    if "variants_count" in t:
        lines.append(f"  variants: {t.get('variants_count')}")
    layers = t.get("layers")
    if include_layers and isinstance(layers, list):
        lines.append(f"  layers ({len(layers)}):")
        for layer in layers:
            lines.append(f"    - {format_layer_inline(layer)}")
    elif isinstance(layers, list):
        lines.append(f"  layers: {len(layers)} (use get_template to view)")
    return "\n".join(lines)


def format_layer_inline(layer: dict[str, Any]) -> str:
    """One-line summary of a layer (used in template listings)."""
    props = layer.get("properties", {}) or {}
    ltype = (
        layer.get("layer_type")
        if isinstance(layer.get("layer_type"), str)
        else (layer.get("layer_type", {}) or {}).get("type", "layer")
    )
    label = layer.get("name") or ltype or "layer"
    extra = ""
    if props.get("text"):
        extra = f' text="{props["text"][:40]}"'
    elif props.get("img_url") or props.get("signed_url"):
        extra = " [image]"
    return f"{label} ({ltype}) id={layer.get('id')}{extra}"


def format_layer(layer: dict[str, Any]) -> str:
    """Detailed multi-line view of a single layer."""
    props = layer.get("properties", {}) or {}
    ltype = layer.get("layer_type")
    if not isinstance(ltype, str):
        ltype = (ltype or {}).get("type", "layer")

    lines = [
        f"Layer: {layer.get('name', '(unnamed)')}",
        f"  id: {layer.get('id')}",
        f"  type: {ltype}",
        f"  position: x={layer.get('x')}, y={layer.get('y')}, z={layer.get('position')}",
    ]
    if props:
        lines.append("  properties:")
        for key, val in props.items():
            lines.append(f"    {key}: {val}")
    return "\n".join(lines)


def format_variant(v: dict[str, Any]) -> str:
    """Render a variant (rendered image) as a small readable block.

    Always surfaces the URL as a clickable link.
    """
    url = v.get("url") or v.get("signed_url") or "(no url)"
    lines = [
        f"Variant id: {v.get('id')}",
        f"  export_type: {v.get('export_type', 'n/a')}",
        f"  status: {v.get('status', 'n/a')}",
        f"  url: {url}",
    ]
    if v.get("width") and v.get("height"):
        lines.append(f"  dimensions: {v.get('width')}×{v.get('height')}")
    return "\n".join(lines)


def as_link(url: str | None) -> str:
    """Return a URL as-is so renderers can linkify it; gracefully handle None."""
    return url or "(no url)"
