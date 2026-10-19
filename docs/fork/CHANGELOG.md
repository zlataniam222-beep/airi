# Fork changelog

Newest entries first. See [`README.md`](./README.md) for the entry format.

## 2026-10-19: Chat microphone button works with Whisper (Local)

- **What:** the chat-area microphone button now dictates with Hearing providers that cannot stream input, such
  as Whisper (Local). It records each spoken phrase, transcribes it, and adds the text to the chat input.
  Auto-send works the same way as with streaming providers.
- **Why:** after Whisper (Local) became the default, the button only logged "Streaming input not supported"
  and did nothing. Before, an empty Hearing setting made the button fall back to the browser Web Speech API.
- **Files:** `packages/stage-layouts/src/composables/use-transcriptions.ts` (+ `use-transcriptions.test.ts`).
- **Branch / commit:** `claude/zen-feynman-fhw9jh`.
- **Notes:**
  - It reuses `useVoiceInputSession` from stage-ui (voice activity detection, recording, and dropping work
    that is no longer current). Stopping drops the phrase being recorded and any transcription still running.
  - Checks: `stage-layouts` typecheck and lint pass; 38 tests pass (5 new). Not tested with a real microphone.
  - Known limit: on stage-web and stage-pocket, the page already transcribes speech whenever the microphone is
    on. With dictation on too, each phrase is transcribed twice. Streaming providers already behave this way.

## 2026-10-19: Built-in local Whisper transcription (default)

- **What:** added **Whisper (Local)**, a speech-to-text provider that runs OpenAI Whisper on the device
  with transformers.js. New installs use it for Hearing by default with **Whisper Small**. Base and
  Large v3 Turbo can be selected. The provider has its own settings page with a model download button.
- **Why:** the user wanted local transcription that works by default, without an account or API key.
- **Files:**
  - Engine: `packages/stage-ui/src/libs/workers/worker.ts`, `libs/inference/{constants,coordinator}.ts`,
    `libs/inference/adapters/whisper.ts` (+ test), `components/scenarios/settings/ModelCacheManager.vue`.
  - Provider: `packages/stage-ui/src/libs/providers/providers/whisper-local/` (+ browser test),
    `providers/{index,registry}.ts`, `libs/providers/attributes.ts`.
  - Defaults: `packages/stage-ui/src/stores/modules/{hearing,default}.ts` (+ `default.test.ts`).
  - UI and text: `packages/stage-pages/src/pages/settings/providers/transcription/whisper-local.vue`,
    `packages/i18n/src/locales/en/settings.yaml`, `packages/i18n/glossary/terms.yaml`.
- **Branch / commit:** `claude/zen-feynman-fhw9jh`.
- **Notes:**
  - Details and limits: [`notes/2026-10-19-built-in-whisper.md`](./notes/2026-10-19-built-in-whisper.md).
  - Not tested with real models in the cloud session, because `huggingface.co` is blocked there.
  - Checks: `stage-ui` and `stage-pages` typecheck pass; 128 node tests pass (inference, providers,
    Hearing, defaults); the provider browser test (9 tests) passes in Chromium with a local config.
  - The glossary entry for "Whisper" stops translators from translating the product name as the
    ordinary word for quiet speech.

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
