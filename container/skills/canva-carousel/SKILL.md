---
name: canva-carousel
description: >
  Generate Canva carousels using the standard Canva MCP design tools, then
  capture the result as a durable per-element template for future edits.
  Works within the Canva MCP's actual capabilities (content-editing, not
  layout-authoring). Brief in → generate → capture template → edit against
  element_ids.
---

# Canva Carousel Automation

This skill produces finished Canva carousels and maintains a durable, editable
contract for each one. The model has four moving parts:

```
brief.json     →   generate-design    →   template.json    →    edits
(intent)            (Canva's choice)       (ground truth)       (by element_id)
```

If you have not read `fixtures/README.md`, do so first — it explains why this
is shaped the way it is (Canva MCP cannot enforce a prescriptive spec, so we
let Canva author and then freeze what it produced).

---

## The two artifacts

1. **Brief** — what the user gives the AI. Schema: `fixtures/brief.schema.jsonc`.
   Sample: `fixtures/brief.sample.json`. A brief is INTENT, not a contract.
   It carries the **brand library**: `colors`, `typography`, `icons`,
   `assets`, `components`, plus `logo` and `voice`. Slides reference library
   items by name.

2. **Template** — what the AI captures after `generate-design` runs. Schema:
   `fixtures/template.schema.jsonc`. Written to
   `/workspace/carousels/<deck_id>/template.json`. This IS the contract —
   every future edit resolves against `element_id`s in this file. Each
   element may carry an advisory `source_ref` linking it back to the brand
   library item that requested it.

`fixtures/layouts.registry.jsonc` provides **prompt vocabulary** (archetype
names like `hero`, `split`, `editorial`) the agent uses when constructing the
natural-language `generate-design` query. It is NOT validated against — Canva
may deviate freely.

### The brand library — five channels

`brand.{colors, typography, icons, assets, components}` form a single named
library referenced by slides. Each channel gets into Canva differently:

| Channel | Path | Notes |
|---|---|---|
| `colors` | Description only → rendered into the prompt as hex + usage guidance | No upload. |
| `typography` | Description only → rendered into the prompt | **No font-file upload tool in the Canva MCP.** Families must be in Canva's catalog or manually uploaded by the user to their Brand Kit first. Surface silent fallbacks in the report. |
| `icons` | Upload via `upload-asset-from-url` → `asset_id` | Each entry is an asset directive (`{url}` / `{generate}` / `null`). |
| `assets` | Same upload path as icons | Textures, patterns, illustrations, photos. |
| `components` | Description only → `generate-design` recreates per use | **Not real Canva components.** After capture, instances are ordinary element_ids with an advisory `source_ref`. Editing one slide's component does not affect others. |

---

## Status contract — `state.json` + `memory.md`

