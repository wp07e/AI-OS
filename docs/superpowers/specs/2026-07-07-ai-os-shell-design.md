# AI OS Shell Design

**Status:** Approved (2026-07-07)
**Implementation scope this cycle:** Design doc + M0 (shell skeleton) + M1 (workflow sessions). M2–M4 are designed but deferred pending review of M0/M1.

---

## Overview

This design restructures the AI OS from a single chat screen at `/app` into a **3-pane, workflow-driven shell** with the agent at the heart. The first workflow is the Carousel Studio (Canva integration). The architecture generalizes so every future workflow is cheap to add.

The intelligence (skills, MCPs, Canva pipeline) stays inside the per-user container. The web UI becomes a thin shell that hosts workflow canvases and an omnipresent agent panel.

### Foundational decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Interaction paradigm | **Hybrid 3-pane shell** (rail + canvas + agent panel) |
| Navigation | **Workflow-first tool drawers** (rail lists workflow types; each expands to its content) |
| Control flow | **Agent-driven** (chat steers; canvas is a live filesystem view, read-only) |
| Agent topology | **One OpenCode process, one session per workflow instance**, shared persona, file-based memory |
| Workspace observation | **File polling** via `docker compose exec` (pattern already in `oauth-bridge.ts`) |
| Mobile | **Deferred for MVP**; architecture stays responsive-friendly |
| Extensibility | **`WorkflowDefinition` interface contract**; adding a workflow = skill + canvas + registry entry |

---

## Section 1 — The Shell

### 1.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│ AI OS                                            [@user ▾]  │
├───────────────┬──────────────────────────────┬────────────────┤
│  WORK         │  <active workflow canvas>    │   AGENT        │
│  ────────     │  (swaps per workflow)        │   (chat,       │
│  ▾ Carousel   │                              │    per-lane    │
│    • Q3 tips  │                              │    session)    │
│    • Habits   │                              │                │
│  ▸ Newsletter │                              │                │
│  ▸ Blog       │                              │   ┌──────────┐ │
│  ────────     │                              │   │ reply… ↵ │ │
│  LIBRARIES    │                              │   └──────────┘ │
│  ▸ Brand      │                              │                │
│  ▸ Templates  │                              │                │
│  ────────     │                              │                │
│  + New workflow ▾                            │                │
└───────────────┴──────────────────────────────┴────────────────┘
  rail (240px)    canvas (flex-1)              agent (380px, collapsible)
