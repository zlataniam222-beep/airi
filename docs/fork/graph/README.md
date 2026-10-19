# Code maps (Graphify)

These maps were made with [Graphify](https://graphify.com) (PyPI package `graphifyy` 0.9.92) on
2026-10-19. Graphify reads the code with tree-sitter and builds a graph of files, functions, types,
and the calls and imports between them. Then it groups related nodes into "communities". No LLM was
used, so the community names are the names of their main files or symbols.

## Which map to open

| Folder | Scope | Size | Use it to |
| --- | --- | --- | --- |
| [`core/`](./core/) | The runtime core: `core-agent`, `pipelines-audio`, `server-runtime`, `server-sdk`, `plugin-protocol`, the chat and speech stores, and `Stage.vue`. Tests are left out. | 1,330 nodes, 2,613 edges, 61 communities | Follow one chat turn, or see how the plugin hub and the speech pipeline connect. **Start here.** |
| [`full/`](./full/) | The whole repository: 4,399 files | 35,552 nodes, 64,891 edges, 1,846 communities | Find import cycles, the most connected code, and areas with few connections. `graph.html` shows communities, not single nodes, because the graph is very large. |

Each folder has:

- `graph.html`: an interactive map. Download it and open it in a browser. It loads `vis-network`
  from unpkg, so it needs internet access.
- `GRAPH_REPORT.md`: the most connected nodes ("God nodes"), unexpected connections, import cycles,
  communities, and suggested questions.
- `core/graph.json`: the raw graph, for `graphify query`, `graphify path`, and `graphify explain`.
  The full `graph.json` is 35 MB, so it is not committed. Run the commands below to make it again.

## Main findings

- The runtime core has **no import cycles**. The whole repository has **14**. See
  `full/GRAPH_REPORT.md` under "Import Cycles".
- The most connected code in the core: `setupApp()` (the plugin hub, 53 edges), `Client` (the
  plugin SDK, 32), `createChatHooks()` (27), `useChatStore` (24), and
  `createChatOrchestratorRuntime()` (22).
- The most connected code in the whole repository is analytics: `useAnalytics()` has 135 edges.

[`../notes/2026-10-19-airi-assessment.md`](../notes/2026-10-19-airi-assessment.md) explains what these
findings mean.

## How to make the maps again

```bash
python3 -m venv .venv-graphify
.venv-graphify/bin/pip install graphifyy

# Full repository. Output goes to graphify-out/, which git ignores.
.venv-graphify/bin/graphify update .

# Ask questions about the graph
.venv-graphify/bin/graphify query "how does a chat message reach text-to-speech?"
.venv-graphify/bin/graphify path "createChatOrchestratorRuntime" "createSpeechPipeline"
.venv-graphify/bin/graphify explain "useChatStore"
```

To make the `core/` map, copy the folders listed above into an empty folder, delete `*.test.ts`,
and run `graphify update .` in that folder.

`graphify update` does not use an LLM. If you set `GEMINI_API_KEY` or another supported API key,
`graphify label` can give the communities readable names.