The generic `state.json` shape (`phase` / `lastUpdated` / `errors`) and the
`memory.md` resume contract are defined once in **`/workspace/AGENTS.md** — read
it for the rules that apply to every workflow. This section covers only what's
**carousel-specific**.

The Carousel Studio canvas polls `state.json` to render slides, copy, and the
Canva link. Beyond the three required fields, enrich `state.json` with these
carousel fields as they become known:

```jsonc
{
  // ...phase, lastUpdated, errors per /workspace/AGENTS.md...
  "brief": {                               // filled at Phase 1
    "topic": "...",
    "aspect_ratio": "4:5",
    "slide_count": 6
  },
  "slides": [                              // filled at Phase 1, refined at Phase 4
    { "index": 0, "headline": "...", "body": "...", "cta": "...", "archetype": "hero" },
    ...
  ],
  "design": {                              // filled at Phase 3
    "design_id": "D...",
    "canva_url": "https://www.canva.com/design/..."
  }
}
```

**Phase → `phase` string map** (write a fresh `state.json` at each boundary):

| Skill phase | `phase` value | When |
|---|---|---|
| Phase 1 start / end | `planning` | Parsing the brief |
| Phase 2 start | `resolving_assets` | Generating/uploading assets |
| Phase 2 end | `assets_resolved` | All asset_ids captured |
| Phase 3 start | `generating_design` | `generate-design` kicked off |
| Phase 3 end | `design_generated` | Candidate accepted, `design_id` known — **fill `design` now** |
| Phase 4 start | `capturing_template` | Walking pages |
| Phase 4 end | `template_captured` | `template.json` written — **refine `slides[]` copy if Canva rewrote it** |
| Phase 5 start | `exporting` | `export-design` running |
| Phase 5 end | `complete` | Exports + report done |
| Any error | (keep current phase, or `"<phase>_failed"`) | Push a human-readable string to `errors[]` |

On any failure, follow the error rule in `/workspace/AGENTS.md` (push a
human-readable string to `errors[]`, keep the phase honest) before reporting.

### Folder naming

This skill's prose says `/workspace/carousels/<deck_id>/`. In the AI OS shell,
**`<deck_id>` is the workflow instance id** — the host creates the folder as
`/workspace/carousels/<instance-id>/` when the instance is made, and the
per-instance `AGENTS.md` in that folder names it concretely. Use the active
instance folder (the one whose `AGENTS.md` you read on startup) as the deck
folder. Do not invent your own `<deck_id>`.

---

## The hard constraint (read this before any edit phase)

The Canva MCP **cannot add elements** to an existing design. Supported edit
operations are:

```
update_title            replace_text            find_and_replace_text
update_fill             insert_fill             delete_element
position_element        resize_element          format_text
update_autofill_field
```

There is no `insert_text` and no `insert_element`. So:

- If a slide is missing a CTA → **you cannot add one**.
- If a slide needs a second image → **you cannot add a slot**.
- `delete_element` works but does NOT auto-reflow; remaining elements stay at
  fixed coordinates, leaving a visual gap. Surface this when proposing
  deletions.

When a user asks for something the template cannot support, respond:

> Cannot add elements to an existing Canva design via MCP.
> Options: (a) regenerate that slide from a new brief, (b) finish in Canva UI
> manually.

---

## Workflow

When the user asks to produce a carousel, run phases 1–5. Phase 6 happens on
subsequent invocations when they want to edit.

### Phase 1 — Parse brief + brand library

1. Locate input: the user gives a file path, asks to use the sample at
   `fixtures/brief.sample.json`, or describes what they want (in which case
   you emit a brief JSON yourself following `brief.schema.jsonc`).
2. Create the deck folder: `/workspace/carousels/<deck_id>/`. Copy the brief
   to `/workspace/carousels/<deck_id>/brief.json`. Create empty `assets/` and
   `exports/` subdirs.
3. **Write `state.json`** with `phase: "planning"`, `brief` {topic,
   aspect_ratio, slide_count}, and a `slides[]` entry per slide (index,
   headline, body, cta, archetype — copied from the brief). This is what makes
   the canvas filmstrip + copy panel appear before any rendering happens.
4. **Validate the brand library references.** Every name that appears in any
   slide's `icons[]`, `assets[]`, or `components[].name` MUST exist as a key
   in the corresponding `brand.icons` / `brand.assets` / `brand.components`
   block. Same for component `slots[].ref` values, which may point at either
   `brand.icons` or `brand.assets`. Fail fast with a clear message:
   `"slide N references icon 'X' but brand.icons has no entry named 'X'"`
   (and push it to `state.errors` before reporting).
5. Inventory asset directives across the whole brief:
   - every `brand.icons.*`, `brand.assets.*`, `brand.logo`, `slides[].image`
   - every component slot whose value is `{url}` / `{generate}` / `{ref}`
   Classify each as `{url}`, `{generate:true, brief}`, `{ref:"<name>"}` (resolve
   to the referenced library entry, which is itself one of the other forms),
   or `null`.

### Phase 2 — Resolve assets

**Write `state.json` with `phase: "resolving_assets"` before you start.**

For every `{"generate": true, "brief": "..."}` directive (deduplicated by
brief text — generate once, reuse):

1. Call the Grok MCP `generate_image` tool with the brief (default model
   `grok-imagine-image`). Capture the returned public image URL.
2. Call the Canva MCP `upload-asset-from-url` tool with that URL. Capture the
   returned `asset_id`.
3. Record both in `/workspace/carousels/<deck_id>/assets/<library>-<name>.json`:
   `{ "source_url": "...", "asset_id": "...", "brief": "..." }`.

For every `{"url": "..."}` directive, skip step 1 and go straight to step 2.
Same recording.

For `{ref: "X"}` directives in component slots: look up `X` in
`brand.icons` then `brand.assets`, and use that entry's already-resolved
`asset_id` — do not re-upload.

For `null` directives, no upload — Canva will pick stock imagery during
`generate-design`. Note this in the prompt.

Build the deck-level `brand_resolved` map per `template.schema.jsonc`:
- `icons` / `assets` / `logo`: name → `{asset_id, source_url, brief}`.
- `color_usage_applied: true`, `typography_applied: true` (description-only
  channels — they will be rendered into the prompt at Phase 3).

Description-only channels (`colors`, `typography`, `components`) require no
uploads. They get rendered into the prompt verbatim at Phase 3.

**Write `state.json` with `phase: "assets_resolved"` once the `brand_resolved`
map is complete.**

### Phase 3 — Generate

**Write `state.json` with `phase: "generating_design"` before calling
`generate-design`.**

Build the `generate-design` prompt from brand + slides. Use archetype names
from `layouts.registry.jsonc` as composition vocabulary.

**Brand preamble** (rendered at the top of the prompt, applies to every slide):

```
Brand: <brand.name>. Voice: <brand.voice>.

