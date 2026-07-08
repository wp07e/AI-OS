# Workflows

The workflow contract — the single interface a workflow must satisfy and the
numbered recipe for adding one. Extracted from the shell design spec (Section 3).

## 1. Mental model

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

## 2. The `WorkflowDefinition` contract

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

## 3. Filesystem contract

```
/workspace/<folder>/<workflow_instance_id>/
├── state.json        ← REQUIRED. Shell + canvas both read this.
├── memory.md         ← REQUIRED. Agent handoff notes for resume.
├── brief.json        ← CONVENTIONAL. Artifact input spec.
├── exports/          ← CONVENTIONAL. Rendered outputs.
└── <other files>     ← FREE-FORM.
```

**`state.json` is the one hard requirement.** Skill writes it; canvas reads it via `/api/workspace/<id>/state`. If absent, shell shows "working…" and keeps polling — absence is never fatal.

## 4. Polling endpoint (generic, provided by the shell)

```
GET /api/workspace/<workflow_instance_id>/state
  → reads <folder>/<id>/state.json via docker exec
  → returns parsed JSON (or { phase: "unknown" } if absent)

GET /api/workspace/<workflow_instance_id>/file/<path>
  → streams a raw file (PNG, PDF, HTML, anything) via docker exec
  → used for previews, exports, rendered artifacts
```

Workflows never write their own backend endpoints for state. They define a `useState` hook that calls these generic endpoints and parses the result into their own `WorkflowState` shape.

## 5. Adding a workflow — 6 steps

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

## 6. File layout convention

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

## 7. Reusable vs. per-workflow

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

## 8. Forward-compatibility: UI inside the container

The host Next.js is the **orchestrator** (owns shared SQLite DB, cookie auth, dockerode launcher, port pools, OAuth bridge) and stays on host permanently. The "agent authors its own UI" future concerns **canvas components**, not the orchestrator.

The contract is designed so that transition touches **one thing**: the loader.

```
TODAY (loader imports from web/src):
  WORKFLOW_REGISTRY.newsletter.Canvas = NewsletterStudio

FUTURE (loader reads from container workspace):
  const def = await loadWorkflowFromWorkspace("newsletter")
```

The `WorkflowDefinition` interface, the filesystem contract, the `state.json` shape — none of that changes. Only *where the Canvas component comes from* changes.
