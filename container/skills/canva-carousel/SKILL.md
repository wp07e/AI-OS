---
name: canva-carousel
description: >
  Generate, autofill, and export Canva carousel designs via brand templates and
  the Canva MCP. Use this skill whenever the user wants to produce social-media
  carousels, multi-slide posts, or to automate Canva brand-template autofill.
  Handles field mapping, multi-variant dispatch, and PNG/PDF export.
---

# Canva Carousel Automation

This skill produces finished Canva carousels by combining a **brand template**
(set up once in the Canva UI) with structured **content data** the agent
provides, driving the Canva MCP `autofill` tool end-to-end.

The contract between the Canva UI and this skill is the **field-naming
convention** below. If the human follows it when wiring the template, this
skill produces correct autofill payloads with zero guesswork.

---

## Field-naming convention (THE CONTRACT)

Every text element on slide *N* maps to a Bulk Create column named:

| Slot | Column name            | Field key in autofill payload |
|------|------------------------|-------------------------------|
| 1    | `slide_N_headline`     | `slide_N_headline`            |
| 2    | `slide_N_body`         | `slide_N_body`                |
| 3    | `slide_N_cta`          | `slide_N_cta`                 |

`N` is 1-indexed and matches the carousel page order. Optional per-slide image
fields use `slide_N_image` (type `image`). Cover-only fields (no slide prefix)
are allowed for title-page variants: `cover_title`, `cover_subtitle`.

> The column name in Bulk Create **is** the key in the autofill payload.
> Keep them identical. `fixtures/sample-dataset.json` and
> `fixtures/sample-bulk-create.csv` mirror each other for exactly this reason.

---

## Part 1 — One-time human setup (in Canva UI)

The agent cannot do this; it must be done manually in Canva once per template.

### 1. Build the carousel design
Create the multi-page design at the desired aspect ratio (e.g. 1080×1350 for
Instagram, 1080×1080 for square carousels). One page = one slide.

### 2. Open Bulk Create
`Apps` → search **Bulk Create** → `Enter data manually`.

### 3. Create data columns
In the data table, add one text column per text element following the
**field-naming convention** above. Example for a 5-slide carousel:

```
slide_1_headline, slide_1_body, slide_1_cta,
slide_2_headline, slide_2_body, slide_2_cta,
... slide_5_headline, slide_5_body, slide_5_cta
```

Enter a single dummy row (placeholder text) so the dataset is non-empty.

### 4. Connect each text element to its field
On each slide, select each text box, then connect it to the right column using
**one** of:
- **Drag from side panel** — drag the column chip onto the text box.
- **Element toolbar** — select the text box → `Connect data` → choose column.
- **Auto-match** — click `Auto-match` after creating columns; only works if
  the text content already matches the column name exactly.

Repeat for every text element on every slide. A correctly-wired template has
zero unconnected text boxes.

### 5. Save as Brand Template
`Share` → `Template` → `Brand Template`. Give it a name like
`carousel-instagram-5slide-v1`. Capture its **brand_template_id** (visible in
the URL or via the Canva MCP `list brand templates` tool) and record it in
`fixtures/templates.registry.jsonc`.

### 6. (Optional) Create layout variants
Repeat 1–5 for variants (different layouts, slide counts). Each variant gets
its own `brand_template_id` and its own entry in the registry. Variants that
share the field-naming convention can be filled from the **same** content
data — only the `brand_template_id` differs.

---

## Part 2 — Agent workflow (this is what you do)

When the user asks to produce a carousel:

### Step 1 — Gather content
Collect per-slide `{headline, body, cta}` from the user, or generate it from a
brief. Validate every required field is present for every slide the chosen
template expects.

### Step 2 — Pick a template variant
Look up the variant in `fixtures/templates.registry.jsonc`. Confirm its slide
count and required fields match the content you have. If the user names a
variant they haven't registered yet, ask them to complete Part 1 and add the
entry first.

### Step 3 — Build the autofill payload
Construct the `data` map using the **field-naming convention** keys. For a
5-slide variant with the example content:

```json
{
  "brand_template_id": "<ID from registry>",
  "title": "AI OS Launch Carousel",
  "data": {
    "slide_1_headline": { "type": "text", "text": "Your new AI Operating System" },
    "slide_1_body":     { "type": "text", "text": "Agents, skills, and workflows that ship content for you." },
    "slide_1_cta":      { "type": "text", "text": "Swipe →" },
    "slide_2_headline": { "type": "text", "text": "..." },
    "slide_2_body":     { "type": "text", "text": "..." },
    "slide_2_cta":      { "type": "text", "text": "..." }
  }
}
```

Image fields (if the template uses them): `{ "type": "image", "asset_id": "..." }`.

### Step 4 — Call the Canva MCP `autofill` tool
Pass the payload from Step 3. Autofill is asynchronous — the tool returns a
job. Poll until the job `status` is `success`; on `failure`, surface the error
and do not retry blindly (auth or quota failures need human action).

### Step 5 — Export
Once the design is generated, use the MCP's export tool to render PNG (per
slide, for social scheduling) or a single PDF. Save outputs into the user's
workspace (`/workspace/exports/<run-id>/`).

### Step 6 — Report back
Return to the user: the design URL, the local export path, and the
`brand_template_id` used. If multiple variants were requested, repeat 3–5 per
variant and report each.

---

## Multi-variant dispatch

When the user wants the same content across multiple layouts (A/B test,
different platforms):

1. Read every variant's entry from `templates.registry.jsonc`.
2. For each variant, verify the content covers all its required fields.
   Variants with extra slide slots get those slots left blank (or filled from a
   fallback table) — never omit fields the template expects, or autofill fails.
3. Issue one autofill job per variant. They are independent and can run in
   parallel.

---

## Failure modes & how to handle them

| Symptom | Likely cause | Action |
|---|---|---|
| Auth error from MCP | OAuth token expired / never granted | Tell user to re-run OAuth (`npx mcp-remote …` then approve in browser) |
| `field not found` | Field name in payload ≠ Bulk Create column name | Diff payload keys against `templates.registry.jsonc` for that variant |
| `template not found` | Wrong `brand_template_id`, or ID changed (Canva migrated ID format Sep 2025) | Re-list templates via MCP, update registry |
| Quota / rate limit | Canva plan limit hit | Back off; surface to user — don't retry in a tight loop |
| Empty slide in export | A connected text element had no value in the payload | Always fill every field the template declares |

---

## Reference: fixtures shipped with this skill

- `fixtures/templates.registry.jsonc` — manifest of registered variants (id, slide count, fields).
- `fixtures/sample-dataset.json` — a complete working autofill payload for a 5-slide variant.
- `fixtures/sample-bulk-create.csv` — the CSV to paste into Bulk Create so the UI column names match the dataset JSON keys exactly.
- `fixtures/README.md` — how to replace these samples with real templates.
