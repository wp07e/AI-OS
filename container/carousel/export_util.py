"""
Shared export helpers: fetch signed S3 URLs and write slide PNGs to exports/.

Both modes converge here — export-design returns download URLs, we fetch each
and save as exports/slide-NN.png. Posts mode has N designs (one URL each);
deck mode has one design with N page URLs.
"""

from __future__ import annotations

import os
import time
import urllib.request

from canva_ops import McpClient, export_design

# PNG magic bytes — every valid PNG starts with this. Used to verify a download
# isn't actually an XML/HTML error response (Canva's S3 signed URLs sometimes
# return SignatureDoesNotMatch XML, which must NOT be saved as a .png).
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _is_png(path: str) -> bool:
    """Check the first 8 bytes match the PNG signature."""
    try:
        with open(path, "rb") as f:
            return f.read(8) == PNG_MAGIC
    except OSError:
        return False


def _download(url: str, dest: str) -> bool:
    """Fetch a URL to dest. Returns True if the result is a valid PNG.

    Canva's export S3 URLs occasionally fail with SignatureDoesNotMatch (an XML
    error body). That must never be saved as slide-NN.png — it produces a broken
    image the canvas can't render and the agent can't distinguish from success.
    """
    urllib.request.urlretrieve(url, dest)
    return _is_png(dest)


def export_and_save(
    client: McpClient,
    design_id: str,
    exports_dir: str,
    *,
    user_intent: str = "carousel pipeline",
    filename_start_index: int = 1,
    max_attempts: int = 3,
) -> list[str]:
    """Export a design as PNG and save each page. Returns relative render paths.

    `filename_start_index`: the 1-indexed number of the FIRST page for naming.
    Posts mode calls this once per slide with filename_start_index = slide_index+1,
    so each slide gets a unique filename (slide-01.png, slide-02.png, ...).
    Deck mode uses the default (1) since one export yields all pages in order.

    Retries the whole export on non-PNG downloads: Canva's signed S3 URLs
    occasionally fail with a transient SignatureDoesNotMatch error, and a fresh
    export-design call produces a new (valid) signed URL. Verified-png downloads
    are required — never saves an XML/HTML error body as a .png.
    """
    last_err: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            result = export_design(client, design_id, fmt="png", user_intent=user_intent)
            return download_urls(
                result.urls, exports_dir, filename_start_index=filename_start_index
            )
        except ValueError as e:
            # Non-PNG download (transient S3 signing error). Wait briefly and
            # re-request the export — a fresh call gets a new signed URL.
            last_err = e
            if attempt < max_attempts:
                time.sleep(2 * attempt)  # gentle backoff
                continue
            raise
    raise last_err  # type: ignore[misc]


def download_urls(urls: list[str], dest_dir: str, *, filename_prefix: str = "slide", filename_start_index: int = 1) -> list[str]:
    """Fetch each URL and save as <dest_dir>/<prefix>-NN.png (NN starts at filename_start_index).

    Verifies each download is a real PNG (magic bytes). Canva's S3 signed URLs
    occasionally return a SignatureDoesNotMatch XML error instead of the image —
    that must never be saved as a .png (it produces a broken render the canvas
    can't display). On a non-PNG download, the caller should re-request the export.

    Raises ValueError if any download is not a valid PNG.
    """
    os.makedirs(dest_dir, exist_ok=True)
    render_paths: list[str] = []
    for offset, url in enumerate(urls):
        i = filename_start_index + offset
        fname = f"{filename_prefix}-{i:02d}.png"
        dest = os.path.join(dest_dir, fname)
        if not _download(url, dest):
            # Non-PNG (likely an S3 SignatureDoesNotMatch XML error). Don't
            # leave the broken file around — it would render as nothing.
            try:
                os.remove(dest)
            except OSError:
                pass
            raise ValueError(
                f"export download for {fname} was not a valid PNG (likely a transient "
                f"Canva S3 signing error). Re-export to get a fresh signed URL."
            )
        render_paths.append(f"exports/{fname}")
    return render_paths
