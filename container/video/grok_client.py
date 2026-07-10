"""
Grok (xAI) client for the video pipeline.

Wraps the xAI SDK's image.sample_batch / video.generate / video.extend calls.
All provider-specific logic lives here — this is the seam a future video MCP
would replace. The rest of the pipeline calls these methods and stays generic.

The base64 encoding mirrors container/mcps/grok-mcp/src/utils.py so the same
data-URI format reaches the xAI API regardless of which path invoked it.

Images are downscaled before encoding to stay under xAI's 4 MB gRPC message
limit. The model only needs references for style/subject guidance, so a max
dimension of 1024px is more than sufficient.
"""

from __future__ import annotations

import base64
import io
import os
from pathlib import Path
from typing import Any

import httpx
from PIL import Image
from xai_sdk import Client

import models as M

#: Max dimension (width or height) for reference images sent to xAI. Larger
#: images are downscaled; smaller ones pass through unchanged.
_MAX_IMAGE_DIM = 1024
#: JPEG quality for re-encoded images (good balance of fidelity vs size).
_JPEG_QUALITY = 85


def _encode_image(path: str) -> str:
    """Read an image, downscale if needed, and return a base64 data URI.

    Images larger than _MAX_IMAGE_DIM on either side are resized (preserving
    aspect ratio) and re-encoded as JPEG quality 85. This keeps each reference
    well under 1 MB so multiple references + a prompt fit within xAI's 4 MB
    gRPC message limit. PNGs with transparency are flattened to RGB.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Image not found: {path}")

    try:
        img = Image.open(p)
        # Flatten transparency (RGBA → RGB) for JPEG encoding.
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGB")
        elif img.mode != "RGB":
            img = img.convert("RGB")

        # Downscale if either dimension exceeds the limit.
        w, h = img.size
        if max(w, h) > _MAX_IMAGE_DIM:
            scale = _MAX_IMAGE_DIM / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=_JPEG_QUALITY)
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        return f"data:image/jpeg;base64,{b64}"
    except Exception:
        # If PIL can't process it (e.g. SVG), fall back to raw bytes.
        ext = p.suffix.lower().lstrip(".")
        b64 = base64.b64encode(p.read_bytes()).decode("utf-8")
        return f"data:image/{ext};base64,{b64}"


def _encode_video(path: str) -> str:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Video not found: {path}")
    ext = p.suffix.lower().lstrip(".")
    b64 = base64.b64encode(p.read_bytes()).decode("utf-8")
    return f"data:video/{ext};base64,{b64}"


class GenerationResult:
    """Normalized result from any generation call."""

    def __init__(self, url: str, duration: float | None = None, revised_prompt: str | None = None):
        self.url = url
        self.duration = duration
        self.revised_prompt = revised_prompt


class GrokClient:
    """Thin wrapper over the xAI SDK for image + video generation."""

    def __init__(self, api_key: str | None = None) -> None:
        key = api_key or os.getenv("XAI_API_KEY", "")
        if not key:
            raise RuntimeError("XAI_API_KEY is not set")
        self._client = Client(api_key=key)

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass

    # ── Image ──────────────────────────────────────────────────────────────

    def generate_image(
        self,
        prompt: str,
        quality: str,
        resolution: str,
        n: int = 1,
        reference_paths: list[str] | None = None,
        aspect_ratio: str | None = None,
    ) -> list[GenerationResult]:
        """Generate/edit images. Returns one result per image (n)."""
        model = M.image_model(quality)
        params: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": max(1, n),
            "image_format": "url",
        }
        params["resolution"] = M.clamp_image_resolution(resolution)
        if aspect_ratio:
            params["aspect_ratio"] = aspect_ratio

        refs: list[str] = []
        for p in reference_paths or []:
            refs.append(_encode_image(p))
        if refs:
            params["image_urls"] = refs

        images = self._client.image.sample_batch(**params)
        return [
            GenerationResult(
                url=img.url,
                revised_prompt=getattr(img, "prompt", None) if getattr(img, "prompt", None) != prompt else None,
            )
            for img in images
        ]

    # ── Video ──────────────────────────────────────────────────────────────

    def generate_video(
        self,
        prompt: str,
        quality: str,
        resolution: str,
        duration: int | None = None,
        aspect_ratio: str | None = None,
        image_path: str | None = None,
        reference_paths: list[str] | None = None,
    ) -> GenerationResult:
        """Text-to-video or image-to-video. Polls synchronously (xAI ~10 min cap)."""
        model = M.video_model(quality)
        params: dict[str, Any] = {"model": model, "prompt": prompt}

        if image_path:
            params["image_url"] = _encode_image(image_path)

        res = M.clamp_video_resolution(quality, resolution)
        # Only pass resolution/duration/aspect for generation (not editing); xAI
        # ignores them for edits, but we avoid sending 1080p on low etc.
        params["resolution"] = res
        if duration:
            params["duration"] = duration
        if aspect_ratio:
            params["aspect_ratio"] = aspect_ratio

        refs: list[str] = []
        for p in reference_paths or []:
            refs.append(_encode_image(p))
        if refs:
            params["reference_image_urls"] = refs

        response = self._client.video.generate(**params)
        return GenerationResult(url=response.url, duration=getattr(response, "duration", None))

    def extend_video(
        self,
        prompt: str,
        video_url: str,
        duration: int | None = None,
    ) -> GenerationResult:
        """Extend an existing video seamlessly from its last frame."""
        params: dict[str, Any] = {
            "model": M.video_model("low"),  # extend uses the video model
            "prompt": prompt,
            "video_url": video_url,
        }
        if duration:
            params["duration"] = duration
        response = self._client.video.extend(**params)
        return GenerationResult(url=response.url, duration=getattr(response, "duration", None))


# ── Download helper ──────────────────────────────────────────────────────────


def download(url: str, dest: str, *, timeout: float = 120) -> str:
    """Download a URL to a local path. Returns the dest path."""
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=timeout, follow_redirects=True) as http:
        with http.stream("GET", url) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in r.iter_bytes():
                    f.write(chunk)
    return dest
