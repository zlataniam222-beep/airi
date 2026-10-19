# Fork changelog

Newest entries first. See [`README.md`](./README.md) for the entry format.

## 2026-10-19: Reverse-engineering notes and code maps

- **What:** added two notes and two Graphify code maps:
  - `notes/2026-10-19-how-airi-works.md`: the architecture and how one chat turn works.
  - `notes/2026-10-19-airi-assessment.md`: features, benefits, limitations with evidence, and proposed improvements.
  - `graph/core/` and `graph/full/`: interactive maps and reports.
- **Why:** to understand the codebase before making changes, and to choose what to improve first.
- **Files:** `docs/fork/notes/`, `docs/fork/graph/`, `.gitignore` (which now ignores `graphify-out/`), and `eslint.config.ts` (which now skips the generated `docs/fork/graph/` files).
- **Branch / commit:** `claude/zen-feynman-fhw9jh`.
- **Notes:**
  - Graphify 0.9.92 ran without an LLM, so the community names are file and symbol names.
  - The full `graph.json` (35 MB) is not committed. `graph/README.md` explains how to make it again.
  - The next step is improvement #11 (install dependencies in cloud sessions).

## 2026-10-19: Add fork notes folder

- **What:** added `docs/fork/` to keep a changelog and documents for this fork.
- **Why:** to record every edit made in this fork and the reason for it.
- **Files:** `docs/fork/README.md`, `docs/fork/CHANGELOG.md`, `docs/fork/notes/.gitkeep`, `CLAUDE.md`.
- **Branch / commit:** `claude/zen-feynman-fhw9jh`.
