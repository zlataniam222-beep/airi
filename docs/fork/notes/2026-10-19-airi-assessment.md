# AIRI: features, benefits, limitations, and proposed improvements

This note is based on reading the source code at commit `1b019c3` (version `0.12.0-beta.5`) and on
two [Graphify](https://graphify.com) code graphs (see [`../graph/`](../graph/README.md)). File paths
are relative to the repository root.

See also: [`2026-10-19-how-airi-works.md`](./2026-10-19-how-airi-works.md) for the architecture.

Each limitation lists its **evidence**: the file or search result that shows it. A limitation marked
_(inferred)_ comes from reading the design. It was not reproduced in a running app.

## 1. Features

### Talking to the character

- Text chat with streaming replies, message retry, reply-to-message, session forks, and tool-call reruns.
- Voice input with voice activity detection (VAD). It supports Whisper-style APIs, the browser Web
  Speech API, Apple Speech (macOS), Aliyun NLS, and the official AIRI transcription provider.
- Voice output through many text-to-speech (TTS) providers: OpenAI, ElevenLabs, MiniMax, Google,
  VOICEVOX, Kokoro (local), Index-TTS, and others. It has sentence-level streaming and a two-way
  streaming WebSocket path.
- Lip-sync from the audio (wLipSync for Live2D, and an audio analyser for the other renderers).
- Emotions and motions that the LLM controls with `<|ACT|>`, `<|DELAY|>`, and `<|CALL|>` tokens.
  There are 9 emotions.
- Vision: the character can capture and describe the screen or camera (`stores/modules/vision`).
- Web search, MCP tools (stdio MCP servers on desktop), and custom tools.
- Reasoning models: `<think>` content is shown in the UI and is never spoken.

### Character and appearance

- Character cards (CCv3 compatible) with per-character model, voice, and module settings.
- Five renderers: VRM (Three.js), Live2D, MMD, Spine, and Tachie (still images). There is also an
  optional Godot stage on desktop.
- Backgrounds, VRM touch reactions, and a motion and expression editor.

### Platforms

- Web (installable as a progressive web app), desktop (Electron on Windows, macOS, and Linux), and
  mobile (Capacitor on iOS and Android).
- Desktop extras: a transparent always-on-top character, a caption overlay, a spotlight quick-chat
  window, widgets (weather, map, artistry), global shortcuts, a tray menu, auto-update, and beat-sync
  dancing to music.

### Integrations and plugins

- A WebSocket plugin hub with module announcement, permissions, a configuration flow, health checks,
  and routing.
- Ready-made plugins: Discord, Telegram, Satori, Bilibili live chat, Twitter, Minecraft (Mineflayer
  agent), Factorio, Home Assistant, chess, Claude Code, a VS Code extension, a web extension, and a
  computer-use MCP server.
- "Spark" events: plugins can notify the character so it reacts without a user message.

### Providers

- About 45 cloud LLM and speech providers and 7 local providers (Ollama, LM Studio, VOICEVOX, the Web
  Speech API, and others), defined in `packages/provider-inference/src/providers`.
- Both the Chat Completions API and the Responses API.

### Optional cloud

- Accounts (Better Auth and OIDC), cloud chat sync, an official provider gateway, voice packs, and
  Flux credits with Stripe billing (`server/apps/api`).

## 2. Benefits

- **Open source under MIT.** You can change, fork, and ship it.
- **Local-first and private.** The client works without the backend. If you use Ollama or LM Studio
  with VOICEVOX or Kokoro, no data has to leave your computer.
- **Not tied to one vendor.** About 50 providers. You can change the model per character.
- **One codebase, three platforms.** `packages/stage-ui` holds most of the logic for web, desktop,
  and mobile.
- **Extensible.** The plugin protocol is typed (`plugin-protocol`) and supports permissions, so
  integrations do not need changes to the core.
- **Careful engineering.**
  - The prompt, provider, and stream contracts are typed.
  - Stale sends are cancelled with session generation numbers.
  - Analytics and tracing are built in.
  - Tests sit next to the code they cover (`*.test.ts` and `*.browser.test.ts`).
  - `AGENTS.md` sets strict code rules.
- **The core is clean.** Graphify found **no import cycles** in the runtime core: `core-agent`,
  `pipelines-audio`, the server packages, and the chat and speech stores.

## 3. Limitations

### 3.1 The full chat history is sent on every turn

`buildContext()` in `packages/core-agent/src/runtime/chat-orchestrator-runtime.ts` changes **every**
session message into the prompt. A compaction helper exists
(`compactConversationEntries` in `packages/core-agent/src/messages/compaction.ts`), but no runtime
code calls it. A search found it only in its own file and an `index.ts` re-export.

**Effect:** _(inferred)_ Long conversations cost more tokens, get slower, and can go past the
model's context window and then fail.

### 3.2 There is no long-term memory

- `packages/memory-pgvector/src/index.ts` is 24 lines long. It connects to the hub and ignores its
  configuration.
- `packages/core-character/src/index.ts` contains only `export {}`.
- In `Stage.vue`, the embedding and "memory" code in `onAssistantResponseEnd` is commented out.

**Effect:** The character remembers only the current session. It cannot recall facts from older
sessions.

### 3.3 Emotions depend on the model following the prompt

The `ACT`, `DELAY`, and `CALL` tokens are taught only through prompt text
(`packages/i18n/src/locales/en/base.yaml`).

**Effect:** _(inferred)_ Small or local models often leave out the tokens or write them wrong. The
character then keeps one expression. There is no fallback, such as a sentiment classifier or a
structured tool call. The list of 9 emotions is fixed in code
(`pipelines-audio/src/llm-streaming-control/payloads.ts`) and cannot change per character.

### 3.4 Every XML-like tag counts as reasoning

`mapTagNameToCategory()` in `packages/core-agent/src/runtime/response-categoriser.ts` returns
`reasoning` for **any** complete tag.

**Effect:** _(inferred)_ If a reply includes real tags, for example while explaining HTML, that text
is taken out of the spoken text.

### 3.5 Character card support is partial

`resolveSystemPrompt()` in `stores/modules/airi-card.ts` does not use the CCv3 fields that depend on
position, such as the first message and example dialogues. The code comment says this is
deliberate.

**Effect:** Cards imported from other apps can feel different from the original.

### 3.6 Replies cannot be interrupted while they generate

`sendQueue` runs one send at a time. A new message waits until the current reply is done.
`cancelPendingSends` exists, but it is an explicit action. Voice "barge-in" (you speak, and the
character stops) is not connected to VAD. See the `TODO` at `stores/modules/hearing.ts:450`.

**Effect:** _(inferred)_ Voice conversations feel less natural than real-time assistants.

### 3.7 Some features are not done yet

- The Responses API adapter does not support realtime speech-to-speech. It rejects audio input and
  provider file IDs, and it stops after 10 tool steps (`packages/core-agent/README.md`).
- Cloud sync copies only text. Images and native provider data stay on the device.
- Backend configuration for character capabilities and avatar models is still a `TODO`
  (`server/apps/api/src/types/character-capability.ts` and `character-avatar-model.ts`).
- The connection settings support only one WebSocket server
  (`components/scenarios/connection/settings/index.vue`).
- The vision inference settings are hard-coded (`composables/vision/use-vision-inference.ts:20`).

### 3.8 The plugin hub has no authentication by default

`AUTHENTICATION_TOKEN` defaults to an empty string (`packages/server-runtime/src/index.ts`), and
then no checks run. The default address is `127.0.0.1`, which limits the risk. But the hub also
supports `0.0.0.0` and prints the LAN addresses.

**Effect:** _(inferred)_ If you expose the hub on your network without a token, any device on that
network can send input or `CALL` tokens to the character.

### 3.9 Code health

- Graphify found **14 import cycles** in the full repository. `AGENTS.md` says that cycles are a
  design problem. Examples:
  - `stores/chat/session-store.ts` → `modules/airi-card.ts` → `modules/speech.ts` →
    `providers/official/index.ts` → back to `session-store.ts`
  - `composables/api.ts` → `libs/auth-fetch.ts` → `stores/auth.ts` → back to `api.ts`
  - `apps/stage-tamagotchi/.../services/electron/index.ts` → `window.ts` → `windows/shared/window.ts`
    → back to `index.ts`
  - Several cycles inside `integrations/minecraft`

  The full list is in `docs/fork/graph/full/GRAPH_REPORT.md`, under "Import Cycles".
- **Analytics is the most connected code in the repository.** `useAnalytics()` has 135 edges,
  `captureAnalyticsEvent()` has 86, and `canCapture()` has 78. They are more connected than the chat
  or provider stores. Analytics code is woven through most features.
- Graphify gives `stores/chat.ts` a **low cohesion** score (0.013). It may be doing too many jobs.
- Electron works around a missing Eventa feature (contexts per window) with
  `ipcMain.setMaxListeners(100)`. Twelve or more `TODO` comments in `apps/stage-tamagotchi` refer to
  this.
- `Stage.vue` is about 1,200 lines. It mixes rendering, the TTS session, lip-sync, emotions, and
  captions.
- Developer setup is heavy. `pnpm install` runs a build of every package (`postinstall`). The cloud
  environment for this fork does not install dependencies yet.

### 3.10 Committed `.env` templates

`.env` files are in `.gitignore`, but some were added to git anyway as templates. These are
`packages/stage-ui/.env` and the `.env` files in `integrations/discord-bot`, `minecraft`,
`satori-bot`, and `telegram-bot`. Some keys there have values, for example in `satori-bot` and
`telegram-bot`. They are probably local development defaults, but nobody has checked them yet.

**Effect:** If you put real keys in these files, `git add -A` will commit them. Use `.env.local`
for real keys.

## 4. Proposed improvements

Effort: S = hours, M = days, L = weeks. "Upstream" means the change would be useful to
`moeru-ai/airi`, not only to this fork.

| # | Improvement | Fixes | Impact | Effort | Upstream |
| --- | --- | --- | --- | --- | --- |
| 1 | Limit prompt history with a token budget: use `compactConversationEntries` in `buildContext()`, keep the last N turns, and summarize older turns | 3.1 | High | M | Yes |
| 2 | Add long-term memory: build `memory-pgvector` (the backend already uses `pglite-pgvector`) or a local DuckDB-WASM store. Embed turns in `onChatTurnComplete`, then send the relevant memories with `context:update` | 3.2 | High | L | Yes |
| 3 | Make emotions robust: accept small mistakes in tokens, and add a fallback that guesses the emotion from the text, or a `set_emotion` tool for models with good tool calling. Let cards define their own emotion list | 3.3 | High | M | Yes |
| 4 | Treat only known tags as reasoning (`think`, `thought`, `reasoning`, and so on) and keep other tags as text | 3.4 | Medium | S | Yes |
| 5 | Voice barge-in: when VAD hears the user during playback, stop audio and cancel the active send | 3.6 | High | M | Yes |
| 6 | Hub security: if the hub listens on an address other than localhost, require a token or create one, and show a warning in Settings | 3.8 | Medium | S | Yes |
| 7 | Use the CCv3 first message and example dialogues | 3.5 | Medium | M | Yes |
| 8 | Break the 14 import cycles, starting with the `session-store` and `auth` cycles in `stage-ui`. Move shared types to modules without side effects | 3.9 | Medium | M | Yes |
| 9 | Split `Stage.vue` into composables: TTS session, lip-sync, emotion queue, and captions | 3.9 | Medium | M | Yes |
| 10 | Show tokens and cost for each turn in the chat. The data already exists (`onLlmGeneration`, `onMessageRound`) | Visibility | Medium | S | Yes |
| 11 | Fork setup: add `pnpm install --frozen-lockfile` to the cloud setup script, or add a SessionStart hook, so that typecheck, lint, and tests can run in cloud sessions | 3.9 | High for this fork | S | No |
| 12 | Check the committed `.env` values and document `.env.local` in `docs/fork/` | 3.10 | Low | S | Maybe |

### Suggested order

1. **#11.** The other changes need typecheck, lint, and tests to run.
2. **#4 and #6.** Both are small and safe, and each is a good first pull request.
3. **#1, then #3.** These give the largest improvement in daily use.
4. **#2 and #5.** These are the large features that make AIRI feel "alive".
