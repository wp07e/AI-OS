---
name: canva-carousel
description: >
  Generate Canva carousels via deterministic pipeline scripts. The agent's job
  is to parse the user's request into a brief.json and run ONE script; the
  script owns the entire generate→export sequence. Edits remain the agent's
  job (judgment calls via the Canva MCP edit tools). Works within the Canva
  MCP's actual capabilities.
---

# Canva Carousel Automation

This workflow has **two executors**, each where it belongs:

| Phase | Executor | Why |
|---|---|---|
| **Generate** (brief → exported slides) | Deterministic Python scripts (`/app/carousel/`) | Fixed pipeline, no judgment, eliminates model-to-model variance |
| **Edit** (modify an existing carousel) | You, via Canva MCP edit tools | "Shorten slide 3" is a judgment call — interpret intent, find the element, apply |

**You do NOT call Canva generation tools yourself.** `generate-design`,
`create-design-from-candidate`, `export-design` are owned by the scripts.
Calling them yourself reintroduces the variance (freelancing, stopping to ask,
wrong design_type) that the scripts exist to eliminate.

---

## The two generation modes

| Mode | When | How | Output |
|---|---|---|---|
| **posts** | Social carousels ("IG carousel", "Facebook slides") — visually distinct slides | N × `{platform}_post` calls, one per slide | N distinct single-page designs, native aspect (4:5 for IG) |
| **deck** | Narrative decks ("pitch deck", "roadmap", "presentation") — coherent slides | 1 × `presentation` + `length` → user picks a candidate deck | One multi-page design (16:9), homogeneous |

