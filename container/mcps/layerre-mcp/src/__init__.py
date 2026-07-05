from .server import mcp


def main() -> None:
    # FastMCP.run blocks; stdio transport by default.
    mcp.run()
