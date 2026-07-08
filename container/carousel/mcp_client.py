"""
Direct-HTTP MCP client for the Canva MCP server.

Calls https://mcp.canva.com/mcp with JSON-RPC over HTTP, authenticated via the
OAuth token opencode caches at /workspace/.local/share/opencode/mcp-auth.json.
This is the same wire path opencode uses internally — no mcp-remote-client, no
stdio bridging, no separate OAuth flow.

Verified working: initialize, tools/list, tools/call (generate-design,
create-design-from-candidate, get-design-pages, export-design) all return clean
JSON-RPC responses.

See project memory topic "canva-mcp-full-pipeline-contract" for response shapes.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

DEFAULT_SERVER_URL = "https://mcp.canva.com/mcp"
# opencode's token cache (the file our OAuth fix writes to as appuser).
DEFAULT_TOKEN_PATH = "/workspace/.local/share/opencode/mcp-auth.json"
PROTOCOL_VERSION = "2025-06-18"


class McpError(Exception):
    """Raised on transport failures, auth errors, or tool-level errors."""


class McpClient:
    """Speaks JSON-RPC over HTTP to the Canva MCP server."""

    def __init__(
        self,
        server_url: str = DEFAULT_SERVER_URL,
        token_path: str = DEFAULT_TOKEN_PATH,
        timeout: int = 120,
    ):
        self.server_url = server_url
        self.token_path = token_path
        self.timeout = timeout
        self._req_id = 0
        self._token: str | None = None
        self._token_exp: float = 0.0
        self._initialized = False

    # ── lifecycle ──────────────────────────────────────────────────────────

    def start(self) -> None:
        """Load the token and perform the MCP initialize handshake."""
        self._load_token()
        resp = self._request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "aios-carousel", "version": "1.0.0"},
        })
        server = (resp.get("serverInfo") or {})
        if not resp.get("protocolVersion"):
            raise McpError(f"initialize did not return a protocol version: {resp}")
        # notifications/initialized — no response expected; ignore failures.
        try:
            self._request("notifications/initialized", {})
        except McpError:
            pass
        self._initialized = True

    def close(self) -> None:
        """Nothing to clean up (HTTP is stateless per call). Kept for symmetry."""
        pass

    # ── token ──────────────────────────────────────────────────────────────

    def _load_token(self) -> None:
        """Read the access token + expiry from opencode's cache file.

        Raises if the file is missing or has no Canva access token. Token refresh
        is NOT implemented here — opencode keeps the token fresh through its own
        use, and generation pipelines are short-lived. If the token is expired on
        load, we still try (Canva may accept a recently-expired token or opencode
        may refresh between our check and the call); a 401 will surface as McpError.
        """
        try:
            with open(self.token_path) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            raise McpError(f"cannot read token cache at {self.token_path}: {e}") from e
        canva = data.get("Canva") or {}
        tokens = canva.get("tokens") or {}
        access = tokens.get("accessToken")
        if not access:
            raise McpError(
                f"no Canva access token in {self.token_path}. "
                "Complete the Canva OAuth flow in the web UI first."
            )
        self._token = access
        self._token_exp = float(tokens.get("expiresAt") or 0)

    def _is_token_expired(self) -> bool:
        # 60s skew window — refresh boundary.
        return self._token_exp > 0 and time.time() > (self._token_exp - 60)

    # ── JSON-RPC transport ─────────────────────────────────────────────────

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Send a JSON-RPC request and return the `result` object.

        Raises McpError on transport failure, HTTP non-200, or a JSON-RPC error.
        """
        if not self._token:
            raise McpError("not started — call start() first")
        self._req_id += 1
        body = json.dumps({
            "jsonrpc": "2.0",
            "id": self._req_id,
            "method": method,
            "params": params,
        }).encode("utf-8")
        req = urllib.request.Request(
            self.server_url,
            data=body,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            raise McpError(f"HTTP {e.code} calling {method}: {detail}") from e
        except urllib.error.URLError as e:
            raise McpError(f"network error calling {method}: {e.reason}") from e

        try:
            msg = json.loads(raw)
        except json.JSONDecodeError as e:
            raise McpError(f"non-JSON response from {method}: {raw[:200]!r}") from e

        if "error" in msg:
            err = msg["error"]
            raise McpError(f"JSON-RPC error calling {method}: {json.dumps(err)}")
        return msg.get("result") or {}

    # ── MCP operations ─────────────────────────────────────────────────────

    def list_tools(self) -> list[dict[str, Any]]:
        result = self._request("tools/list", {})
        return result.get("tools", [])

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call an MCP tool via the standard tools/call envelope.

        Returns the parsed JSON content of the tool result. Most Canva tools
        return their data as a text part containing a JSON string — this method
        parses that into the underlying object. If the result isn't JSON text,
        returns the raw text concatenated.

        Raises McpError if the tool itself reported an error (isError=true) or
        if the transport failed.
        """
        result = self._request("tools/call", {"name": name, "arguments": arguments or {}})
        if result.get("isError"):
            text = " ".join(
                c.get("text", "")
                for c in result.get("content", [])
                if c.get("type") == "text"
            )
            raise McpError(f"tool '{name}' returned an error: {text}")
        # Concatenate text parts; try to parse as JSON (Canva's convention).
        text_parts = [
            c.get("text", "")
            for c in result.get("content", [])
            if c.get("type") == "text"
        ]
        joined = "\n".join(text_parts).strip()
        if not joined:
            return None
        try:
            return json.loads(joined)
        except json.JSONDecodeError:
            return joined  # not all tools return JSON; return the raw text