```

### 1.2 Pane behaviors

- **Left rail (240px):** workflow type drawers expand/collapse. Clicking a *type* shows its library; clicking an *item* opens it in the canvas + loads that lane's agent session. `LIBRARIES` holds shared resources (brand kit, templates). `+ New workflow ▾` opens a type picker → creates a new workflow instance (new folder, new session).
- **Center canvas (flex-1):** renders the active workflow's studio component. Each workflow type ships its own canvas. A workflow-specific toolbar sits above it.
- **Agent panel (380px, collapsible):** persistent chat. Same component for all workflows; it targets the *active lane's* session. Collapsible for workflows that want full-width canvas. **Switching workflows re-targets the panel to that lane's session.**

### 1.3 What stays vs. what changes

**Stays (existing foundation):**
- Next.js 16 App Router, React 19, Tailwind v4 (`web/`)
- Per-user Docker container + OpenCode on `:4096` (`container/`)
- LiteLLM → OpenRouter model routing
- Canva OAuth socat workaround (`container/Dockerfile:126-183`)
- 4 MCPs (Canva, Grok, Layerre, sequentialthinking) (`container/opencode.jsonc`)
- `canva-carousel` skill + fixtures (`container/skills/`)
- Custom HMAC cookie auth, SQLite, dockerode (`web/src/lib/`)

**Changes / adds:**
- `/app` becomes the 3-pane shell (replaces single chat at `web/src/app/app/page.tsx`)
- `opencode_sessions` keyed by `(user_id, workflow_instance_id)` instead of user
- New `workflow_instances` table
- New `/api/workspace/*` endpoints (read container files via `docker compose exec`)
- New workflow registry (`web/src/lib/workflows/`)
- Per-workflow `memory.md` + `state.json` convention

### 1.4 Data model

```sql
-- NEW: one row per piece of work (e.g. "Q3 tips carousel")
CREATE TABLE workflow_instances (
  id            TEXT PRIMARY KEY,           -- uuid
  user_id       INTEGER NOT NULL REFERENCES users(id),
  workflow_type TEXT NOT NULL,              -- 'carousel' | 'newsletter' | ...
  title         TEXT NOT NULL,              -- "Q3 tips"
  folder        TEXT NOT NULL,              -- '/workspace/carousels/<id>'
  status        TEXT DEFAULT 'active',      -- 'active' | 'archived'
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- MODIFIED: was keyed by user_id alone; now keyed by (user_id, workflow_instance_id)
CREATE TABLE opencode_sessions (
  user_id              INTEGER NOT NULL REFERENCES users(id),
  workflow_instance_id TEXT NOT NULL REFERENCES workflow_instances(id),
  opencode_session_id  TEXT NOT NULL,
  opencode_port        INTEGER NOT NULL,
  PRIMARY KEY (user_id, workflow_instance_id)
);
```

The container's port stays per-user (one OpenCode process serves many sessions on one port). Only the *session id* is per-workflow.

### 1.5 The workflow registry (extension point)

```ts
// web/src/lib/workflows/types.ts
export interface WorkflowDefinition<S extends WorkflowState = WorkflowState> {
  type: string;                            // 'carousel' | 'newsletter' | ...
  label: string;                           // "Carousel Studio"
  icon: React.ComponentType<{ className?: string }>;
  folder: string;                          // 'carousels' (under /workspace)
  skill: string;                           // OpenCode skill name
  Canvas: React.ComponentType<CanvasProps<S>>;
  useState: (instanceId: string, folder: string) => UseWorkspaceStateResult<S>;
  sessionPrompt?: string;                  // primed when a lane session is created
}
```

The shell renders `<def.Canvas state={def.useState(...)} />` and nothing more. The canvas is a black box the workflow provides. **Adding a workflow = adding one registry entry + a skill + a canvas component.**

### 1.6 Request flow — "create a carousel" end to end

```
1. User clicks "+ New workflow ▾" → "Carousel Studio"
   → POST /api/workflows  { type: 'carousel', title: 'Q3 tips' }
   → backend: insert workflow_instances row
              mkdir /workspace/carousels/<uuid>/ via docker exec
   → respond with { id, folder }

2. Shell opens the workflow; agent panel targets a fresh session

3. User types: "make a carousel about consistency vs motivation"
   → POST /api/tools/message  { workflowInstanceId, text }
   → backend: get-or-create opencode session for (user, workflow_instance)
              POST container:4096/session/:id/message
   → agent loads 'canva-carousel' skill, runs phases, writes files

4. Canvas polls GET /api/workspace/<id>/state every 2.5s
   → backend reads /workspace/carousels/<id>/state.json via docker exec
   → returns structured state
   → canvas re-renders as state grows

5. User: "shorten slide 3's body"
   → same /api/tools/message path → agent rewrites brief.json
   → canvas poll picks up the change on next tick
```

---

## Section 2 — Carousel Studio (first workflow)

### 2.1 The canvas

```
┌─────────────────────────────────────────────────────────────┐
│ CAROUSEL STUDIO · Q3 tips                                   │
│ [Generate] [Reset]                          ← toolbar       │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────┐                 │
│ │       SELECTED SLIDE (big PNG)          │  ← exports/     │
│ │            slide 3 of 6                 │    slide-03.png │
│ └─────────────────────────────────────────┘                 │
│ Slide 3 copy:                              ← read-only      │
│  Headline: "Discipline > Motivation"        from brief.json │
│  Body:     "Motivation fades. Systems..."                   │
│  CTA:      "→ save this post"                               │
│ ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐                   ← filmstrip     │
│ │1●││2 ││3 ││4 ││5 ││6 │                                    │
│ └──┘└──┘└──┘└──┘└──┘└──┘                                    │
│ ✓ Designed in Canva   [Open in Canva ↗]   ← template.json  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Editing model (agent-driven)

The copy panel and preview are **read-only views**. To change slide 3's body, the user types in the agent panel: *"shorten slide 3's body."* The agent rewrites `brief.json` and may re-render → canvas polls → updates. No direct text editing in the canvas. This keeps the agent as the single writer and avoids sync conflicts.

### 2.3 Workspace state contract

```
/workspace/carousels/<workflow_instance_id>/
├── brief.json        ← EXISTS (skill writes it): topic, aspect_ratio, slides[].content
├── template.json     ← EXISTS (Phase 4 capture): design_id, pages[].elements
├── exports/          ← EXISTS (Phase 5): slide-01.png, slide-02.png, ...
├── memory.md         ← NEW: per-instance handoff notes for resume/continuity
└── state.json        ← NEW, REQUIRED: the only hard skill↔canvas coupling
```

**`state.json` shape:**

```jsonc
{
  "phase": "generating_design",      // any string; shell shows as status pill
  "lastUpdated": "2026-07-07T...",   // ISO timestamp
  "errors": [],                      // array of human-readable strings
  // ...workflow-specific fields (slides[], etc.)
}
```

The skill writes `state.json` at each phase boundary (Phase 1 → "planning", Phase 2 → "generating_assets", etc.). **Absence is non-fatal** — if `state.json` is missing or malformed, the UI shows "working…" and keeps polling.

**`memory.md` resume contract** — gives bounded-context sessions continuity without context bloat:

```markdown
# <Workflow Instance Title>
## Status
## Decisions
## Resume Here
## Notes
```

When a lane session is created, the session prompt tells the agent: *"Before working, read /workspace/<folder>/<id>/memory.md and state.json."*

### 2.4 Polling response shape

```
GET /api/workspace/<workflow_instance_id>/state
→
{
  "phase": "exporting",                 // from state.json, or "unknown"
  "brief": { topic, aspect_ratio, slides: [{ content: {...} }] },
  "renders": [{ slide: 0, "url": "/api/workspace/<id>/file/exports/slide-01.png" }],
  "design": { design_id, canva_url },  // from template.json if present
  "errors": []
}
```

### 2.5 Carousel components

```
web/src/app/app/(workflow)/carousel/
├── CarouselStudio.tsx          ← top-level canvas (registered)
├── SlidePreview.tsx            ← big selected-slide PNG
├── SlideCopyPanel.tsx          ← read-only headline/body/cta
├── Filmstrip.tsx               ← thumbnail row + selection
├── DesignCard.tsx              ← Canva design link card
├── StudioToolbar.tsx           ← Generate / Export / Reset
└── useCarouselState.ts         ← polling hook (2.5s, focus-aware)
```

---

## Section 3 — The Workflow Contract (developer guide)

This section is intended to become `WORKFLOWS.md` (extracted in M4). It defines the single interface a workflow must satisfy and the numbered recipe for adding one.

### 3.1 Mental model

> A workflow is a **skill** (in the container) plus a **canvas** (in the web app) that agree on a **folder layout** and a **state file**. The shell hosts the canvas; the agent drives the folder. They never talk to each other directly.

```
                 ┌─────────────────────────────┐
                 │   THE SHELL (host, stable)  │
                 │   renders Canvas, hosts     │
                 │   agent panel, manages      │
                 │   sessions                  │
                 └─────────────┬───────────────┘
                               │ hosts via WorkflowDefinition
                    ┌──────────┴──────────┐
                    ▼                     ▼
        ┌───────────────────┐   ┌───────────────────┐
        │  CANVAS (web)     │   │  SKILL (container)│
        │  reads state via  │   │  writes state via │
        │  /api/workspace   │   │  file ops         │
        └────────┬──────────┘   └──────────┬────────┘
                 └─────────┬───────────────┘
                           ▼
              ┌────────────────────────────┐
              │  /workspace/<folder>/<id>/ │
              │   state.json (REQUIRED)    │  ← the ONLY hard contract
              │   memory.md (REQUIRED)     │
              │   <workflow-specific files>│
              └────────────────────────────┘
```

The filesystem is the only coupling between skill and canvas. There is no shared code, no imports, no RPC. This is what makes the canvas swappable to live inside the container later.

### 3.2 The `WorkflowDefinition` contract

```ts
// web/src/lib/workflows/types.ts
import type { ComponentType } from "react";

export interface WorkflowState {
  phase: string;              // REQUIRED: progress signal
  lastUpdated: string;        // REQUIRED: ISO timestamp
  errors: string[];           // REQUIRED: surfaced in shell chrome
  [key: string]: unknown;     // workflow-specific fields
}

export interface CanvasProps<S extends WorkflowState> {
  instanceId: string;
  folder: string;
  state: S;
}

export interface UseWorkspaceStateResult<S> {
  state: S | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

export interface WorkflowDefinition<S extends WorkflowState = WorkflowState> {
  /* 1. IDENTITY (rail + routing) */
  readonly type: string;                                    // unique
  readonly label: string;                                   // rail display
  readonly icon: ComponentType<{ className?: string }>;
  readonly description?: string;                            // "+ New workflow" picker

  /* 2. WORKSPACE (filesystem layout) */
  readonly folder: string;                                  // subfolder under /workspace
  readonly skill: string;                                   // OpenCode skill name

  /* 3. CANVAS (100% workflow-owned) */
  readonly Canvas: ComponentType<CanvasProps<S>>;

  /* 4. STATE OBSERVATION */
  readonly useState: (instanceId: string, folder: string) => UseWorkspaceStateResult<S>;

  /* 5. SESSION PRIMING (optional) */
  readonly sessionPrompt?: string;
}
```

### 3.3 Filesystem contract

```
/workspace/<folder>/<workflow_instance_id>/
├── state.json        ← REQUIRED. Shell + canvas both read this.
├── memory.md         ← REQUIRED. Agent handoff notes for resume.
├── brief.json        ← CONVENTIONAL. Artifact input spec.
├── exports/          ← CONVENTIONAL. Rendered outputs.
└── <other files>     ← FREE-FORM.
```

**`state.json` is the one hard requirement.** Skill writes it; canvas reads it via `/api/workspace/<id>/state`. If absent, shell shows "working…" and keeps polling — absence is never fatal.

### 3.4 Polling endpoint (generic, provided by the shell)

```
GET /api/workspace/<workflow_instance_id>/state
  → reads <folder>/<id>/state.json via docker exec
  → returns parsed JSON (or { phase: "unknown" } if absent)

