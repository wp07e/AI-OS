"""Free-tier vision MCP server.

Exposes one tool, `analyze_image`, that calls a free multimodal model
(Qwen2.5-VL-32B-Instruct) routed via OpenRouter through the project's LiteLLM
gateway. No separate API key is needed — LiteLLM holds the central OpenRouter
key (OPENROUTER_API_KEY) and this server authenticates with the same
OPENAI_BASE_URL / OPENAI_API_KEY the main agent uses.

The intent is to give the (text-only) main agent a free way to visually verify
Blender renders — framing, blank-output detection, detached parts, etc. —
without the per-call cost of grok.chat_with_vision. If the free tier is
rate-limited or unavailable, the caller should fall back to grok vision.
"""

import base64
import mimetypes
import os
from pathlib import Path
from typing import List, Optional

import httpx
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

load_dotenv()

# LiteLLM gateway (OpenAI-compatible). Defaults match the project's .env:
#   OPENAI_BASE_URL=http://litellm:4000/v1
#   OPENAI_API_KEY=<litellm virtual key>
BASE_URL = os.environ.get("OPENAI_BASE_URL", "http://litellm:4000/v1").rstrip("/")
API_KEY = os.environ.get("OPENAI_API_KEY", "")
# Model alias declared in container/litellm_config.yaml (routes to the free
# OpenRouter Qwen2.5-VL model). Override via VISION_MODEL for a paid fallback.
MODEL = os.environ.get("VISION_MODEL", "vision-free")

# Max image bytes sent to the model (guard against huge renders). 10 MiB.
MAX_IMAGE_BYTES = 10 * 1024 * 1024

mcp = FastMCP(name="Vision MCP Server")


def _encode_image(path: str) -> str:
    """Read an image file and return a base64 data URI."""
    p = Path(path)
    data = p.read_bytes()
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError(
            f"image {path} is {len(data)} bytes (> {MAX_IMAGE_BYTES}); downscale before sending"
        )
    mime, _ = mimetypes.guess_type(path)
    if not mime or not mime.startswith("image/"):
        # Default to PNG for unknown image extensions.
        mime = "image/png"
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _call_model(content_parts: list, prompt: str) -> str:
    """POST a chat completion to the LiteLLM gateway and return the text."""
    messages = [
        {
            "role": "user",
            "content": [*content_parts, {"type": "text", "text": prompt}],
        }
    ]
    url = f"{BASE_URL}/chat/completions"
    resp = httpx.post(
        url,
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json={"model": MODEL, "messages": messages},
        timeout=120.0,
    )
    resp.raise_for_status()
    data = resp.json()
    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message", {})
    text = msg.get("content", "")
    # Some vision models return content as a list of parts.
    if isinstance(text, list):
        text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
    usage = data.get("usage") or {}
    footer = ""
    if usage:
        footer = f"\n\n[usage: prompt={usage.get('prompt_tokens', '?')} completion={usage.get('completion_tokens', '?')}]"
    return (text or "(no response)") + footer


@mcp.tool()
async def analyze_image(
    prompt: str,
    image_paths: Optional[List[str]] = None,
    image_urls: Optional[List[str]] = None,
) -> str:
    """Analyze one or more images with a free multimodal vision model.

    Use this to verify Blender renders (framing, blank output, detached parts,
    mesh integrity from appearance) without per-call cost. Local images are
    sent as base64 data URIs (PNG/JPG/GIF/WebP, up to 10 MiB each).

    If this tool errors (free-tier rate limit or unavailability), fall back to
    `grok.chat_with_vision` with detail:"high" for a sharper paid check.

    Args:
        prompt: What to look for / question about the image(s). Be specific
            (e.g. "Is the subject's head attached to its body? Is the camera
            pointing at the subject's front? Is any part of the render blank?").
        image_paths: Local image file paths to analyze.
        image_urls: Public image URLs to analyze.

    Returns:
        The model's textual answer about the image(s).
    """
    if not image_paths and not image_urls:
        return "error: provide at least one image_paths or image_urls entry"

    parts: list = []
    for path in image_paths or []:
        try:
            parts.append({"type": "image_url", "image_url": {"url": _encode_image(path)}})
        except Exception as e:
            return f"error encoding {path}: {e}"
    for url in image_urls or []:
        parts.append({"type": "image_url", "image_url": {"url": url}})

    try:
        return _call_model(parts, prompt)
    except httpx.HTTPStatusError as e:
        body = e.response.text[:500] if e.response is not None else ""
        return (
            f"vision-free HTTP {e.response.status_code if e.response is not None else '?'}: {body}\n"
            f"(Free tier may be rate-limited — fall back to grok.chat_with_vision.)"
        )
    except Exception as e:
        return f"vision-free error: {e}\n(Fall back to grok.chat_with_vision.)"


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
