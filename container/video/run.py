#!/usr/bin/env python3
"""
Video pipeline entry point.

Reads request.json from an instance folder, runs the deterministic
generation/edit/extend/assemble pipeline, and writes state.json + memory.md at
each phase boundary.

Usage:
  uv run --project /app/video python run.py <instance_folder> --request request.json

The agent (skill) writes request.json then invokes this script. The agent does
NOT call image/video generation tools or ffmpeg itself — this script owns those,
deterministically. NL edits remain the agent's job (via opencode tool-calling),
but the agent is instructed to write a request.json and run this script for any
generation action.

Exit codes: 0 = complete, 1 = error. Errors are written to state.json's
errors[] before exiting so the canvas surfaces them.

Provider/model seams: this script is the ONLY place that names Grok/xAI. Adding
a future video MCP = add a <provider>_client.py and branch on
request.json["provider"]. Adding a model = edit models.py. No web/TS changes.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

# Allow running from /app/video (image) and resolve local modules + the package
# layout (run.py lives next to state.py, models.py, grok_client.py, ffmpeg_ops.py).
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import ffmpeg_ops as ff  # noqa: E402
import state as S  # noqa: E402
from grok_client import GrokClient, GenerationResult, download  # noqa: E402
from models import (  # noqa: E402
    clamp_video_resolution,
    video_needs_image,
)


# ── Helpers ────────────────────────────────────────────────────────────────


def _read_request(folder: str, request_name: str) -> dict:
    path = os.path.join(folder, request_name)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _resolve_brand_assets(folder: str, asset_ids: list[str]) -> list[str]:
    """Map selected reference ids → container paths, PRESERVING SELECTION ORDER.

    Two formats are supported:
      1. Brand asset ids (uuids): looked up in /workspace/brand/brand.json to
         find the on-disk path under /workspace/brand/assets/<id>.<ext>.
      2. Instance upload paths ("uploads/<uuid>.<ext>"): resolved relative to
         the instance folder. These are one-off references uploaded via the
         video upload route, not part of the global brand kit.

    Order is critical: the resulting paths map 1:1 to @image1, @image2, ... in
    the prompt. We process each id in selection order so the user's @imageN
    numbering matches what they see in the UI.
    """
    if not asset_ids:
        return []

    # Build a lookup for brand asset ids (one-time read of brand.json).
    brand_json = "/workspace/brand/brand.json"
    id_to_path: dict[str, str] = {}
    try:
        with open(brand_json, "r", encoding="utf-8") as f:
            kit = json.load(f)
        for a in kit.get("assets", []):
            aid = a.get("id")
            apath = a.get("path")
            if aid and apath:
                id_to_path[aid] = apath
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # Resolve each id in order — do NOT regroup by type (that would break the
    # @imageN mapping the user sees in the UI).
    paths: list[str] = []
    for aid in asset_ids:
        if aid.startswith("uploads/"):
            full = os.path.join(folder, aid)
            if os.path.exists(full):
                paths.append(full)
        else:
            p = id_to_path.get(aid)
            if p and os.path.exists(p):
                paths.append(p)

    return paths


def _set_active(folder: str, op: str, label: str, target_index: int | None = None) -> None:
    active = {"op": op, "label": label}
    if target_index is not None:
        active["targetIndex"] = target_index
    S.write_state(folder, "preparing", active=active)


def _fail(folder: str, msg: str, exc: Exception | None = None) -> None:
    detail = msg
    if exc:
        detail = f"{msg}: {exc}"
    state = S.read_state(folder)
    errors = state.get("errors", [])
    errors.append(detail)
    S.write_state(folder, "error", errors=errors, active=None)
    S.append_memory(folder, f"❌ Error during generation: {detail}")
    print(f"[video] ERROR: {detail}", file=sys.stderr)


# ── Image generation ───────────────────────────────────────────────────────


def _do_image(folder: str, req: dict, client: GrokClient, edit: bool) -> None:
    settings = req.get("settings", {})
    quality = req.get("quality", "low")
    resolution = settings.get("resolution", "1k")
    n = int(settings.get("n", 1))
    aspect = settings.get("aspect_ratio")
    prompt = req.get("prompt", "")
    refs = _resolve_brand_assets(folder, req.get("references", []))

    _set_active(folder, "edit_image" if edit else "generate_image", "Generating image(s)")
    S.write_state(folder, "generating")

    results = client.generate_image(
        prompt=prompt,
        quality=quality,
        resolution=resolution,
        n=n,
        reference_paths=refs if (edit or refs) else None,
        aspect_ratio=aspect,
    )

    S.write_state(folder, "downloading")
    state = S.read_state(folder)
    images = state.get("images", [])
    exports_dir = os.path.join(folder, "exports")
    os.makedirs(exports_dir, exist_ok=True)

    for i, res in enumerate(results):
        num = S.next_image_number(images) + i
        stem = f"img-{str(num).zfill(2)}"
        local = os.path.join("exports", f"{stem}.png")
        download(res.url, os.path.join(folder, local))
        images.append({
            "id": stem,
            "prompt": prompt,
            "quality": quality,
            "references": req.get("references", []),
            "localPath": local,
            "sourceUrl": res.url,
            "revisedPrompt": res.revised_prompt,
            "status": "ready",
        })

    S.write_state(folder, "complete", images=images, active=None, mode="image")
    S.append_memory(folder, f"🖼️ Generated {len(results)} image(s). Prompt: {prompt[:80]}")


# ── Video generation ───────────────────────────────────────────────────────


def _resolve_starting_frame(
    folder: str,
    req: dict,
    state: dict,
    client: GrokClient,
    quality: str,
) -> tuple[str | None, dict]:
    """
    Resolve the starting frame for image-to-video, by priority:
      1. startImageExport (a brand ref id or an exports/img-NN.png path)
      2. continuity == last_frame → extract last frame of sourceClipIndex
      3. seedPrompt → generate a seed frame with the image model
      4. None (text-to-video, low quality only)

    Returns (frame_path_or_None, extras) where extras carries metadata to merge
    into the new clip (seedImagePath, seedPrompt, seedFromClip, sourceType).
    """
    extras: dict = {}
    start = req.get("startImageExport")
    continuity = req.get("continuity", "none")
    needs_image = video_needs_image(quality)
    seed_prompt = req.get("seedPrompt")

    # 1. Explicit start image: could be a brand asset id or an exports path.
    if start:
        # If it looks like a brand asset id (no slash, no dot), resolve it.
        if "/" not in start and "." not in start:
            brand_paths = _resolve_brand_assets(folder, [start])
            if brand_paths:
                extras["sourceType"] = "image"
                return brand_paths[0], extras
        # Otherwise treat as an exports path.
        candidate = os.path.join(folder, start)
        if os.path.exists(candidate):
            extras["sourceType"] = "image"
            return candidate, extras

    # 2. Continue from last frame.
    if continuity == "last_frame":
        src_idx = req.get("sourceClipIndex")
        clips = state.get("clips", [])
        if src_idx is not None:
            src = next((c for c in clips if c.get("index") == src_idx), None)
            if src and src.get("localPath"):
                src_video = os.path.join(folder, src["localPath"])
                target_png = os.path.join(folder, "exports", f"clip-{S.clip_num(src_idx)}-lastframe.png")
                ff.extract_last_frame(src_video, target_png)
                extras["sourceType"] = "image"
                extras["seedFromClip"] = src_idx
                return target_png, extras

    # 3. Seed prompt (or forced for high quality).
    if seed_prompt or needs_image:
        prompt = seed_prompt or req.get("prompt", "")
        S.write_state(folder, "generating", active={"op": "generate_video", "label": "Generating seed frame"})
        seed_results = client.generate_image(
            prompt=prompt,
            quality=quality,
            resolution="1k",
            reference_paths=_resolve_brand_assets(folder, req.get("references", [])),
        )
        if seed_results:
            seed_num = S.next_image_number(state.get("images", []))
            stem = f"img-{str(seed_num).zfill(2)}"
            img_local = os.path.join("exports", f"{stem}.png")
            download(seed_results[0].url, os.path.join(folder, img_local))
            # Also record it in images[] so it shows in the Image gallery.
            images = state.get("images", [])
            images.append({
                "id": stem,
                "prompt": prompt,
                "quality": quality,
                "references": req.get("references", []),
                "localPath": img_local,
                "sourceUrl": seed_results[0].url,
                "status": "ready",
            })
            S.write_state(folder, "downloading", images=images)
            extras["seedImagePath"] = img_local
            extras["seedPrompt"] = prompt
            extras["sourceType"] = "image"
            return os.path.join(folder, img_local), extras

    # 4. None — text-to-video (only valid for low quality).
    extras["sourceType"] = "text"
    return None, extras


def _do_video(folder: str, req: dict, client: GrokClient) -> None:
    settings = req.get("settings", {})
    quality = req.get("quality", "low")
    resolution = clamp_video_resolution(quality, settings.get("resolution", "720p"))
    duration = settings.get("duration")
    aspect = settings.get("aspect_ratio")
    prompt = req.get("prompt", "")

    state = S.read_state(folder)
    new_index = S.next_clip_index(state.get("clips", []))
    num = S.clip_num(new_index)

    _set_active(folder, "generate_video", f"Generating clip {new_index + 1}", target_index=new_index)

    frame_path, extras = _resolve_starting_frame(folder, req, state, client, quality)

    S.write_state(folder, "generating", active={"op": "generate_video", "label": f"Generating clip {new_index + 1}", "targetIndex": new_index})

    # The xAI API does NOT allow both `image` (starting frame) and
    # `reference_images` in the same call — they are mutually exclusive modes:
    #   - image = image-to-video (animate this specific frame)
    #   - reference_images = reference-to-video (text-to-video guided by refs)
    # When we have BOTH a starting frame and user-selected references, we merge
    # the starting frame into the references list (as @image1) and use
    # reference-to-video mode. The prompt guides the action.
    ref_ids = [r for r in req.get("references", []) if r != req.get("startImageExport")]
    user_refs = _resolve_brand_assets(folder, ref_ids)

    if frame_path and user_refs:
        # Both present → merge: starting frame becomes the first reference.
        all_refs = [frame_path] + user_refs
        result = client.generate_video(
            prompt=prompt,
            quality=quality,
            resolution=resolution,
            duration=duration,
            aspect_ratio=aspect,
            image_path=None,
            reference_paths=all_refs,
        )
    elif frame_path:
        # Starting frame only → image-to-video.
        result = client.generate_video(
            prompt=prompt,
            quality=quality,
            resolution=resolution,
            duration=duration,
            aspect_ratio=aspect,
            image_path=frame_path,
            reference_paths=None,
        )
    else:
        # No starting frame → reference-to-video (or pure text-to-video if no refs).
        result = client.generate_video(
            prompt=prompt,
            quality=quality,
            resolution=resolution,
            duration=duration,
            aspect_ratio=aspect,
            image_path=None,
            reference_paths=user_refs if user_refs else None,
        )

    S.write_state(folder, "downloading")
    local_mp4 = os.path.join("exports", f"clip-{num}.mp4")
    download(result.url, os.path.join(folder, local_mp4))

    # Poster frame.
    poster_local: str | None = None
    try:
        poster_local = os.path.join("exports", f"clip-{num}.jpg")
        ff.extract_poster(os.path.join(folder, local_mp4), os.path.join(folder, poster_local))
    except Exception:
        poster_local = None

    # Probe duration if the API didn't return one.
    duration_val = result.duration
    if duration_val is None:
        duration_val = ff.ffprobe_duration(os.path.join(folder, local_mp4))

    clip = {
        "index": new_index,
        "prompt": prompt,
        "sourceType": extras.get("sourceType", "text"),
        "quality": quality,
        "continuity": req.get("continuity", "none"),
        "seedFromClip": extras.get("seedFromClip"),
        "seedPrompt": extras.get("seedPrompt"),
        "seedImagePath": extras.get("seedImagePath"),
        "settings": settings,
        "references": req.get("references", []),
        "startImageExport": req.get("startImageExport"),
        "included": True,
        "status": "ready",
        "localPath": local_mp4,
        "posterPath": poster_local,
        "sourceUrl": result.url,
        "duration": duration_val,
    }

    clips = state.get("clips", [])
    clips.append(clip)
    S.write_state(folder, "complete", clips=clips, active=None, mode="video")
    S.append_memory(
        folder,
        f"🎬 Generated clip {new_index + 1} ({extras.get('sourceType', 'text')}, {quality}). "
        f"Prompt: {prompt[:80]}",
    )


# ── Extend ─────────────────────────────────────────────────────────────────


def _do_extend(folder: str, req: dict, client: GrokClient) -> None:
    state = S.read_state(folder)
    src_idx = req.get("sourceClipIndex")
    clips = state.get("clips", [])
    src = next((c for c in clips if c.get("index") == src_idx), None)
    if not src or not src.get("sourceUrl"):
        _fail(folder, f"extend: source clip {src_idx} has no sourceUrl (it may have expired)")
        return

    _set_active(folder, "extend_video", f"Extending clip {(src_idx or 0) + 1}", target_index=src_idx)
    S.write_state(folder, "generating")

    result = client.extend_video(
        prompt=req.get("prompt", ""),
        video_url=src["sourceUrl"],
        duration=req.get("settings", {}).get("duration"),
    )

    S.write_state(folder, "downloading")
    num = S.clip_num(src_idx)
    local_mp4 = os.path.join("exports", f"clip-{num}.mp4")
    download(result.url, os.path.join(folder, local_mp4))

    poster_local = src.get("posterPath")
    try:
        poster_local = os.path.join("exports", f"clip-{num}.jpg")
        ff.extract_poster(os.path.join(folder, local_mp4), os.path.join(folder, poster_local))
    except Exception:
        pass

    duration_val = result.duration or ff.ffprobe_duration(os.path.join(folder, local_mp4)) or src.get("duration")

    # Replace the source clip in place with the extended version.
    src.update({
        "localPath": local_mp4,
        "sourceUrl": result.url,
        "posterPath": poster_local,
        "duration": duration_val,
        "continuity": "extend",
        "status": "ready",
    })
    S.write_state(folder, "complete", clips=clips, active=None, mode="video")
    S.append_memory(folder, f"↻ Extended clip {(src_idx or 0) + 1} to {duration_val}s.")


# ── Assemble ───────────────────────────────────────────────────────────────


def _do_assemble(folder: str, req: dict) -> None:
    state = S.read_state(folder)
    clips = state.get("clips", [])

    if req.get("clipIndices"):
        order = req["clipIndices"]
    else:
        order = [c["index"] for c in clips if c.get("included", True)]

    by_index = {c["index"]: c for c in clips}
    paths: list[str] = []
    for idx in order:
        c = by_index.get(idx)
        if c and c.get("localPath") and os.path.exists(os.path.join(folder, c["localPath"])):
            paths.append(os.path.join(folder, c["localPath"]))

    if not paths:
        _fail(folder, "assemble: no included clips with rendered video found")
        return

    _set_active(folder, "assemble", f"Assembling {len(paths)} clip(s)")
    S.write_state(folder, "assembling")

    final_local = os.path.join("exports", "final.mp4")
    ff.concat_clips(paths, os.path.join(folder, final_local))
    duration_val = ff.ffprobe_duration(os.path.join(folder, final_local))

    final_video = {
        "localPath": final_local,
        "duration": duration_val,
        "clipCount": len(paths),
        "clipIndices": order,
        "builtAt": S._now_iso(),
    }
    S.write_state(folder, "complete", final_video=final_video, active=None)
    S.append_memory(folder, f"📦 Assembled final video from {len(paths)} clip(s).")


# ── Extract frame ──────────────────────────────────────────────────────────


def _do_extract_frame(folder: str, req: dict) -> None:
    state = S.read_state(folder)
    src_idx = req.get("sourceClipIndex")
    clips = state.get("clips", [])
    src = next((c for c in clips if c.get("index") == src_idx), None)
    if not src or not src.get("localPath"):
        _fail(folder, f"extract_frame: source clip {src_idx} has no localPath")
        return

    num = S.clip_num(src_idx)
    dest = os.path.join("exports", f"clip-{num}-lastframe.png")
    ff.extract_last_frame(os.path.join(folder, src["localPath"]), os.path.join(folder, dest))
    S.append_memory(folder, f"🖼️ Extracted last frame of clip {(src_idx or 0) + 1} → {dest}")


# ── Delete clip ─────────────────────────────────────────────────────────────


def _do_delete_clip(folder: str, req: dict) -> None:
    """Remove a clip from state.json and delete its files from exports/."""
    state = S.read_state(folder)
    clips = state.get("clips", [])
    src_idx = req.get("sourceClipIndex")
    clip = next((c for c in clips if c.get("index") == src_idx), None)
    if not clip:
        _fail(folder, f"delete_clip: clip {src_idx} not found")
        return

    num = S.clip_num(src_idx)
    # Delete the clip's files (mp4, poster, seed frame, last-frame).
    for suffix in [".mp4", ".jpg", "-frame.png", "-lastframe.png"]:
        path = os.path.join(folder, "exports", f"clip-{num}{suffix}")
        if os.path.exists(path):
            os.remove(path)

    # Remove from clips[].
    clips = [c for c in clips if c.get("index") != src_idx]
    S.write_state(folder, "complete", clips=clips, active=None)
    S.append_memory(folder, f"🗑️ Deleted clip {src_idx + 1}.")


# ── Toggle include ──────────────────────────────────────────────────────────


def _do_toggle_include(folder: str, req: dict) -> None:
    """Toggle a clip's included flag in state.json."""
    state = S.read_state(folder)
    clips = state.get("clips", [])
    src_idx = req.get("sourceClipIndex")
    included = bool(req.get("included"))
    for c in clips:
        if c.get("index") == src_idx:
            c["included"] = included
            break
    S.write_state(folder, "complete", clips=clips, active=None)


