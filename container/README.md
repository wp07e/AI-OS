# AI OS — Base Image (Phase 1)

The base Docker image for the AI OS product. Ships OpenCode + the official
Canva MCP server + a Canva carousel skill skeleton. One image, spawned once
per user, isolated at runtime via parametric UID/GID and per-user workspace
volumes. OpenCode's model traffic is routed through a separate LiteLLM proxy.

This phase delivers the **base image**, the **Canva carousel automation
skill**, and a **dev harness** to prove the wiring. The marketing/subscription
website and production orchestration come in later phases.

---

## What's in this repo

```
.
├── Dockerfile                  # multi-stage, non-root, parametric UID/GID
├── entrypoint.sh               # creates the per-user OS user, drops privileges
├── opencode.jsonc              # LiteLLM provider + Canva MCP declaration
├── docker-compose.yml          # dev harness: ai-os + litellm
├── litellm_config.yaml         # one-route dev proxy config
├── .env.example                # every runtime env var (no secrets in image)
├── .dockerignore
├── skills/
│   └── canva-carousel/
│       └── SKILL.md            # the Canva carousel automation skill
├── fixtures/
│   ├── templates.registry.jsonc# manifest of brand-template variants
│   ├── sample-dataset.json     # working autofill payload
│   ├── sample-bulk-create.csv  # CSV mirroring the dataset keys
│   └── README.md
└── README.md                   # this file
```

---

## Quick start (dev)

```bash
cp .env.example .env
# edit .env: set OPENAI_API_KEY to a real backing-provider key

docker compose up -d litellm           # start the model proxy
docker compose run --rm ai-os          # interactive opencode shell
```

On first launch inside the container, the Canva MCP will print an OAuth URL.
Open it, approve in the browser, and the token is cached in the workspace
volume — subsequent launches are headless.

---

## Model routing — OpenRouter behind LiteLLM

OpenCode never talks to OpenRouter directly. LiteLLM sits in between and holds
**your single OpenRouter API key centrally**. Each container gets a per-tenant
**virtual key** from LiteLLM, which buys you:

- The OpenRouter key never leaves the LiteLLM service — containers can't leak it.
- Per-tenant spend limits, budgets, and routing (e.g. cheap model for tier 1,
  premium model for tier 2).
- One place to swap backends later (add Anthropic direct, a self-hosted model,
  etc.) without touching container images.

```
┌──────────────┐   virtual key   ┌──────────┐  OPENROUTER_API_KEY  ┌────────────┐
│  ai-os       │ ──────────────► │ LiteLLM  │ ───────────────────► │ OpenRouter │
│  (per user)  │  /v1/chat/...   │  proxy   │  /api/v1/chat/...    │            │
└──────────────┘                 └──────────┘                      └────────────┘
```

### Wiring (one-time)

1. Put your real OpenRouter key in `.env` as `OPENROUTER_API_KEY`.
2. Set `LITELLM_MASTER_KEY` to a strong random string you generate.
3. The route itself lives in `litellm_config.yaml` — change the OpenRouter
   slug there to whichever model you want as `default`.

### Onboarding a new user (per-tenant virtual key)

For each paying user, mint a LiteLLM virtual key against the master key, then
launch that user's container with that key:

```bash
# 1. Mint a per-user virtual key (against the running LiteLLM master key).
VIRTUAL_KEY=$(curl -sS http://localhost:4000/key/generate \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"key_alias": "user-42","max_budget": 50,"models": ["default"]}' \
  | jq -r .key)

# 2. Launch that user's container with their virtual key + isolated workspace.
APP_UID=1042 APP_GID=1042 OPENAI_API_KEY="$VIRTUAL_KEY" \
  docker compose run --rm \
    -v ai-os-workspace-user42:/workspace \
    -e OPENAI_API_KEY="$VIRTUAL_KEY" \
    ai-os
```

The container only ever sees `$VIRTUAL_KEY` — it has no knowledge of
`OPENROUTER_API_KEY`. Revoke the user (refund/churn) by deleting their virtual
key in LiteLLM; their container instantly stops working, with no key rotation
on the OpenRouter side.

### Dev / single-user mode

If you just want to test locally, skip the virtual-key step and set
`OPENAI_API_KEY` in `.env` equal to your `LITELLM_MASTER_KEY`. OpenCode will
hit LiteLLM as the master; LiteLLM forwards to OpenRouter.

---

## How per-user isolation works

The same image serves every user. The orchestrator varies three things per
instance:

| Knob | How |
|---|---|
| **UID/GID** | `APP_UID` / `APP_GID` env → `entrypoint.sh` materializes a matching OS user and `chown`s the workspace. Files in the mounted volume land owned by the right user on the host. |
| **Workspace** | A dedicated volume mounted at `/workspace`. Holds OpenCode state, the Canva OAuth token cache, and generated designs. Never shared between users. |
| **Model key** | `OPENAI_API_KEY` (LiteLLM virtual key) — metered/routed per tenant by LiteLLM. |

Spawn a second user (dev demo):

```bash
APP_UID=1001 APP_GID=1001 \
  docker compose run --rm -v ai-os-workspace-user2:/workspace ai-os
```

---

## The Canva automation contract

The whole flow rests on **identical field names** across three places:

```
Canva Bulk Create column  ─┐
                           ├── must match exactly
autofill payload key       ─┘
                           │
templates.registry fields  ─┘
```

1. **Human (one-time, in Canva UI):** build the carousel, open Bulk Create,
   add columns named `slide_N_headline` / `slide_N_body` / `slide_N_cta`,
   connect each text element to its column, save as a Brand Template. Full
   instructions: [`skills/canva-carousel/SKILL.md`](skills/canva-carousel/SKILL.md) → Part 1.
2. **Agent (every run):** reads the variant from `fixtures/templates.registry.jsonc`,
   builds the payload per the field-naming convention, calls the Canva MCP
   `autofill` tool, polls the job, exports PNG/PDF into the workspace.

Replace the placeholder entries in `fixtures/templates.registry.jsonc` with
your real `brand_template_id`s once the templates are wired. See
[`fixtures/README.md`](fixtures/README.md).

---

## Notes & caveats

- **No secrets in the image.** Canva OAuth is per-user; LiteLLM virtual key is
  env-injected at runtime.
- **LiteLLM stays external.** The base image only needs to know its base URL;
  routing, metering, and model swaps happen in the proxy.
- **Canva brand-template ID format migrated in September 2025.** If an ID from
  before then 404s, re-list templates via the MCP and update the registry.
- **Brand Templates API requires Canva Enterprise** for some operations. The
  remote MCP handles this transparently but the connected account needs the
  right plan.
- **Bulk Create + field wiring is a manual Canva-UI task** and cannot be done
  via the API/MCP — that's why it's documented as Part 1 of the skill.

---

## Sources

- [Canva MCP Documentation](https://www.canva.dev/docs/mcp/)
- [Canva Connect Autofill Guide](https://www.canva.dev/docs/connect/autofill-guide/)
- [Canva Connect API OpenAPI spec](https://github.com/canva-sdks/canva-connect-api-starter-kit/blob/main/openapi/spec.yml)
- [OpenCode Config docs](https://opencode.ai/docs/config/)
- [OpenCode Skills docs](https://opencode.ai/docs/skills/)
