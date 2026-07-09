"""
Brand kit + per-lane selection merge.

The carousel pipeline consumes a single ``brand`` dict (see brief.py). This
module builds that dict from two sources:

1. The user's global Brand Kit at ``/workspace/brand/brand.json`` (managed via
   the Brand library UI / Ask AI).
2. The lane's selection at ``<instance_folder>/brand_selection.json`` — which
   kit elements (identity, colors, typography, assets) apply to THIS carousel.

The selection PROJECTS the kit: only selected color roles, selected assets,
etc. are included. If the brief itself carries a ``brand`` block (rare — the
skill doesn't write one), it overrides the kit per-field (per-carousel wins).

Selected assets are attached as ``brand["__selected_assets"]`` (a list of
asset metadata dicts) so the pipeline can (a) describe them in the preamble
(Tier 1, always) and (b) upload + embed them when PUBLIC_BASE_URL is set
(Tier 2, in posts_carousel/deck_carousel).
"""

from __future__ import annotations

import json
import os
from typing import Any

BRAND_KIT_PATH = "/workspace/brand/brand.json"
SELECTION_FILENAME = "brand_selection.json"
VALID_CATEGORIES = ("logo", "photo", "component", "icon")


def load_json(path: str) -> dict[str, Any] | None:
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def project_selection(
    kit: dict[str, Any] | None,
    selection: dict[str, Any] | None,
) -> dict[str, Any]:
    """Project a selection onto a kit → the effective brand dict.

    Returns {} when the kit is missing or the selection is disabled/absent.
    """
    if not kit or not isinstance(kit, dict):
        return {}
    if not selection or not selection.get("enabled"):
        return {}

    out: dict[str, Any] = {}

    # Identity
    if selection.get("identity"):
        if kit.get("name"):
            out["name"] = kit["name"]
        if kit.get("voice"):
            out["voice"] = kit["voice"]

    # Colors — "all" or a list of roles
    kit_colors = kit.get("colors") or {}
    kit_usage = kit.get("color_usage") or {}
    sel_colors = selection.get("colors")
    roles = (
        list(kit_colors.keys())
        if sel_colors == "all" or not sel_colors
        else [r for r in sel_colors if r in kit_colors]
    )
    if roles:
        out["colors"] = {r: kit_colors[r] for r in roles}
        usage = {r: kit_usage[r] for r in roles if r in kit_usage}
        if usage:
            out["color_usage"] = usage

    # Typography
    if selection.get("typography") and kit.get("typography"):
        out["typography"] = kit["typography"]

    # Assets — resolve selected ids to their metadata
    sel_assets = selection.get("assets") or {}
    kit_assets_by_id = {
        a["id"]: a for a in (kit.get("assets") or []) if isinstance(a, dict) and "id" in a
    }
    selected: list[dict[str, Any]] = []
    for cat in VALID_CATEGORIES:
        ids = sel_assets.get(cat) or []
        for aid in ids:
            asset = kit_assets_by_id.get(aid)
            if asset:
                # Attach the category from the selection so the preamble can
                # describe placement even if the kit's own category differs.
                a = dict(asset)
                a["category"] = cat
                selected.append(a)
    if selected:
        # Stash under a private key; brand_preamble reads it. Also keep the
        # legacy per-channel shape for forward compat.
        out["__selected_assets"] = selected

    return out


def merge_brand_for_brief(
    instance_folder: str,
    brief_brand: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build the effective brand dict for a carousel run.

    Reads the global kit + the lane's selection, projects, then layers the
    brief's own brand block on top (per-carousel overrides win per key).
    Returns {} if nothing applies.
    """
    kit = load_json(BRAND_KIT_PATH)
    selection = load_json(os.path.join(instance_folder, SELECTION_FILENAME))
    projected = project_selection(kit, selection)

    if not brief_brand:
        return projected

    # Per-field override: brief wins for any key it sets, EXCEPT the private
    # __selected_assets which only the selection controls.
    merged = dict(projected)
    for k, v in brief_brand.items():
        merged[k] = v
    return merged


def selected_assets(brand: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull the resolved selected-asset list back out of a merged brand dict."""
    assets = brand.get("__selected_assets") if isinstance(brand, dict) else None
    return assets or []


def resolve_asset_ids(
    instance_folder: str,
    client: Any,
) -> list[str]:
    """Tier 2 asset embedding: upload selected brand assets to Canva, return ids.

    Reads <instance_folder>/brand_selection.json, which carries a
    ``resolvedAssetUrls`` map (assetId → signed public URL) minted by the host
    when the wizard saved. Uploads each via upload-asset-from-url and returns
    the resulting Canva asset_ids, ready to pass to generate-design.

    CACHING: the Canva asset_id is written back to the global kit at
    /workspace/brand/brand.json under each asset's ``canva_asset_id`` field
    after the first successful upload. Subsequent runs (this lane or any other
    lane selecting the same asset) reuse the cached id instead of re-uploading,
    so the user's Canva library isn't filled with duplicates.

    Returns [] when:
      - PUBLIC_BASE_URL isn't set (Tier 1 describe-only mode), OR
      - no selection / no resolved URLs, OR
      - the selection is disabled.

    Failures are logged + skipped (non-fatal): a single bad upload shouldn't
    abort the whole carousel. The preamble's text descriptions still apply.
    """
    if not os.environ.get("PUBLIC_BASE_URL"):
        return []
    selection = load_json(os.path.join(instance_folder, SELECTION_FILENAME))
    if not selection or not selection.get("enabled"):
        return []
    urls = selection.get("resolvedAssetUrls") or {}
    if not urls:
        return []

    # Imported lazily so brand_merge stays decoupled from the MCP client.
    from canva_ops import upload_asset_from_url  # noqa: WPS433

    # Load the kit once to consult + update the per-asset Canva id cache.
    kit = load_json(BRAND_KIT_PATH) or {"assets": []}
    assets_by_id = {
        a["id"]: a for a in (kit.get("assets") or []) if isinstance(a, dict) and "id" in a
    }
    kit_dirty = False

    asset_ids: list[str] = []
    for asset_id, url in urls.items():
        asset = assets_by_id.get(asset_id)
        cached = asset.get("canva_asset_id") if asset else None
        if cached:
            # Reuse the previously uploaded asset — no duplicate upload.
            asset_ids.append(cached)
            continue
        try:
            canva_id = upload_asset_from_url(client, url, f"brand-{asset_id}")
            asset_ids.append(canva_id)
            # Cache it on the kit so future runs (any lane) skip the upload.
            if asset is not None:
                asset["canva_asset_id"] = canva_id
                kit_dirty = True
        except Exception as exc:  # noqa: BLE001 — non-fatal, best-effort
            print(f"[brand] asset upload failed for {asset_id}: {exc}")

    # Write the cache back if any new Canva ids were recorded.
    if kit_dirty:
        try:
            with open(BRAND_KIT_PATH, "w") as f:
                json.dump(kit, f, indent=2)
        except OSError as exc:
            print(f"[brand] failed to persist canva_asset_id cache: {exc}")

    return asset_ids