# ── Main ───────────────────────────────────────────────────────────────────


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: run.py <instance_folder> --request <request.json>", file=sys.stderr)
        return 1
    folder = sys.argv[1]
    request_name = "request.json"
    for i, a in enumerate(sys.argv):
        if a == "--request" and i + 1 < len(sys.argv):
            request_name = sys.argv[i + 1]

    try:
        req = _read_request(folder, request_name)
    except Exception as e:
        print(f"[video] failed to read request: {e}", file=sys.stderr)
        return 1

    op = req.get("op", "")
    provider = req.get("provider", "grok")

    # File/state-only ops don't need the provider client or ffmpeg.
    if op in ("assemble", "extract_frame", "delete_clip", "toggle_include"):
        try:
            if op == "assemble":
                _do_assemble(folder, req)
            elif op == "extract_frame":
                _do_extract_frame(folder, req)
            elif op == "delete_clip":
                _do_delete_clip(folder, req)
            elif op == "toggle_include":
                _do_toggle_include(folder, req)
            return 0
        except Exception as e:
            _fail(folder, f"{op} failed", e)
            traceback.print_exc()
            return 1

    # Provider seam: branch on provider name. Today only "grok".
    if provider != "grok":
        _fail(folder, f"unknown provider: {provider}")
        return 1

    client: GrokClient | None = None
    try:
        client = GrokClient()

        if op == "generate_image":
            _do_image(folder, req, client, edit=False)
        elif op == "edit_image":
            _do_image(folder, req, client, edit=True)
        elif op == "generate_video":
            _do_video(folder, req, client)
        elif op == "extend_video":
            _do_extend(folder, req, client)
        else:
            _fail(folder, f"unknown op: {op}")
            return 1
        return 0
    except Exception as e:
        _fail(folder, f"{op} failed", e)
        traceback.print_exc()
        return 1
    finally:
        if client:
            client.close()


if __name__ == "__main__":
    sys.exit(main())