GET /api/workspace/<workflow_instance_id>/file/<path>
  → streams a raw file (PNG, PDF, HTML, anything) via docker exec
  → used for previews, exports, rendered artifacts
```

Workflows never write their own backend endpoints for state. They define a `useState` hook that calls these generic endpoints and parses the result into their own `WorkflowState` shape.

### 3.5 Adding a workflow — 6 steps

```
1. Write the skill (container)         ── the agent brain
2. Define the state shape (types)      ── the contract
3. Write the useState hook (web)       ── the observer
4. Write the Canvas component (web)    ── the UI (free-form, the bulk)
5. Register in WORKFLOW_REGISTRY (web) ── the plug
6. Test end-to-end                     ── the smoke test
```

**Step 1 — Skill:** Create `container/skills/<type>/SKILL.md` following `canva-carousel`. Must operate inside `/workspace/<folder>/<instance_id>/`, write `state.json` at phase boundaries, write `memory.md` on completion/pause, write its artifact files.

**Step 2 — State shape:**

```ts
// web/src/app/app/(workflow)/newsletter/types.ts
export interface NewsletterState extends WorkflowState {
  subject: string;
  preheader: string;
  sections: { id: string; heading: string; body: string }[];
  previewHtml: string | null;
}
```

**Step 3 — useState hook:**

```ts
// useNewsletterState.ts
export function useNewsletterState(instanceId: string, folder: string) {
  return useWorkspaceState<NewsletterState>(instanceId, {
    intervalMs: 2500,
    parse: (raw) => ({ ...raw, sections: raw.sections ?? [], previewHtml: raw.previewHtml ?? null }),
  });
}
```

The shell provides `useWorkspaceState<T>()` — generic polling with focus-awareness, error handling, manual `refresh()`. The workflow supplies only the typed parser.

**Step 4 — Canvas component** (the only step with no template):

```tsx
export function NewsletterStudio({ instanceId, state, folder }: CanvasProps<NewsletterState>) {
  return (
    <div className="flex flex-col h-full">
      <NewsletterToolbar instanceId={instanceId} />
      <EmailPreview htmlPath={state?.previewHtml} />
      <SectionList sections={state?.sections ?? []} />
    </div>
  );
}
```

The canvas is fully workflow-owned: toolbar, layout, sub-components, interactions. The shell renders `<Canvas/>` inside the center pane and passes three props. Nothing else is assumed.

**Step 5 — Register:**

```ts
export const WORKFLOW_REGISTRY = {
  carousel: carouselDefinition,
  newsletter: {
    type: "newsletter",
    label: "Newsletter",
    icon: MailIcon,
    folder: "newsletters",
    skill: "newsletter",
    Canvas: NewsletterStudio,
    useState: useNewsletterState,
    sessionPrompt: "You are working in the Newsletter workflow. Read memory.md and state.json before acting.",
  },
} satisfies Record<string, WorkflowDefinition>;
```

**Step 6 — Test:** create instance → chat → watch canvas poll → verify phase pill → verify memory.md written → switch away/back → session resumes from memory.md.

### 3.6 File layout convention

```
web/src/app/app/(workflow)/
├── carousel/
│   ├── types.ts
│   ├── useCarouselState.ts
│   ├── CarouselStudio.tsx
│   └── components/
└── newsletter/
    ├── types.ts
    ├── useNewsletterState.ts
    ├── NewsletterStudio.tsx
    └── components/

