"""
Model & quality mapping for the video pipeline.

A Quality toggle (low/high) selects the model; resolution is a separate
secondary dimension. This is the single place to edit when adding or changing a
model — no web/TS changes are required.

  | Modality | Quality | Model                    | Inputs             | Resolutions        |
  |----------|---------|--------------------------|--------------------|--------------------|
  | Image    | low     | grok-imagine-image       | Text, Image refs   | 1k, 2k             |
  | Image    | high    | grok-imagine-image-quality| Text, Image refs  | 1k, 2k             |
  | Video    | low     | grok-imagine-video       | Text or Image      | 480p, 720p         |
  | Video    | high    | grok-imagine-video-1.5   | Image only         | 480p, 720p, 1080p  |
"""

from __future__ import annotations

IMAGE_MODELS: dict[str, str] = {
    "low": "grok-imagine-image",
    "high": "grok-imagine-image-quality",
}

VIDEO_MODELS: dict[str, str] = {
    "low": "grok-imagine-video",
    "high": "grok-imagine-video-1.5",
}

#: High-quality video is image→video only (no text-to-video). The pipeline
#: forces a seed frame when this quality is chosen without a starting image.
VIDEO_NEEDS_IMAGE: set[str] = {"high"}

VIDEO_RESOLUTIONS: dict[str, list[str]] = {
    "low": ["480p", "720p"],
    "high": ["480p", "720p", "1080p"],
}

IMAGE_RESOLUTIONS: list[str] = ["1k", "2k"]


def image_model(quality: str) -> str:
    return IMAGE_MODELS.get(quality, IMAGE_MODELS["low"])


def video_model(quality: str) -> str:
    return VIDEO_MODELS.get(quality, VIDEO_MODELS["low"])


def video_needs_image(quality: str) -> bool:
    return quality in VIDEO_NEEDS_IMAGE


def clamp_video_resolution(quality: str, resolution: str | None) -> str:
    """Return a resolution valid for the given quality, clamping if needed."""
    opts = VIDEO_RESOLUTIONS.get(quality, VIDEO_RESOLUTIONS["low"])
    if resolution in opts:
        return resolution  # type: ignore[return-value]
    return opts[-1]


def clamp_image_resolution(resolution: str | None) -> str:
    if resolution in IMAGE_RESOLUTIONS:
        return resolution  # type: ignore[return-value]
    return IMAGE_RESOLUTIONS[0]


# ── Cost estimation (advisory; surfaced in the UI as a "≈ cost" hint) ────────

_IMAGE_COST: dict[str, float] = {
    # $/image
    "grok-imagine-image:1k": 0.002,
    "grok-imagine-image:2k": 0.002,
    "grok-imagine-image-quality:1k": 0.01,
    "grok-imagine-image-quality:2k": 0.07,
}

_VIDEO_COST_PER_SEC: dict[str, float] = {
    "grok-imagine-video:480p": 0.08,
    "grok-imagine-video:720p": 0.14,
    "grok-imagine-video-1.5:480p": 0.08,
    "grok-imagine-video-1.5:720p": 0.14,
    "grok-imagine-video-1.5:1080p": 0.25,
}


def estimate_image_cost(quality: str, resolution: str, n: int = 1) -> float:
    key = f"{image_model(quality)}:{clamp_image_resolution(resolution)}"
    return _IMAGE_COST.get(key, 0.002) * max(1, n)


def estimate_video_cost(quality: str, resolution: str, duration: int, with_seed: bool = False) -> float:
    key = f"{video_model(quality)}:{clamp_video_resolution(quality, resolution)}"
    per_sec = _VIDEO_COST_PER_SEC.get(key, 0.14)
    total = per_sec * max(1, duration)
    if with_seed:
        total += _IMAGE_COST.get(f"{image_model(quality)}:1k", 0.01)
    return total
