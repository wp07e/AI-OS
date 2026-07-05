# Fixtures

Inputs, the captured-output contract, and prompt vocabulary for
`skills/canva-carousel`. These fixtures implement a **brief → generate →
capture → edit** model that respects what the Canva MCP can actually do.

## The model in one paragraph

A user supplies a **brief** describing the deck they want — including a full
**brand library** (colors, typography, icons, assets, components). The agent
prompts Canva's `generate-design` to produce the deck, accepting whatever
Canva creates — Canva is a content-editing API, not a layout-authoring API,
and will deviate from any prescriptive spec. After generation, the agent
**captures** the result: it walks every page and emits a `template.json` that
lists every element Canva actually produced. From that point on,
**`template.json` is the contract** for that deck — every future edit resolves
against the `element_id`s captured there. The brief is intent; the template is
ground truth.

## Files

| File | Role |
|---|---|
| `brief.schema.jsonc` | **Input schema.** What the user gives the AI. Brand library (colors, typography, icons, assets, components), format, per-slide intent + content, image directives. |
| `brief.sample.json` | A complete, runnable 5-slide brief exercising every brand-library channel. |
| `template.schema.jsonc` | **Captured-output schema.** What the AI produces after `generate-design` runs. The durable contract for future edits. Documents the `cannot_add_elements` hard constraint and the `source_ref`/`brand_resolved` provenance fields. |
| `layouts.registry.jsonc` | **Prompt vocabulary only.** 6 archetype names (`hero`, `split`, `editorial`, `cards`, `center`, `minimal`) the AI uses when prompting `generate-design`. Not validated against. |
| `README.md` | This file. |

## The layer split (why this is reliable)

```
WHAT THE USER WANTS    brief.json              intent + brand library + directives
                                                  ↓ declarative, free-form
WHAT CANVA BUILDS      generate-design         Canva's choice
                                                  ↓ accept deviations
WHAT ACTUALLY EXISTS   template.json           captured inventory + provenance
                                                  ↑ THE CONTRACT
WHAT WE EDIT AGAINST   element_id in template  replace_text / update_fill /
                                                  position / resize / delete
```

The brief is *not* a contract. The archetype manifests in
`layouts.registry.jsonc` are *not* a contract. **`template.json` is the
contract.** It reflects what Canva really produced, with real `element_id`s.

## The brand library — five asset channels

`brand.{colors, typography, icons, assets, components}` form a single named
library. Slides reference library items BY NAME rather than redeclaring them
at each call site. This keeps deck identity consistent and makes the
generate-design prompt cleaner.

| Channel | What it is | How it gets into Canva |
|---|---|---|
| **colors** | Role-keyed palette (`background`, `accent`, `text_primary`, ...) plus optional `color_usage` notes. | Description only — rendered into the prompt as explicit hex + usage guidance. No upload. |
| **typography** | Pairing + per-role specs (`family`, `weight`, `case`, `letter_spacing`, `line_height`, `size_hint`) + fallback. | Description only — rendered into the prompt. **No font-file upload tool exists in the Canva MCP.** Families must be in Canva's catalog or manually uploaded by the user to their Brand Kit. |
| **icons** | Named set, each entry an asset directive. | Uploaded via `upload-asset-from-url` → `asset_id`. Referenced by name per slide. |
| **assets** | Named decorative library (textures, patterns, illustrations, photos, gradients). | Same upload path as icons. |
| **components** | Named recipes (`cta_pill`, `stat_block`) with described slots. | Description only — `generate-design` is asked to recreate on each slide that uses it. **Not real Canva components** — see limit below. |

### Asset directive forms

Anywhere a brief requests an image, icon, asset, or logo:

```json
{ "url": "https://..." }                // user-supplied → upload-asset-from-url
{ "generate": true, "brief": "..." }    // Grok generate_image → then upload
null                                     // let Canva pick stock
```

And specifically for component slots, a fourth form:

```json
{ "ref": "arrow_right" }                // name of a brand.icons or brand.assets entry
```