You **infer the mode from the request** (the user won't say "posts mode"). If
genuinely ambiguous, ask ONE clarifying question, then proceed.

- "IG carousel about X", "Facebook swipe series", "Twitter slides" → **posts**
- "pitch deck", "roadmap presentation", "lesson slides" → **deck**

---

## Status contract

The canvas polls `state.json` every ~2.5s. The **scripts write it** at each
phase boundary — you don't. You only read it to report outcome. The generic
`state.json` shape (`phase` / `lastUpdated` / `errors`) and `memory.md` resume
contract are in `/workspace/AGENTS.md`; the carousel-specific fields
(`mode`, `slides[]`, `design`, `candidates[]`) are written by the scripts.

Phase values you'll observe: `planning` → `resolving_assets` → `generating_design`
→ (deck only: `awaiting_candidate_selection`) → `template_captured` → `exporting`
→ `complete`.

---

## Workflow — GENERATION (you run the script)

### Step 1 — Write brief.json (use this exact shape)

Write `<instance_folder>/brief.json` using **exactly** this JSON structure.
Fill in the values from the user's request; do not invent extra fields or
change the key names. The pipeline script parses this file and will reject a
malformed brief.

**Do NOT include a `brand` block.** Brand identity (colors, typography, voice,
logos) is auto-applied from the user's Brand Kit based on the lane's brand
selection (`brand_selection.json` in the instance folder). You do not need to
specify colors or fonts — if the user has selected brand elements for this
lane, the pipeline bakes them into the design prompt automatically. Only add a
`brand` block if the user gives explicit per-carousel overrides.

```json
{
  "deck_id": "<lowercase-hyphen-id>",
  "title": "<Human Readable Title>",
  "format": {
    "mode": "posts",
    "platform": "instagram",
    "aspect_ratio": "4:5"
  },
  "slides": [
    {
      "n": 1,
      "intent": "<what this slide should accomplish>",
      "content": { "headline": "...", "body": "...", "cta": "..." }
    },
    {
      "n": 2,
      "intent": "...",
      "content": { "headline": "...", "body": "..." }
    }
  ]
}
```

**Mode inference** (you decide — the user won't say "posts mode"):
- `"posts"` for social carousels ("IG carousel", "Facebook slides", "swipe series") — distinct slides
- `"deck"` for narrative decks ("pitch deck", "roadmap", "presentation") — coherent pages

**Platform** (posts mode): `instagram` | `facebook` | `twitter` | `pinterest` | `linkedin`.

Write one slide entry per slide the user asked for, with real copy (headline/body/cta)
inferred from the topic. Don't leave content blank.

### Step 2 — Run the pipeline script (this does ALL the Canva work)

Run this exact command and wait for it to finish:

```
uv run python /app/carousel/run.py <instance_folder>
```

Replace `<instance_folder>` with your actual instance folder path (from the
AGENTS.md in this folder). The script handles the ENTIRE generation pipeline
deterministically: it calls generate-design, picks candidates, creates designs,
exports PNGs, and writes state.json + memory.md. **You do NOT call any Canva
generation tools yourself** — not generate-design, not create-design-from-
candidate, not export-design. The script owns all of that. Calling them yourself
is the failure mode this procedure exists to prevent.

The script may take 1–3 minutes (it makes real Canva API calls). Wait for it
to exit, then read the outcome.

### Step 3 — Read the outcome and report

Read `<instance_folder>/state.json`:

- `phase === "complete"` → report success. Mention the slide count. The canvas
  filmstrip has already populated from state.json — you don't need to show
  images in chat.
- `phase === "awaiting_candidate_selection"` → **deck mode paused**. Tell the
  user: "Candidate decks are ready — pick one in the canvas." Do NOT pick for
  them. The canvas renders an interactive candidate strip; their selection
  auto-resumes the script. Do nothing further.
- `errors` non-empty → report the errors in plain language. The script has
  already surfaced them in state.json.

**Do not render candidate thumbnails or design URLs as markdown images in
chat.** The canvas shows them visually. You just report status in text.

---

## Workflow — EDITS (you drive the Canva MCP)

When the user asks to modify an existing carousel ("shorten slide 3's body",
"change slide 1's headline", "make the headline bigger"):

### Step 1 — Read the contract files

Read these FIRST, before any Canva calls:

1. `<instance_folder>/state.json` — find the `design_id`(s):
   - **posts mode**: each slide has its own `design_id` (in `slides[].design_id`).
     Editing slide 3 → `slides[2].design_id`.
   - **deck mode**: all slides share one `design_id` (`state.design.design_id`).
     Editing "slide 3" → page 3 of that design.
2. `<instance_folder>/template.json` — the captured element contract. Each entry
   has `element_id`, `slide_index`/`page_index`, `text`, `inferred_role`
   (headline/body/cta), and position. **This is how you resolve edit targets.**

**Always re-read template.json before editing** — element_ids are stable within
a generation but always be safe.

### Step 2 — Resolve the edit target to an element_id

From template.json, find the element matching the user's request:
- "change the headline on slide 1" → filter `slide_index: 0`, `inferred_role: "headline"` → use its `element_id`.
- "shorten slide 3's body" → filter `slide_index: 2`, `inferred_role: "body"` → `element_id`.
- If the role is ambiguous, match by current `text` content.

Every edit operation (`replace_text`, `format_text`, etc.) REQUIRES an
`element_id` — there is no global find-and-replace. If template.json is missing
or the element isn't captured, open a `start-editing-transaction` (it returns
the live richtext inventory with element_ids) to find it.

### Step 3 — Apply the edit

Open a transaction, perform the operation, commit:

```
start-editing-transaction {design_id}        → returns transaction_id + richtexts
perform-editing-operations {transaction_id, operations: [
    {"type": "replace_text", "element_id": "<from template.json>", "text": "<new text>"}
]}
commit-editing-transaction {transaction_id}
```

The Canva MCP **cannot add elements** — only edit existing ones. Operations:
`replace_text`, `find_and_replace_text` (both need element_id), `update_fill`,
`position_element`, `resize_element`, `format_text`, `delete_element` (leaves a
gap — no reflow), `update_title`.

When the user asks for something unsupported (add a CTA, add an image slot):
> Cannot add elements to an existing Canva design via MCP.
> Options: (a) regenerate that slide (re-run the script with an edited brief),
> (b) finish in Canva UI manually.

### Step 4 — Re-export with VERIFICATION (critical)

After committing, re-export the affected design so the canvas PNG updates. But
**you MUST verify the export actually produced a valid PNG** — Canva's signed
S3 download URLs occasionally fail with a transient `SignatureDoesNotMatch`
error, which returns an XML body. If you save that XML as `slide-NN.png`, the
canvas shows a broken image and you've falsely claimed success.

The re-export flow:

```
export-design {design_id, format: {type: "png"}}   → returns urls[]
```

For each url, **fetch it and check the first 8 bytes are the PNG magic**
(`89 50 4E 47 0D 0A 1A 0A`). If the bytes are `<` (XML) or anything else:
- **Do not save it as the .png.** Delete the bad file if you wrote one.
- **Re-call `export-design`** to get a fresh signed URL (the signing error is
  transient — a new call produces a valid URL). Retry up to 3 times.
- Only overwrite `exports/slide-NN.png` with a verified PNG.

Once the verified PNG is saved, update `state.json` (bump `lastUpdated` and the
slide's text in `slides[]` so the canvas copy panel + preview both refresh).

**Never claim success without a verified PNG on disk.** If exports keep failing
after 3 retries, tell the user the edit applied in Canva but the local render
couldn't be refreshed — they can view it via the Canva link.

---

## Failure modes & how to handle them

| Symptom | Likely cause | Action |
|---|---|---|
| Script exits, `state.errors` mentions "no Canva access token" | OAuth not completed | Tell the user to complete the Canva OAuth flow in the web UI |
| Script exits, `state.errors` mentions "HTTP 401" | Token expired mid-run | Rare; re-run the script (opencode keeps the token fresh) |
| Script exits, `state.errors` mentions "fewer pages than requested" (deck) | Canva produced a short deck | Surface to user; the script exported what it got; offer to regenerate with explicit slide count in the query |
| `phase === "awaiting_candidate_selection"` | Deck mode normal pause | Tell the user to pick in the canvas — do nothing else |
| Edit `replace_text` returns "no text on element" | Wrong element_id | Re-read template.json, target the correct text element; or open a fresh transaction to inventory live element_ids |
| Re-export produces an XML file, not a PNG | Canva S3 `SignatureDoesNotMatch` (transient) | Re-call export-design for a fresh signed URL; verify PNG magic bytes before saving (see Step 4) |
| User asks to add an element/CTA/slide | Canva MCP can't add | Offer (a) regenerate from an edited brief, (b) manual Canva UI |
| Stored element_id 404s during an edit | Design drifted | Re-export and re-capture; the script's design_ids are stable within a generation |

---

## Reference

- **Pipeline scripts**: `/app/carousel/` (`run.py` entry point; `mcp_client.py`
  drives Canva via direct HTTP; `posts_carousel.py` / `deck_carousel.py` are
  the two modes). Read them if you need to understand the exact sequence.
- **Brief schema**: `fixtures/brief.schema.jsonc`
- **Sample brief**: `fixtures/brief.sample.json`
- **Layout vocabulary**: `fixtures/layouts.registry.jsonc` (archetype names for
  the brief's `archetype_suggestion` — prompt vocabulary only)
