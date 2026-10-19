# Graph Report - airi-core  (2026-10-19)

## Corpus Check
- 122 files · ~78,782 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1330 nodes · 2613 edges · 61 communities (52 shown, 9 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 95 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- events.ts
- messages/types.ts
- Stage.vue
- spark-notify/index.ts
- controller.ts
- spark-command/schema.ts
- createChatOrchestratorRuntime
- hearing.ts
- runtime/responses.ts
- server-runtime/src/index.ts
- core-agent/src/index.ts
- setupApp
- tts-session.ts
- createChatHooks
- server/index.ts
- Client
- tool-resolver.ts
- airi/index.ts
- chat-orchestrator-runtime.ts
- tts-chunker.ts
- createPlaybackManager
- speech.ts
- stores/chat.ts
- eventa.ts
- session-store.ts
- src/types.ts
- extension-peer.ts
- createSpeechPipeline
- context-bridge.ts
- useChatSessionStore
- client.ts
- airi-card.ts
- context-registry.ts
- match-expression.ts
- ref_vue
- ref_proj_airi_server_shared
- timeline.ts
- createTranscriptBuffer
- pipelines-audio/src/index.ts
- airi/codec.ts
- generation.ts
- speech-pipeline.ts
- mcp-tool-bridge.ts
- agent-hooks.ts
- buildStreamingSnapshot
- setupLipSync
- WebSocketReadyState
- playback-speaking-state.ts
- constants.ts
- WebSocketEventSource
- process.ts
- ContextUpdateStrategy
- MessageHeartbeat
- MessageHeartbeatKind
- captureCharacterFrame
- getVrmInteractionExpression
- resetAssistantSpeechSurface
- readRenderTargetRegionAtClientPoint

## God Nodes (most connected - your core abstractions)
1. `setupApp()` - 53 edges
2. `Client` - 32 edges
3. `createChatHooks()` - 27 edges
4. `useChatStore` - 24 edges
5. `createChatOrchestratorRuntime()` - 22 edges
6. `useChatSessionStore` - 22 edges
7. `createPlaybackManager()` - 20 edges
8. `createChatDataStore()` - 15 edges
9. `renderSegmentText()` - 13 edges
10. `Conversation` - 13 edges

## Surprising Connections (you probably didn't know these)
- `useChatContextStore` --indirect_call--> `getEventSourceKey()`  [INFERRED]
  packages/stage-ui/src/stores/chat/context-store.ts → packages/core-agent/src/agents/spark-notify/event-source.ts
- `useChatStreamStore` --indirect_call--> `beginStream()`  [INFERRED]
  packages/stage-ui/src/stores/chat/stream-store.ts → packages/core-agent/src/runtime/chat-orchestrator-runtime.ts
- `useChatStore` --indirect_call--> `cancelPendingSends()`  [INFERRED]
  packages/stage-ui/src/stores/chat.ts → packages/core-agent/src/runtime/chat-orchestrator-runtime.ts
- `useChatStore` --indirect_call--> `getPendingQueuedSendSnapshot()`  [INFERRED]
  packages/stage-ui/src/stores/chat.ts → packages/core-agent/src/runtime/chat-orchestrator-runtime.ts
- `useChatStore` --indirect_call--> `createMinecraftContext()`  [INFERRED]
  packages/stage-ui/src/stores/chat.ts → packages/stage-ui/src/stores/chat/context-providers/minecraft.ts

## Import Cycles
- None detected.

## Communities (61 total, 9 thin omitted)

### Community 0 - "events.ts"
Cohesion: 0.01
Nodes (191): contextUpdate, ContextUpdateDestinationAll, ContextUpdateDestinationFilter, ContextUpdateDestinationList, ContextUpdateEvent, DeliveryConfig, DeliveryMode, DeliverySelectionStrategy (+183 more)

### Community 1 - "messages/types.ts"
Cohesion: 0.05
Nodes (76): chatContentToInputSegments(), chatMessagesToProjectionEntries(), chatMessagesToTurns(), conversationToChatMessages(), renderEntry(), writeContent(), compactConversationEntries(), CompactConversationEntriesOptions (+68 more)

### Community 2 - "Stage.vue"
Cohesion: 0.02
Nodes (53): { activeBackgroundUrl }, { activeCard }, activeCardId, assistantCaption, audioAnalyser, { audioContext }, backgroundStore, canvasElement() (+45 more)

### Community 3 - "spark-notify/index.ts"
Cohesion: 0.08
Nodes (43): createSparkNotifyAgent(), handle(), CreateSparkNotifyAgentOptions, expandCommand(), getSparkNotifyHandlingAgentInstruction(), renderSparkNotifyUserMessage(), resolveSparkNotifyRuntimePolicy(), resultFrom() (+35 more)

### Community 4 - "controller.ts"
Cohesion: 0.08
Nodes (37): createStreamingControlParser(), normalizeManifest(), registerHandler(), StreamingControlTurnState, tokenAct(), renderCallManifestExamples(), renderCallManifestPrompt(), tokenCall() (+29 more)

### Community 5 - "spark-command/schema.ts"
Cohesion: 0.09
Nodes (29): normalizeSparkCommandDestinations(), normalizeSparkCommandGuidanceOptions(), normalizeSparkCommandMetadata(), normalizeSparkCommandPersona(), normalizeSparkCommandStringList(), normalizeSparkCommandStringValue(), sparkCommandContextSchema, sparkCommandGuidanceOptionSchema (+21 more)

### Community 6 - "createChatOrchestratorRuntime"
Cohesion: 0.08
Nodes (33): cloneStreamingMessage(), createChatOrchestratorRuntime(), beginStream(), buildContext(), cancelPendingSends(), emitStateChange(), getStablePromptTimestamp(), ingest() (+25 more)

### Community 7 - "hearing.ts"
Cohesion: 0.06
Nodes (27): CONFIDENCE_THRESHOLD_DISABLED, describeEmptyTranscriptionResponse(), errorMessage(), filterTranscriptionByConfidence(), GenerateTranscriptionResponse, HearingTranscriptionGenerateResult, HearingTranscriptionInput, HearingTranscriptionInvokeOptions (+19 more)

### Community 8 - "runtime/responses.ts"
Cohesion: 0.13
Nodes (27): AgentLLMPort, Citation, Conversation, streamChatCompletions(), CONTENT_ARRAY_RELATED_ERROR_PATTERNS, isContentArrayRelatedError(), isToolRelatedError(), modelKey() (+19 more)

### Community 9 - "server-runtime/src/index.ts"
Cohesion: 0.10
Nodes (23): airiPeerFromRaw(), AiriWsMessage, AiriWsPeerState, AppOptions, rawPeerFrom(), timingSafeCompare(), collectDestinations(), createPolicyMiddleware() (+15 more)

### Community 10 - "core-agent/src/index.ts"
Cohesion: 0.13
Nodes (25): AgentSessionPort, buildContextPromptMessage(), ContextSnapshot, formatContextPromptText(), AssistantTurn, ContentSegment, SystemTurn, ToolExecution (+17 more)

### Community 11 - "setupApp"
Cohesion: 0.14
Nodes (27): send(), setupApp(), broadcastPeerHealthy(), broadcastPeerUnhealthy(), broadcastRegistrySync(), broadcastToAuthenticated(), clearHealthCheckInterval(), closeAllPeers() (+19 more)

### Community 12 - "tts-session.ts"
Cohesion: 0.11
Nodes (26): createStreamingTtsPipeline(), enqueueFlush(), flushAccumulatedAsSentence(), handleControlFrame(), requestTerminate(), terminate(), noopHandle(), readSentenceText() (+18 more)

### Community 13 - "createChatHooks"
Cohesion: 0.07
Nodes (4): createAgentHooks(), clearHooks(), createChatHooks(), ChatOrchestratorRuntime

### Community 14 - "server/index.ts"
Cohesion: 0.11
Nodes (13): server, optionOrEnv(), fromEnv(), normalizeLoggerConfig(), createServer(), closeServer(), restart(), start() (+5 more)

### Community 16 - "tool-resolver.ts"
Cohesion: 0.12
Nodes (14): useLLM, resolveActiveTools(), resolveCustomTools(), resolveLlmTools(), ResolveLlmToolsOptions, resolveSparkCommandTools(), resolveToolSource(), resolveWebSearchTools() (+6 more)

### Community 17 - "airi/index.ts"
Cohesion: 0.15
Nodes (17): selectConsumer(), ConsumerRegistration, ConsumerRegistryRef, ConsumerSelectionCandidate, ConsumerStickyAssignment, createConsumerOrchestrator(), isConsumerDeliveryMode(), normalizeConsumerGroup() (+9 more)

### Community 18 - "chat-orchestrator-runtime.ts"
Cohesion: 0.14
Nodes (15): AgentContextPort, AgentForegroundStreamPort, formatTimePrefix(), padDatePart(), ChatOrchestratorLifecycleRecord, ChatOrchestratorLLMPort, ChatOrchestratorRuntimeDeps, ChatOrchestratorRuntimeState (+7 more)

### Community 19 - "tts-chunker.ts"
Cohesion: 0.12
Nodes (18): BRACKET_MAP, chunkEmitter(), chunkTtsInput(), CLOSERS, createTtsSegmentStream(), hardPunctuations, isProbablyAngleTag(), isUnicodeLetter() (+10 more)

### Community 20 - "createPlaybackManager"
Cohesion: 0.29
Nodes (19): createPlaybackManager(), canStart(), emit(), enqueue(), exists(), finalize(), handleBlocked(), interrupt() (+11 more)

### Community 21 - "speech.ts"
Cohesion: 0.12
Nodes (9): ChatDataAccess, ChatDataStore, SpeechAnalytics, SpeechInput, SpeechInputOptions, toSignedPercent(), useSpeechCatalog, useSpeechCatalogRequests (+1 more)

### Community 22 - "stores/chat.ts"
Cohesion: 0.13
Nodes (12): getPendingQueuedSendSnapshot(), ChatRetryPayload, ChatSendPayload, ChatSendResult, ChatToolCallRerunPayload, ForkOptions, isTextDelta(), ProviderHistoryMessage (+4 more)

### Community 23 - "eventa.ts"
Cohesion: 0.11
Nodes (17): speechIntentCancelEvent, speechIntentEndEvent, speechIntentStartEvent, speechPipelineEventMap, SpeechPipelineEventName, speechPlaybackEndEvent, speechPlaybackInterruptEvent, speechPlaybackRejectEvent (+9 more)

### Community 24 - "session-store.ts"
Cohesion: 0.14
Nodes (5): useChatMaintenanceStore, CloudMergePayload, CloudSyncableRole, DeleteChatMessagePayload, useChatSessionSelectionStore

### Community 25 - "src/types.ts"
Cohesion: 0.18
Nodes (15): ActivePlayback, Listener, OverflowPolicy, OwnerOverflowPolicy, PlaybackManagerOptions, WaitingPlayback, IntentBehavior, IntentHandle (+7 more)

### Community 26 - "extension-peer.ts"
Cohesion: 0.15
Nodes (8): ClientOptions, ConnectOptions, createClient(), AnnounceExtensionModuleInput, createWebSocketExtensionPeer(), ExtensionPeerClient, WebSocketExtensionPeer, WebSocketExtensionPeerOptions

### Community 27 - "createSpeechPipeline"
Cohesion: 0.20
Nodes (13): createId(), createSpeechPipeline(), cancelIntent(), enqueueIntent(), interrupt(), openIntent(), pickNextIntent(), runIntent() (+5 more)

### Community 28 - "context-bridge.ts"
Cohesion: 0.17
Nodes (6): useLlmStreamingControlStore, ContextBucketSnapshot, useChatContextStore, useChatStreamStore, normalizeContextSnapshot(), useContextBridgeStore

### Community 29 - "useChatSessionStore"
Cohesion: 0.29
Nodes (15): createChatDataStore(), bumpSessionGeneration(), ensureGeneration(), ensureSession(), getActiveSessionId(), getAllSessions(), getSessionGeneration(), getSessionGenerationValue() (+7 more)

### Community 30 - "client.ts"
Cohesion: 0.19
Nodes (13): ClientHeartbeatOptions, ClientStateChangeContext, ClientStatus, createAbortError(), createConnectionTimeoutError(), createDefaultProtocolConnector(), createInstanceId(), createTextProtocolConnector() (+5 more)

### Community 31 - "airi-card.ts"
Cohesion: 0.15
Nodes (3): resolveSystemPrompt(), useAiriCardStore, useConsciousnessStore

### Community 32 - "context-registry.ts"
Cohesion: 0.18
Nodes (10): ChatOrchestratorPromptProjection, ContextHistoryEntry, ContextIngestResult, ContextRegistry, createContextRegistry(), CreateContextRegistryOptions, defaultGetSourceKey(), EventSourcePayload (+2 more)

### Community 33 - "match-expression.ts"
Cohesion: 0.38
Nodes (12): getPeerExtensionId(), getPeerLabels(), globToRegExp(), matchesDestination(), matchesDestinations(), matchesExtensionModule(), matchesExtensionModuleGlob(), matchesGlob() (+4 more)

### Community 34 - "ref_vue"
Cohesion: 0.19
Nodes (4): RemoteCallMessage, LlmToolsetPromptContribution, renderToolsetPrompts(), useLlmToolsetPromptsStore

### Community 35 - "ref_proj_airi_server_shared"
Cohesion: 0.23
Nodes (6): eventDataSchema, eventEnvelopeSchema, InvalidMessageError, InvalidMessageErrorOptions, parseEvent(), parsePlainJson()

### Community 36 - "timeline.ts"
Cohesion: 0.22
Nodes (9): createDefaultClock(), createId(), createTimeline(), enqueue(), TimelineClock, TimelineItem, TimelineItemHandle, TimelineOptions (+1 more)

### Community 37 - "createTranscriptBuffer"
Cohesion: 0.38
Nodes (9): createTranscriptBuffer(), clear(), clearFlushTimer(), dispose(), flushNow(), push(), scheduleFlush(), joinTranscriptFragments() (+1 more)

### Community 38 - "pipelines-audio/src/index.ts"
Cohesion: 0.22
Nodes (4): DEFAULT_LEVELS, StreamController, PriorityLevel, PriorityResolver

### Community 39 - "airi/codec.ts"
Cohesion: 0.25
Nodes (7): eventDataSchema, eventEnvelopeSchema, heartbeatFrameFrom(), InvalidEventError, InvalidEventErrorOptions, isInvalidEventError(), parseEvent()

### Community 40 - "generation.ts"
Cohesion: 0.32
Nodes (6): GenerationRound, ProviderContinuation, createAssistantTurn(), createGeneration(), complete(), recordRound()

### Community 41 - "speech-pipeline.ts"
Cohesion: 0.46
Nodes (7): createPriorityResolver(), IntentState, SpeechPipelineOptions, LoggerLike, TextSegment, TextToken, TtsRequest

### Community 42 - "mcp-tool-bridge.ts"
Cohesion: 0.25
Nodes (4): McpCallToolPayload, McpCallToolResult, McpToolBridge, McpToolDescriptor

### Community 43 - "agent-hooks.ts"
Cohesion: 0.48
Nodes (5): AgentHookRegistry, ChatHookRegistry, HookUnsubscribe, QueuedSendSnapshot, ChatStreamEventContext

### Community 44 - "buildStreamingSnapshot"
Cohesion: 0.33
Nodes (7): buildStreamingSnapshot(), openTtsSession(), playSpecialToken(), resolveSpeechTransport(), resolveStageVoiceType(), resolveStreamingSessionModel(), speechPipeline

### Community 45 - "setupLipSync"
Cohesion: 0.33
Nodes (7): playFunction(), resetLive2dLipSync(), setupAnalyser(), setupLipSync(), startLipSyncLoop(), stopLipSyncLoop(), syncLipSyncLoop()

### Community 47 - "WebSocketReadyState"
Cohesion: 0.40
Nodes (5): WebSocketReadyState, CLOSED, CLOSING, CONNECTING, OPEN

### Community 49 - "playback-speaking-state.ts"
Cohesion: 0.40
Nodes (3): bindSpeakingStateToPlaybackManager(), PlaybackSpeakingStateHandlers, PlaybackSpeakingStateManager

### Community 50 - "constants.ts"
Cohesion: 0.40
Nodes (4): ACTIVE_SESSION_STORAGE_KEY, CHAT_STORAGE_KEY, CHAT_STREAM_CHANNEL_NAME, CONTEXT_CHANNEL_NAME

### Community 51 - "WebSocketEventSource"
Cohesion: 0.50
Nodes (4): WebSocketEventSource, Server, StageTamagotchi, StageWeb

### Community 53 - "ContextUpdateStrategy"
Cohesion: 0.67
Nodes (3): ContextUpdateStrategy, AppendSelf, ReplaceSelf

### Community 54 - "MessageHeartbeat"
Cohesion: 0.67
Nodes (3): MessageHeartbeat, Ping, Pong

### Community 55 - "MessageHeartbeatKind"
Cohesion: 0.67
Nodes (3): MessageHeartbeatKind, Ping, Pong

## Knowledge Gaps
- **13 isolated node(s):** `Ping`, `Pong`, `Ping`, `Pong`, `Server` (+8 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 574 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `setupApp()` connect `setupApp` to `match-expression.ts`, `airi/codec.ts`, `server-runtime/src/index.ts`, `server/index.ts`, `airi/index.ts`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `setupApp()` (e.g. with `closeAllPeers()` and `dispose()`) actually correct?**
  _`setupApp()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Ping`, `Pong`, `Ping` to the rest of the system?**
  _13 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `events.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.010256410256410256 - nodes in this community are weakly interconnected._
- **Why does `createChatHooks()` connect `createChatHooks` to `chat-orchestrator-runtime.ts`, `core-agent/src/index.ts`, `agent-hooks.ts`, `createChatOrchestratorRuntime`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Are the 21 inferred relationships involving `createChatHooks()` (e.g. with `clearHooks()` and `emitAfterMessageComposedHooks()`) actually correct?**
  _`createChatHooks()` has 21 INFERRED edges - model-reasoned connections that need verification._
- **Should `messages/types.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05417236662106703 - nodes in this community are weakly interconnected._