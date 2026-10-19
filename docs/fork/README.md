# Fork notes

This folder records the changes made in this fork (`zlataniam222-beep/airi`).
Upstream (`moeru-ai/airi`) does not have it, so it does not conflict when you merge upstream changes.

## Files

- [`CHANGELOG.md`](./CHANGELOG.md): one entry for each change, newest first.
- [`notes/`](./notes/): longer documents. Use one file for each topic, such as a feature design, a setup guide or a bug investigation.

## How to add a changelog entry

Add the entry at the top of `CHANGELOG.md` in the same commit as the change:

```md
## YYYY-MM-DD: Short title

- **What:** what changed, from the user's point of view.
- **Why:** the reason for the change.
- **Files:** the main files that changed.
- **Branch / commit:** the branch name and, if possible, the commit or pull request.
- **Notes:** follow-ups, known problems, or a link to a file in `notes/`.
```

## How to name a note

Use kebab-case and a date prefix, for example `notes/2026-10-19-custom-character-voice.md`.