Colors (use exactly as specified):
  background     #0B0B0F  — <color_usage.background>
  accent         #7C5CFF  — <color_usage.accent>
  ...all roles from brand.colors + color_usage...

Typography:
  <typography.pairing>
  Roles:
    headline  — <family> <weight> <case>, tracking <letter_spacing>,
                line-height <line_height>, size <size_hint>
    body      — ...
    ...all roles from brand.typography.roles...
  Fallback: <typography.fallback>
  Notes: <typography.notes>

Preserve this identity on every slide. Vary composition for pacing; do not
vary the color palette or typography.
```

**Per-slide block:**

```
Slide N — <archetype_suggestion or "no specific composition">:
  Intent: <slide.intent>
  Headline: "<content.headline>"      ← render verbatim
  Body: "<content.body>"              ← render verbatim
  CTA: "<content.cta>"                ← render verbatim

  Image: <asset_id pinned | "let Canva pick stock per brief: ...">
  Icons: <name → asset_id list, or "none specified">
  Assets: <name → asset_id list of decorative textures/patterns, or "none">
  Components:
    <component_name>: <components[name].description>
      slot <slot.name> (role <slot.role>): <slot.description>
        → content: "<override or default>"
        → icon/image: <asset_id from slot ref, or "none">
```

Verbatim-copy rule: always tell Canva to render headline/body/cta copy
exactly as in the brief. If Canva still rewrites it (it often does), capture
the rewrite as-is in Phase 4 — the user can `replace_text` to restore the
verbatim copy as an edit later.

Call `generate-design` with `design_type` chosen by aspect ratio:
- `4:5` → `instagram_post`
- `1:1` → `instagram_post` (square)
- `16:9` → `presentation`
- `9:16` → `your_story`

`generate-design` is async and returns a `job_id` with candidate designs.
Poll `get-design-candidates`; pick the strongest candidate and call
`create-design-from-candidate` to get an editable `design_id`. Capture the
design URL.

If generation produced the wrong aspect ratio, surface it to the user and
either accept or regenerate — do not silently proceed.

**Write `state.json` with `phase: "design_generated"` and fill the `design`
field (`design_id` + `canva_url`) now** — this is what surfaces the "Open in
Canva" link in the canvas.

### Phase 4 — Capture template

**Write `state.json` with `phase: "capturing_template"` before walking pages.**

1. Call `start-editing-transaction` with the `design_id`.
2. Walk every page via `get-design-pages` (and `get-design-content` for
   richtexts if needed). For each page, capture:
   - `page_id`, `page_index`, `width`, `height`, `is_responsive`.
   - For every element: `element_id`, `type`, `text` (if text), `asset_id`
     (if image/video), `position`, `size`, `rotation`, `opacity`.
3. Assign `inferred_role` per element using simple heuristics — advisory only:
   - largest text on page → `"headline"`
   - multi-word text below headline → `"body"`
   - short text containing →/swipe/start → `"cta"`
   - image element → `"image"`
   - small text under an image → `"caption"`
   - leave null if unclear; never block on role assignment.
4. **Assign `source_ref` per element** when you can match it back to a brand
   library item:
   - if `element.asset_id` matches a resolved `brand.icons.<name>.asset_id`
     → `{library:"icons", name:"<name>", slot:null}`.
   - same for `brand.assets.<name>` → `{library:"assets", ...}`.
   - same for `brand.logo` → `{library:"logo", ...}`.
   - for component-derived elements, match by position/slot intent (best
     effort, advisory): e.g. the small text near a pill shape on a slide
     that declared `cta_pill` → `{library:"components", name:"cta_pill",
     slot:"label"}`.
   - leave `source_ref: null` for elements Canva generated on its own
     (phantom text, stock imagery it picked, decorative shapes not in the
     library). These have no brand-library provenance.
5. Attach the `brand_resolved` map built in Phase 2 to the template root.
6. Optionally clean phantom elements (presenter name, contact info, "Ready")
   via `delete_element` — but WARN the user first, because deletions leave
   gaps. Default behavior: leave phantoms in place, flag them in the report,
   let the user decide whether to delete in Phase 6.
7. Emit `/workspace/carousels/<deck_id>/template.json` per
   `template.schema.jsonc`. Include the `constraint` block
   (`cannot_add_elements: true`, `deletion_leaves_gap: true`) so tooling sees
   it explicitly.
8. `commit-editing-transaction` (or `cancel-editing-transaction` if you only
   walked pages and changed nothing).

**Write `state.json` with `phase: "template_captured"`.** If Canva rewrote any
slide's headline/body/cta during generation (it often does), update the
matching `slides[]` entry in `state.json` to match what's actually in the design
so the canvas copy panel reflects reality.

### Phase 5 — Export & report

**Write `state.json` with `phase: "exporting"` before you call `export-design`.**

1. For each entry in `brief.exports[]`, call `export-design` with the
   `design_id`:
   - PNG with `per_page: true` writes one PNG per slide.
   - PDF writes a single multi-page file.
   Write outputs under `/workspace/carousels/<deck_id>/exports/`.
2. Report back to the user:
   - the design URL,
   - the local `template.json` path (this is the deliverable for future edits),
   - a per-slide element summary: `page_index → [element_id, type, content or
     asset_id, inferred_role]`,
   - any deviations from the brief (missing CTAs, phantom text, wrong aspect
     ratio, invented body copy) — with a one-line remedy for each ("Phase 6:
     `replace_text` on element X to restore verbatim copy").

**Write `state.json` with `phase: "complete"`.** Then **append a handoff to
`memory.md`** (per the Status contract above): status, decisions, what to do
next on resume, and any gotchas (font fallbacks, deviations, asset re-uploads).
This is what lets the user switch away and come back without losing context.

### Phase 6 — Future edits (separate invocation)

**Before editing, read `memory.md` and `state.json`** to pick up where the
previous session left off (the lane session may have been resumed fresh).

When the user comes back to edit an existing deck:

1. Read `/workspace/carousels/<deck_id>/template.json`. **Always re-read
   before editing** — element_ids can drift across sessions.
2. Resolve the user's change request to `element_id`s. Three resolution paths,
   tried in order:
   - **By element_id directly** — if the user names one, use it.
   - **By `source_ref`** — if the user references a brand library item by name
     ("swap the arrow_right icon", "change the label of the stat_block on
     slide 4"), look up elements on that page whose `source_ref.library` +
     `.name` (+ `.slot` for components) match. If `brand_resolved` shows the
     requested library item has a different `asset_id` now (post re-upload),
     use the current one.
   - **By `inferred_role`** — if the user says "the headline on slide 3,"
     find text elements with `inferred_role:"headline"` on that page.
   Always confirm with the user if multiple candidates match ("slide 2 has
   two icons that could be the one you mean — top-right or bottom-left?").
3. For swaps that need a new asset ("replace the icon with a different one"):
   - if the user provides a new URL → `upload-asset-from-url` → new asset_id.
   - if the user asks for AI-generation → `grok.generate_image` → upload →
     new asset_id.
   - Update `brand_resolved` in template.json with the new asset_id so future
     edits reference the current value.
4. Open a `start-editing-transaction` and apply edits via
   `perform-editing-operations`:

   | User request                        | Operation                                   |
   |-------------------------------------|---------------------------------------------|
   | "change the headline to X"          | `replace_text` on the element_id            |
   | "swap the arrow_right icon"         | `update_fill` (resolve via `source_ref`)    |
   | "use a different photo on slide 1"  | `update_fill` (upload new asset first)      |
   | "move the CTA down"                 | `position_element`                          |
   | "make the headline bigger"          | `resize_element` (text: width only)         |
   | "remove the body"                   | `delete_element` + warn about gap           |
   | "change the stat value to 20×"      | `replace_text` on the stat slot (source_ref)|
   | "add a logo to slide 5"             | REJECT — cannot add elements. Offer (a)
                                          regenerate or (b) manual Canva UI.          |
   | "add a new CTA"                     | REJECT — same reason.                       |
   | "change brand color to green"       | Partial: only via `format_text` color on
                                          existing text elements; can't recolor
                                          generated shapes/images globally. Surface
                                          limit; offer regenerate.                    |

5. After edits, **update `template.json`** to reflect the new state (text
   content, positions, sizes, asset_ids in `brand_resolved` and any updated
   `source_ref`s). The template is the live contract; keep it in sync with
   the design. Re-walk the affected pages via `start-editing-transaction`
   if you need to read the post-edit state.
6. `commit-editing-transaction`. Confirm to the user what changed.

If a stored `element_id` returns "not found" during an edit, the design has
drifted. Re-capture the affected pages (re-run Phase 4 walk) before retrying.

---

## Multi-variant dispatch

If the user wants the same content in multiple formats (e.g. 4:5 Instagram +
16:9 slide deck):

1. Treat them as two briefs (they may share brand and content, differ in
   `format`).
2. Run phases 1–5 independently for each. Each gets its own
   `/workspace/carousels/<deck_id>/` folder and its own `template.json`.

---

## Failure modes & how to handle them

| Symptom | Likely cause | Action |
|---|---|---|
| Auth error from MCP | OAuth token expired / never granted | Tell user to re-run the Canva OAuth flow |
| `generate-design` returns wrong aspect ratio | Canva ignored the ratio in the prompt | Surface to user; accept or regenerate. Do not silently proceed |
| Generated body copy differs from brief | Canva rewrote the content | Capture as-is; offer `replace_text` with the verbatim copy as a Phase 6 edit |
| Phantom elements (presenter name, contact, "Ready") | Canva template defaults | Flag in report; offer `delete_element` (with gap warning) as opt-in Phase 6 cleanup |
| Missing CTA on a slide | Canva didn't generate one | Flag in report. **Cannot add via MCP** — offer (a) regenerate that slide, (b) manual Canva UI |
| `update_fill` fails | Target element is not an image, or asset_id invalid | Verify element type in template.json; re-upload asset if URL expired |
| `replace_text` returns "Targeted an element without any text" | element_id points to a non-text element | Re-read template.json, target the correct text element_id |
| Stored element_id 404s | Design drifted since capture | Re-run Phase 4 capture for affected pages; update template.json; retry |
| `delete_element` leaves a visual gap | Fixed-coordinate layout, no auto-reflow | Warn user before deleting; offer `position_element`/`resize_element` to manually close |
| Quota / rate limit | Canva plan limit hit | Back off; surface to user — don't retry in a tight loop |
| Grok `generate_image` fails | XAI quota or content filter | Fall back to letting Canva pick stock (set image directive to null) and surface the missed asset |
| Slide references unknown library name | Typo, or library entry missing | Fail at Phase 1 validation: `"slide N references icon 'X' but brand.icons has no entry named 'X'"` |
| Font silently fell back | Family not in Canva catalog and not in user's Brand Kit | Surface in Phase 5 report: "Headline family 'Geist' not recognized — Canva substituted a fallback. To fix: upload Geist to your Brand Kit manually, or change `brand.typography.roles.headline.family` to a catalog font." |
| Component looks different across slides | Components are recipes, not real components — Canva recreates per slide | Expected behavior. Surface in report. Edits to one slide's component do not propagate to others. |
| `source_ref` is wrong/null on a captured element | Canva merged or reordered elements during generation; matching heuristic failed | Treat `source_ref` as advisory only. Fall back to `inferred_role` or element content to disambiguate edit targets; confirm with user if ambiguous. |
| User asks to change a brand color globally | Description-only channel; no way to recolor a generated design wholesale | `format_text` color works on existing text elements only. Generated shapes/images can't be globally recolored via MCP. Offer regenerate as the only full fix. |

---

## Reference: fixtures shipped with this skill

- `fixtures/brief.schema.jsonc` — input schema.
- `fixtures/brief.sample.json` — runnable 5-slide brief.
- `fixtures/template.schema.jsonc` — captured-output schema (the durable contract).
- `fixtures/layouts.registry.jsonc` — archetype prompt vocabulary (not validated).
- `fixtures/README.md` — the model in one paragraph + how to extend.
