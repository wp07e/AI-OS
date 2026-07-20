# AI OS — Agent Operating Environment

You are running inside the **AI OS**, a structured agent platform. This file is
your permanent environment context — read it once and remember it. You do not
need to re-read it each turn.

## Where you are

- Your host process runs as the `appuser` user (uid 2000).
- The filesystem root you can write to is **`/workspace`**. Everything you
  produce lives under `/workspace`. Do NOT write to `/app` (read-only, image
  files), `/tmp` (ephemeral), or any other path. If you are tempted to write
  somewhere outside `/workspace`, stop — the answer is always a path under
  `/workspace`.
- You have file tools (read, write, edit). Use them against `/workspace/...`.

## How work is organized

The AI OS is organized into **workflows**. Each workflow has a type (e.g.
`carousel`) and produces instances — discrete pieces of work the user creates.
Each instance lives in its own folder:

```
/workspace/<workflow-folder>/<instance-id>/
```

For example, a carousel instance lives at:
```
/workspace/carousels/<uuid>/
  ├── brief.json      ← the artifact's input spec
  ├── state.json      ← REQUIRED status file (see below)
  ├── memory.md       ← handoff notes for session resume
  ├── exports/        ← rendered outputs (PNGs, PDFs, etc.)
  └── <other files>
```

## Which instance you're working on

When a user starts work on an instance, **that instance's folder is the active
context.** On the first message of a new instance the host primes your session
with the concrete folder path — use it directly. If for any reason you need to
re-discover the active instance, do it deterministically:

1. **Check the most recently modified workflow folder.** List the
   subdirectories of `/workspace/carousels/` (or the relevant
   `/workspace/<type>/`) by **folder modification time** (a brand-new instance
   has no `state.json` yet — fall back to `state.json`/`memory.md` mtime only
   when present, otherwise use the directory's own mtime). The newest is almost
   certainly the active one. Open that folder's `AGENTS.md` — it names the
   instance concretely.
2. **If a folder contains an `AGENTS.md`, read it first** — it states the
   instance's type, title, folder path, and skill. Treat that folder as your
   working directory for all file operations in this session.
3. **If the user references "this instance" or "the current carousel"** without
   a path, use the instance you found in step 1. Do not ask them to name it
   unless there are zero instance folders.
4. **Write all files to the instance's folder** — not to `/workspace` root, and
   never to `/tmp` or `/app`. If you are about to write a file and the path is
   not under `/workspace/<type>/<instance-id>/`, stop and re-read this section.

## state.json — the status contract

Every instance folder must contain a `state.json` file that the host UI polls
to show the user progress. **You must write to it at meaningful milestones.**
The required shape:

```json
{
  "phase": "<current-phase>",        // any short string, e.g. "planning", "generating", "complete"
  "lastUpdated": "<ISO 8601 timestamp>",
  "errors": []                        // array of human-readable error strings; empty if none
}
```

Write a new `state.json` (overwriting the old one) when:
- You start a phase ("phase": "planning")
- You finish a step ("phase": "generated_assets")
- You hit an error (append to "errors")
- You complete ("phase": "complete")

The host UI reads this file every ~2.5 seconds. If you never write it, the UI
shows "unknown" — not fatal, but the user can't see what you're doing.

## memory.md — session resume

When you pause or finish work on an instance, append a short handoff note to
`memory.md` in the instance folder so the next session can pick up where you
left off. Read `memory.md` (if it exists) before resuming work on an instance.

## Skills

Workflows are driven by **skills** (markdown procedures in `/workspace/skills/`).
When the user asks for something that matches a skill, follow that skill's
procedure. For example, the `canva-carousel` skill describes how to produce a
designed Instagram carousel from a brief.

### Blender skills

94 specialized Blender skills from the [blender-skills](https://github.com/arjun988/blender-skills)
pack are installed in `/workspace/skills/`. Each is a `SKILL.md` file (with
optional `references/`) covering a specific technique: animation, archviz,
materials, lighting, character rigging, compositing, geometry nodes, and more.
When tackling a complex Blender task, `ls /workspace/skills/` to find a matching
skill and read its `SKILL.md` before proceeding — they contain expert-level
setup guides, parameter cheatsheets, and workflow shortcuts that save
trial-and-error.

## Summary of rules

1. Write files only under `/workspace/...` — never `/app`, `/tmp`, or elsewhere.
2. Know your active instance folder; do file work there.
3. Update `state.json` at milestones so the UI can show progress.
4. Append to `memory.md` when pausing/finishing for resume continuity.
5. Load and follow the relevant skill when the user's request matches one.
