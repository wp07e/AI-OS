# AI OS

A per-user, containerized AI agent platform. Each user gets an isolated Docker container running **OpenCode** with MCP (Model Context Protocol) servers, workflow skills, and its own workspace. A Next.js web frontend orchestrates authentication, container lifecycle, and a 3-pane workflow-driven shell.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Next.js (port 3000)                        │
│   Auth · Workflow Shell · Agent Panel · Container Orchestration    │
└──────────┬────────────────────────────────────────────┬────────────┘
           │ docker compose per user                    │ SQLite
           ▼                                            │
┌──────────────────────┐    virtual key    ┌──────────┐ │ users
│  ai-os container     │ ───────────────► │ LiteLLM  │ │ sessions
│  (per-user, spawned  │  /v1/chat/...   │  proxy   │ │ ports
│   on demand)         │                 │ :4000    │─┘
│                      │                 └────┬─────┘
│  ├── opencode serve  │                      │
│  ├── Canva MCP        │                      │ OPENROUTER_API_KEY
│  ├── Grok MCP         │                      ▼
│  ├── Layerre MCP      │              ┌────────────┐
│  └── carousel skill   │              │ OpenRouter  │
└──────────────────────┘              └────────────┘
```

- **One container per user** — isolated filesystem, UID/GID, workspace volume
- **LiteLLM proxy** — holds the single OpenRouter API key centrally; containers get per-tenant virtual keys with spend limits
- **MCP servers** — Canva (OAuth), Grok (xAI image generation), Layerre (template rendering) run inside each container
- **Web frontend** — Next.js 16 App Router with a 3-pane shell (work rail, workflow canvas, agent panel)

## Project structure

```
.
├── web/                     # Next.js frontend + orchestration backend
│   ├── src/app/              # App Router pages, API routes, workflow canvases
│   ├── src/lib/              # Auth, Docker orchestration, agent chat, OAuth
│   └── compose/              # Per-user docker compose overlay
│
├── container/               # Docker base image + MCP servers
│   ├── Dockerfile            # Multi-stage, non-root, parametric UID/GID
│   ├── entrypoint.sh         # Creates per-user OS user, drops privileges
│   ├── opencode.jsonc        # LiteLLM provider + MCP declarations
│   ├── litellm_config.yaml   # Model routing config
│   ├── docker-compose.yml    # Dev harness (litellm + ai-os)
│   ├── skills/               # Agent skills (canva-carousel)
│   ├── carousel/             # Canva carousel automation (Python)
│   ├── mcps/                 # Bundled MCP servers
│   │   ├── grok-mcp/         # xAI Grok image generation
│   │   └── layerre-mcp/      # Layerre template rendering
│   ├── fixtures/             # Template schemas, registries, sample data
│   └── .env.example          # Runtime env template (copy to .env)
│
└── docs/                    # Design specs
```

## Quick start

### Prerequisites

- Docker + Docker Compose
- Node.js 20+
- An OpenRouter API key
- xAI (Grok) and Layerre API keys (for bundled MCPs)

### 1. Container (base image)

```bash
cd container
cp .env.example .env
# Edit .env with your real API keys

docker compose up -d litellm        # Start the model proxy
docker compose run --rm ai-os       # Launch an interactive OpenCode shell
```

On first launch, the Canva MCP prints an OAuth URL — open it in your browser, approve, and the token is cached for subsequent runs.

### 2. Web frontend

```bash
cd web
npm install
npm run seed                        # Create the SQLite database + admin user
npm run dev                         # http://localhost:3000
```

## Workflows

The first workflow is **Carousel Studio** — an end-to-end Canva carousel creator. The agent reads a brief, selects brand templates, generates copy, renders variants via the Canva MCP, and exports final designs.

The architecture generalizes: adding a workflow means registering a skill + canvas component + type definition. Future workflows (newsletter, blog, social posts) plug into the same 3-pane shell.

## License

Private — all rights reserved.