### The font limit (read this)

There is **no font upload tool** in the Canva MCP. `brand.typography` is a
description that gets baked into the `generate-design` prompt. Fonts named
must be either:

- In Canva's default catalog (Inter, Montserrat, Roboto, etc.), or
- Manually uploaded by the user to their Canva **Brand Kit** in the UI first,
  then referenced by exact name in the brief.

Unknown families silently fall back to Canva defaults — the agent should
surface this in the post-generation report if it happens.

### The component limit (read this)

Canva MCP has **no component concept**. There is no upload, no reusable
element, no overrides. A `brand.components` entry is a **structured
description** that `generate-design` is asked to recreate on each slide that
uses it. After capture:

- Each component instance appears in `template.json` as a set of ordinary
  `element_id`s — not as a reusable unit.
- Each of those elements carries an advisory `source_ref` of the form
  `{library:"components", name:"cta_pill", slot:"label"}` so edits can resolve
  "the label slot of the cta_pill on slide 5" to a specific `element_id`.
- Editing a component on one slide does **not** change it on any other slide.

If you need a truly reusable component system, that lives outside Canva
(e.g. the Layerre MCP path, or pre-authored Brand Templates — currently out
of scope).

## The hard constraint (read this)

The Canva MCP **cannot add elements** to an existing design. Supported edit
operations are:

```
update_title            replace_text            find_and_replace_text
update_fill             insert_fill             delete_element
position_element        resize_element          format_text
update_autofill_field
```

There is no `insert_text` and no `insert_element`. So if `template.json` shows
a slide is missing a CTA, you cannot add one to that slide through the MCP.
Your options are: (a) regenerate that slide from a new brief, or (b) finish it
manually in the Canva UI.

`delete_element` works but does **not** auto-reflow — remaining elements stay
at their fixed coordinates, leaving a visual gap. Surface this when proposing
deletions.

## Provenance: how named library items map to elements

Two advisory fields in `template.json` link the captured elements back to the
brand library so edits can resolve by name:

- **`brand_resolved`** (deck-level): maps each library name to the Canva
  `asset_id` it resolved to (for icons/assets/logo), or just an
  `_applied: true` flag (for colors/typography/components, which are
  description-only).
- **`source_ref`** (per element): the library + name + slot an element came
  from. Lets "swap the arrow_right icon" or "change the label of the
  stat_block on slide 4" resolve to specific `element_id`s.

Both are **advisory hints, not contracts**. Canva may merge, drop, or rename
elements during generation. Always verify by inspecting the actual element
content before trusting a `source_ref`.

## Storage convention

Each deck gets its own self-contained folder at:

```
/workspace/carousels/<deck_id>/
  ├─ brief.json          # the original input, frozen
  ├─ template.json       # captured post-generation — the edit contract
  ├─ assets/             # generated images, uploaded icons/logos (with source URLs)
  └─ exports/            # PNG (per slide) and/or PDF (single)
```

`<deck_id>` matches `brief.deck_id` (lowercase, hyphen-separated).

## Adding a new layout archetype

Open `layouts.registry.jsonc` and add an entry under `archetypes`. That's it
— briefs can immediately reference the new name in `archetype_suggestion`.
Remember: the new archetype is prompt vocabulary only; Canva may still
deviate from it.

## Editing an existing deck

Open `template.json` for that deck. Identify the element you want to change
(by `element_id`, optionally disambiguated via `inferred_role` or
`source_ref`). Apply the change via the Canva MCP `perform-editing-operations`
tool inside a `start-editing-transaction`. Commit when done. See
`../skills/canva-carousel/SKILL.md` Phase 6.

## Why there's no Brand Template / autofill / Bulk Create support

An earlier version of these fixtures assumed Canva Brand Templates with Bulk
Create autofill. That capability is not available in this setup, and even
without it the standard Canva MCP proved unable to enforce a prescriptive
spec. The brief → generate → capture → edit model replaces both the column-
sync contract and the archetype-validation contract with one that works
within the MCP's actual capabilities.