container/skills/
├── canva-carousel/SKILL.md
└── newsletter/SKILL.md
```

The `(workflow)` route group is a Next.js convention — parentheses don't affect URL. All workflows render inside `/app`; the shell swaps the active canvas.

### 3.7 Reusable vs. per-workflow

| Component | Built once? | Reused by every workflow |
|---|---|---|
| 3-pane shell | ✅ | ✅ |
| Left rail, drawers, picker | ✅ | ✅ |
| Agent panel + session targeting | ✅ | ✅ |
| `/api/tools/message` (chat) | ✅ (exists) | ✅ |
| `/api/workspace/*` (state + files) | ✅ | ✅ |
| `useWorkspaceState<T>()` generic hook | ✅ | ✅ |
| Session create/cache (per-instance) | ✅ | ✅ |
| `workflow_instances` table | ✅ | ✅ |
| **Skill** (`SKILL.md`) | ❌ | ❌ — per workflow |
| **State shape** (`types.ts`) | ❌ | ❌ — per workflow |
| **`useState` parser** | ❌ (tiny) | ❌ — per workflow |
| **Canvas component tree** | ❌ | ❌ — per workflow (the bulk) |

**Adding a workflow = 1 skill + 1 state type + 1 small hook + 1 canvas tree + 1 registry line.** Everything else is inherited.

### 3.8 Forward-compatibility: UI inside the container

The host Next.js is the **orchestrator** (owns shared SQLite DB, cookie auth, dockerode launcher, port pools, OAuth bridge) and stays on host permanently. The "agent authors its own UI" future concerns **canvas components**, not the orchestrator.

The contract is designed so that transition touches **one thing**: the loader.

```
TODAY (loader imports from web/src):
  WORKFLOW_REGISTRY.newsletter.Canvas = NewsletterStudio

FUTURE (loader reads from container workspace):
  const def = await loadWorkflowFromWorkspace("newsletter")
```

The `WorkflowDefinition` interface, the filesystem contract, the `state.json` shape — none of that changes. Only *where the Canvas component comes from* changes.

---

## Section 4 — Implementation Roadmap

### 4.1 Build philosophy: vertical slice first

Build a thin vertical slice that proves the whole loop end-to-end, then broaden. Avoid building the whole shell before the carousel works.

### 4.2 Milestones

| Milestone | Scope | Risk |
|---|---|---|
| **M0** | Shell skeleton replaces `/app`; chat moves to agent panel | Low (layout refactor) |
| **M1** | Workflow sessions: new tables, per-instance session keying | Medium (touches working code; clean-slate testing assumed) |
| **M2** | Workspace observation: `/api/workspace/*` via `docker exec`, `useWorkspaceState<T>()` | Low (exec pattern established in `oauth-bridge.ts`) |
| **M3** | Carousel Studio canvas + skill update (`state.json`/`memory.md`) | Low UI / Medium skill |
| **M4** | Polish + extract contract + write `WORKFLOWS.md` | Low |

### 4.3 M0 — Shell skeleton

**Goal:** 3-pane shell renders; chat moves to agent panel; no workflows yet.

- Replace `web/src/app/app/page.tsx` (single chat) with `AppShell` (3-pane layout)
- `AppShell.tsx`: rail (empty/placeholder) + canvas (placeholder "no workflow") + agent panel
- Move existing chat UI into `AgentPanel.tsx`; reuse `/api/tools/message` unchanged
- Preserve the current user-keyed session behavior unchanged (no DB changes, no workflow instances yet — M0 ships before M1 introduces per-instance keying). The agent panel calls `/api/tools/message` exactly as today.
- Keep `/app/settings` as-is

**Done when:** login → 3-pane shell → chat works in agent panel as before.

### 4.4 M1 — Workflow sessions (clean-slate testing assumed)

**Goal:** session-per-workflow-instance model. Foundational change everything else depends on.

- Add `workflow_instances` table migration in `web/src/lib/db.ts` (destructive OK in dev)
- Reshape `opencode_sessions` PK to `(user_id, workflow_instance_id)`; update `getOrCreateSession`/`invalidateSession` in `web/src/lib/opencode.ts`
- `POST /api/workflows` — create instance (insert row + `mkdir` in container workspace via `docker exec`)
- `GET /api/workflows` — list instances for the rail
- `POST /api/tools/message` — accept `workflowInstanceId`, target correct session
- Wire rail to list instances; "+ New workflow" creates one (carousel type; canvas stays placeholder in M1)
- Update `web/scripts/seed.ts` if needed for clean resets

**Done when:** two carousel instances have independent sessions; switching lanes switches session; chat works per-lane.

**Testing assumption:** DB/container state resets to initial between runs. No data-preservation logic needed in M1.

### 4.5 M2 — Workspace observation (deferred)

**Goal:** the shell can read files from the container's workspace via `docker compose exec`.

- `/api/workspace/<instanceId>/state` — reads `state.json` via docker exec
- `/api/workspace/<instanceId>/file/<path>` — streams raw file via docker exec
- `useWorkspaceState<T>()` generic hook — polling, focus-aware, error-tolerant
- `useBreakpoint()` hook (cheap insurance for mobile-later)

**Risk: low.** The exec pattern is already used in `oauth-bridge.ts`. Latency (~50-100ms) is fine for 2.5s polling.

### 4.6 M3 — Carousel Studio canvas (deferred)

**Goal:** first real workflow. Proves the pattern.

- `CarouselState` type, `useCarouselState` hook
- `CarouselStudio.tsx` + child components
- Register `carousel` in `WORKFLOW_REGISTRY`
- Update `container/skills/canva-carousel/SKILL.md` to write `state.json` + `memory.md`

**Done when:** create carousel → chat → canvas populates → click slides → open Canva design.

### 4.7 M4 — Polish + contract docs (deferred)

- Extract `WorkflowDefinition`, `useWorkspaceState<T>`, registry loader into clean modules
- Write `WORKFLOWS.md` (Section 3 verbatim)
- Session-resume priming ("read memory.md + state.json")
- Empty/error/loading states across the shell
- Phase pill in shell chrome

### 4.8 Deferred (not in MVP)

- Mobile layouts (architecture supports; deferred per decision)
- Multiple specialized agent personas (shared persona for v1)
- Agent-authored UI in container (loader-swap only)
- Second workflow (uses M4 docs)
- Real-time agent SSE streaming (REST fine for v1; SSE is drop-in later)
- User registration/multi-tenant (keep single seeded user)
- Workflow templates / brand library UI

### 4.9 Definition of done for the MVP

```
✓ Log in → see 3-pane shell (not the old single chat)
✓ Click "+ New workflow → Carousel Studio"
✓ Type in agent panel: "make a 6-slide IG carousel about X"
✓ Watch the canvas populate as the skill runs
✓ Click slides in the filmstrip to preview
✓ Open the generated Canva design from the canvas
✓ Create a second carousel instance; it has its own session
✓ Switch between instances; each remembers context via memory.md
✓ Follow WORKFLOWS.md to add a stub second workflow
```

---

## Implementation scope for THIS cycle

**Step 0 + M0 + M1 only.** M2–M4 are designed but not implemented; they proceed after review of the working shell + session model.
