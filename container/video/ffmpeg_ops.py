"""
ffmpeg operations for the video pipeline.

Two responsibilities:
  1. Continuity: extract the last frame of a clip (used as the starting image
     for a "continue from last frame" clip).
  2. Assembly: concatenate included clips into one final video (re-encode safe
     for codec/resolution variance).
  3. Posters: extract a poster frame for <video poster>.

ffmpeg is a REQUIRED container dependency. If absent, these functions raise
RuntimeError with a clear install hint.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def _ensure_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        raise RuntimeError(
            "ffmpeg is not installed. Install it in the container image "
            "(apt-get install -y ffmpeg) before running video operations."
        )


def _run(cmd: list[str]) -> None:
    """Run a command, raising with stderr on failure."""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"command failed ({' '.join(cmd[:3])}…): {proc.stderr.strip()[:500] or proc.stdout.strip()[:500]}"
        )


def extract_last_frame(video_path: str, dest_png: str) -> str:
    """Extract the final frame of a video to a PNG (continuity seed)."""
    _ensure_ffmpeg()
    Path(dest_png).parent.mkdir(parents=True, exist_ok=True)
    # -sseof seeks from the end; -vframes 1 grabs one frame.
    _run([
        "ffmpeg", "-y", "-sseof", "-0.1", "-i", video_path,
        "-vframes", "1", "-q:v", "2", dest_png,
    ])
    return dest_png


def extract_poster(video_path: str, dest_jpg: str) -> str:
    """Extract the first frame as a poster image for <video poster>."""
    _ensure_ffmpeg()
    Path(dest_jpg).parent.mkdir(parents=True, exist_ok=True)
    _run([
        "ffmpeg", "-y", "-i", video_path,
        "-vframes", "1", "-q:v", "2", dest_jpg,
    ])
    return dest_jpg


def concat_clips(clip_paths: list[str], dest_mp4: str) -> str:
    """Concatenate clips into one video.

    Uses the concat filter (re-encode) so it is safe across codec/resolution
    variance between clips. Slower than the demuxer but correct for mixed clips.
    """
    _ensure_ffmpeg()
    if not clip_paths:
        raise RuntimeError("concat_clips: no clips provided")
    Path(dest_mp4).parent.mkdir(parents=True, exist_ok=True)

    if len(clip_paths) == 1:
        # Single clip — just copy.
        shutil.copy2(clip_paths[0], dest_mp4)
        return dest_mp4

    # Build the concat filter graph: [0:v][0:a][1:v][1:a]...concat=n=N:v=1:a=1
    inputs: list[str] = []
    filter_parts: list[str] = []
    for i, _ in enumerate(clip_paths):
        inputs.extend(["-i", clip_paths[i]])
        filter_parts.append(f"[{i}:v][{i}:a]")
    filter_complex = "".join(filter_parts) + f"concat=n={len(clip_paths)}:v=1:a=1[v][a]"

    cmd = ["ffmpeg", "-y", *inputs, "-filter_complex", filter_complex, "-map", "[v]", "-map", "[a]", dest_mp4]
    _run(cmd)
    return dest_mp4


def ffprobe_duration(video_path: str) -> float | None:
    """Best-effort duration probe via ffprobe. Returns None if unavailable."""
    if not shutil.which("ffprobe"):
        return None
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", video_path,
            ],
            capture_output=True, text=True,
        )
        if proc.returncode == 0:
            return float(proc.stdout.strip())
    except (ValueError, subprocess.SubprocessError):
        pass
    return None
