# Layerre MCP

Bundled MCP server for the [Layerre API](https://layerre.com). Lets the agent
turn any Canva share URL into a template, edit its layers, and render custom
variants — without ever leaving the conversation.

## Tools

All tools are prefixed `layerre_` and mirror the Layerre REST API 1:1.

| Tool | Layerre endpoint |
| --- | --- |
| `layerre_create_template`         | `POST   /v1/template`               |
| `layerre_get_template`            | `GET    /v1/template/{t}`           |
| `layerre_update_template`         | `PATCH  /v1/template/{t}`           |
| `layerre_delete_template`         | `DELETE /v1/template/{t}`           |
| `layerre_list_templates`          | `GET    /v1/templates`              |
| `layerre_create_layer`            | `POST   /v1/template/{t}/layer`     |
| `layerre_get_layer`               | `GET    /v1/template/{t}/layer/{l}` |
| `layerre_update_layer`            | `PATCH  /v1/template/{t}/layer/{l}` |
| `layerre_delete_layer`            | `DELETE /v1/template/{t}/layer/{l}` |
| `layerre_create_variant`          | `POST   /v1/template/{t}/variant`   |
| `layerre_get_variant`             | `GET    /v1/template/{t}/variant/{v}` |
| `layerre_delete_variant`          | `DELETE /v1/template/{t}/variant/{v}` |
| `layerre_list_variants`           | `GET    /v1/template/{t}/variants`  |
| `layerre_analyze_canva_design`    | `POST   /v1/analyze/canva-design`   |

## Configuration

The server reads `LAYERRE_API_KEY` from the environment. Copy `example_env`
to `example.env` and fill in your key, or set the env var directly.

```bash
cp example_env example.env
# edit example.env
LAYERRE_API_KEY=lr-...
```

## Run locally

```bash
uv run python main.py
```

The server speaks stdio MCP, so it is launched by an MCP client (e.g.
OpenCode) — not directly.

## Rate limits

Layerre allows 10 rps sustained / 20 burst / 600 per minute per IP. Tool
calls surface `429` responses as actionable error strings with the
`Retry-After` value.
