# Fixtures

Pre-baked samples that let `skills/canva-carousel` run end-to-end before real
templates are wired up. Replace these with your own once you've created brand
templates in Canva.

## Files

| File | Purpose |
|---|---|
| `templates.registry.jsonc` | Manifest of every registered template variant: `brand_template_id`, slide count, and the field list each expects. The agent reads this to know which template to fill and what keys to emit. |
| `sample-dataset.json` | A complete autofill payload for the `instagram-5slide-v1` variant — the exact shape the Canva MCP `autofill` tool consumes. |
| `sample-bulk-create.csv` | The CSV to paste into Canva's Bulk Create so the column names in the UI match the keys in `sample-dataset.json` exactly. |

## Replacing fixtures with real templates

For each template you create in Canva (see `../skills/canva-carousel/SKILL.md` → Part 1):

1. Open `templates.registry.jsonc`. Either edit the placeholder entry whose
   slide count matches, or add a new entry. Fill in:
   - `brand_template_id` — the real ID from Canva (visible in the design URL,
     or list it via the Canva MCP `list brand templates` tool).
   - `fields` — the exact Bulk Create column names you connected. These must
     match the dataset payload keys character-for-character.
2. Update `sample-dataset.json`'s `brand_template_id` to point at your real
   template, and adjust the `slide_N_*` values to your real content.
3. Update `sample-bulk-create.csv`'s header row to match the `fields` list.

## Why this matters

The entire automation hinges on **identical field names** across three places:

```
Canva Bulk Create column  ─┐
                           ├── must match exactly
autofill payload key      ─┘
                           │
templates.registry fields ─┘
```

If a payload key doesn't match a Bulk Create column, autofill silently drops
that field. Keep these three files in sync.
