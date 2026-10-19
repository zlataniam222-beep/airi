/**
 * Whisper ASR inference adapter.
 *
 * Uses the unified inference protocol from protocol.ts.
 * Preserves the onMessage API for streaming UI updates by forwarding
 * unified protocol messages to subscribers.
 *
 * State model:
 * - `worker`: created on demand by `ensureWorker`. A worker error, a request that stops sending progress, or
 *   `terminate()` destroys it, together with what it held (`loadedModelId` and the GPU allocation).
 * - `loadedModelId`: the model that the current worker reported in its last `model-ready`. It is cleared whenever the
 *   adapter cannot tell what the worker holds: after a failed or cancelled load, or when the worker is destroyed.
 * - `allocationToken`: the GPU coordinator's record of `loadedModelId`. It is requested on `model-ready` and released
 *   whenever `loadedModelId` is cleared, so the coordinator never counts a model that the worker may have disposed.
 * - `activeModelId`: the model of the latest load attempt. It keys the inference status entry and device-loss
 *   telemetry, so the settings page can follow one model's download.
 * - `state`: 'ready' only while a model is loaded and no operation runs.
 * Load and transcribe calls run one at a time through `operationMutex`.
 */

import type { WhisperInput, WhisperOutput } from '../../workers/worker'
import type { WhisperModelId } from '../constants'
import type { AllocationToken } from '../gpu-resource-coordinator'
import type {
  LoadModelRequest,
  ProgressPayload,
  RunInferenceRequest,
  WorkerOutboundMessage,
} from '../protocol'

import { defaultPerfTracer } from '@proj-airi/stage-shared'
import { Mutex } from 'async-mutex'

import whisperWorkerUrl from '../../workers/worker?worker&url'

import { removeInferenceStatus, updateInferenceStatus } from '../../../composables/use-inference-status'
import { DEFAULT_WHISPER_MODEL_ID, DEVICE_LOSS_WASM_THRESHOLD, getWhisperModel, MAX_RESTARTS, RESTART_DELAY_MS, TIMEOUTS } from '../constants'
import { getGPUCoordinator, getLoadQueue } from '../coordinator'
import { LOAD_PRIORITY } from '../load-queue'
import { classifyDeviceLossReason, classifyError, createRequestId, InferenceAbortError, throwIfAborted } from '../protocol'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WhisperState
  = | 'idle'
    | 'loading'
    | 'ready'
    | 'transcribing'
    | 'error'
    | 'terminated'

export interface WhisperTranscribeInput {
  audio?: string
  audioFloat32?: Float32Array
  /**
   * Whisper language code or English language name, such as `'en'` or `'japanese'`.
   * Omit it to let Whisper detect the spoken language.
   */
  language?: string
}

export interface WhisperLoadOptions {
  signal?: AbortSignal
  /**
   * Model to load.
   * @default DEFAULT_WHISPER_MODEL_ID
   */
  modelId?: WhisperModelId
}

/**
 * Unified message events for Whisper, based on protocol.ts types.
 * These replace the old status-based MessageEvents.
 */
export type WhisperEvent
  = | { type: 'progress', payload: ProgressPayload & Record<string, unknown> }
    | { type: 'model-ready' }
    | { type: 'inference-result', output: { text: string[] } }
    | { type: 'error', payload: { code: string, message: string } }

export interface WhisperAdapter {
  /**
   * Make `options.modelId` the loaded model.
   *
   * Resolves at once, without a worker round trip, when that model is already loaded and the adapter is ready, so
   * callers may call it before every transcription. Otherwise it posts `load-model` and waits for `model-ready`;
   * loading a different model replaces the previous one in the worker. The load fails when the worker sends no
   * progress for `TIMEOUTS.WHISPER_LOAD`.
   * Pass `options.signal` to cancel the load; rejects with `InferenceAbortError`.
   */
  load: (
    onProgress?: (p: ProgressPayload) => void,
    options?: WhisperLoadOptions,
  ) => Promise<void>

  /**
   * Transcribe audio, returning the text result.
   * Pass `options.signal` to cancel; rejects with `InferenceAbortError`.
   */
  transcribe: (
    input: WhisperTranscribeInput,
    options?: { signal?: AbortSignal },
  ) => Promise<string>

  /** Terminate the worker */
  terminate: () => void

  /** Current state */
  readonly state: WhisperState

  /** Model reported by the worker's last `model-ready`, or null when no model is known to be loaded. */
  readonly loadedModelId: WhisperModelId | null

  /**
   * Subscribe to unified protocol events for streaming UI updates.
   * Returns an unsubscribe function.
   */
  onMessage: (handler: (event: WhisperEvent) => void) => () => void

  /**
   * Snapshot of the last successful load, or null if never loaded.
   * `device` reflects what the worker actually used (post-fallback).
   */
  readonly manifest: { device: string } | null

  /** Number of WebGPU device-loss events observed by this adapter */
  readonly deviceLossCount: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Inactivity windows; each progress message for the request restarts them. See {@link TIMEOUTS}. */
const LOAD_TIMEOUT = TIMEOUTS.WHISPER_LOAD
const TRANSCRIBE_TIMEOUT = TIMEOUTS.WHISPER_TRANSCRIBE

type WhisperOutboundMessage = WorkerOutboundMessage<WhisperOutput>

interface PendingWaiter {
  cleanup: () => void
  reject: (error: Error) => void
}

/**
 * A worker request sent no message for its inactivity window. The worker runs one operation at a time, so a stuck
 * operation would block every later request; the adapter destroys the worker when this error occurs.
 */
class WorkerInactivityTimeoutError extends Error {
  override readonly name = 'WorkerInactivityTimeoutError'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Path prefix of the model weight files in a load progress message.
 *
 * NOTICE:
 * transformers.js `PreTrainedModel.from_pretrained` reads the ONNX sessions, and their external data files, from the
 * `onnx` subfolder of the repository by default, and the worker does not change that subfolder.
 * Source: node_modules/@huggingface/transformers/src/models.js, `from_pretrained` (`subfolder = 'onnx'`), v3.8.1.
 * Removal condition: the worker reports which files are model weights.
 */
const MODEL_WEIGHT_FILE_PREFIX = 'onnx/'

/**
 * Sums the latest byte counts of every file in a load into one percentage, so a status reader sees one figure for
 * the whole download instead of the figure of whichever file reported last. Files whose total is still unknown count
 * as zero bytes.
 *
 * Returns -1 (indeterminate) until a model weight file is known and every known weight file has sent bytes.
 * transformers.js downloads config.json, the tokenizer, and the processor files first, and starts the weight files
 * only after config.json. A weight file adds its whole size when its first bytes arrive, so a figure taken before
 * that reads too high, up to 100% from the small files alone, and falls when the weight file arrives.
 *
 * @example
 * aggregateDownloadPercent(new Map([['config.json', { loaded: 2, total: 2 }], ['onnx/b.onnx', { loaded: 0, total: 0 }]]))
 * // => -1
 * aggregateDownloadPercent(new Map([['onnx/a.onnx', { loaded: 50, total: 100 }], ['onnx/b.onnx', { loaded: 1, total: 300 }]]))
 * // => 13
 */
function aggregateDownloadPercent(files: ReadonlyMap<string, { loaded: number, total: number }>): number {
  let loaded = 0
  let total = 0
  let hasWeightFile = false
  for (const [file, bytes] of files) {
    if (file.startsWith(MODEL_WEIGHT_FILE_PREFIX)) {
      // transformers.js reports a total above zero with every byte count, so a zero total means no bytes yet.
      if (bytes.total === 0)
        return -1
      hasWeightFile = true
    }
    loaded += bytes.loaded
    total += bytes.total
  }

  return hasWeightFile ? Math.round(loaded / total * 100) : -1
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWhisperAdapter(workerUrl: string | URL): WhisperAdapter {
  let worker: Worker | null = null
  let state: WhisperState = 'idle'
  let loadedModelId: WhisperModelId | null = null
  let activeModelId: WhisperModelId | null = null
  let allocationToken: AllocationToken | null = null
  let restartAttempts = 0
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let messageListener: ((event: MessageEvent) => void) | null = null
  let errorListener: ((event: ErrorEvent) => void) | null = null
  const messageHandlers = new Set<(event: WhisperEvent) => void>()
  const pendingWaiters = new Map<string, PendingWaiter>()

  // NOTICE: Device-loss resilience state. See kokoro.ts for rationale.
  let lastManifest: { device: string } | null = null
  let deviceLossCount = 0

  const operationMutex = new Mutex()

  function toWorkerError(event: ErrorEvent | Error, fallback = 'Whisper worker failed'): Error {
    if (event instanceof Error)
      return event

    if (event.error instanceof Error)
      return event.error

    return new Error(event.message || fallback)
  }

  function rejectPendingWaiters(error: Error): void {
    for (const [requestId, waiter] of pendingWaiters) {
      waiter.cleanup()
      pendingWaiters.delete(requestId)
      waiter.reject(error)
    }
  }

  function handleWorkerError(event: ErrorEvent | Error): void {
    state = 'error'
    operationMutex.cancel()

    const error = toWorkerError(event)
    rejectPendingWaiters(error)

    const code = classifyError(error)
    if (code === 'DEVICE_LOST') {
      deviceLossCount++
      // The worker touches the GPU only after a load started, so a device loss always has an active model.
      if (activeModelId) {
        getGPUCoordinator().recordDeviceLoss({
          modelId: activeModelId,
          reason: classifyDeviceLossReason(error),
          occurredAt: Date.now(),
        })
      }
    }

    if (activeModelId)
      updateInferenceStatus(activeModelId, { state: 'error' })

    destroyWorker()
    scheduleRestart()
  }

  /** Terminates the worker and forgets what it held: the loaded model and its GPU allocation. */
  function destroyWorker(): void {
    if (worker) {
      if (messageListener)
        worker.removeEventListener('message', messageListener)
      if (errorListener)
        worker.removeEventListener('error', errorListener)
      messageListener = null
      errorListener = null
      worker.terminate()
      worker = null
    }

    forgetLoadedModel()
  }

  /** Clears `loadedModelId` and releases its GPU allocation, for when the adapter cannot tell what the worker holds. */
  function forgetLoadedModel(): void {
    loadedModelId = null
    if (allocationToken) {
      getGPUCoordinator().release(allocationToken)
      allocationToken = null
    }
  }

  function scheduleRestart(): void {
    if (restartAttempts >= MAX_RESTARTS) {
      console.error(`[WhisperAdapter] Max restart attempts (${MAX_RESTARTS}) reached.`)
      // NOTICE: Transition to 'terminated' so callers can detect the dead adapter
      // instead of being stuck in 'error' state indefinitely.
      state = 'terminated'
      return
    }

    restartAttempts++
    const delay = RESTART_DELAY_MS * restartAttempts
    console.warn(`[WhisperAdapter] Restarting in ${delay}ms (attempt ${restartAttempts}/${MAX_RESTARTS})`)

    restartTimer = setTimeout(() => {
      restartTimer = undefined
      // terminate() may have run during the delay; a terminated adapter must not start a new worker.
      if (state !== 'terminated')
        ensureWorker()
    }, delay)
  }

  function onSuccess(): void {
    restartAttempts = 0
  }

  function ensureWorker(): Worker {
    if (!worker) {
      worker = new Worker(workerUrl, { type: 'module' })
      messageListener = (event: MessageEvent) => {
        const data = event.data
        // Forward unified protocol messages to subscribers
        if (data.type === 'progress') {
          const evt: WhisperEvent = { type: 'progress', payload: data.payload }
          for (const handler of messageHandlers) handler(evt)
        }
        else if (data.type === 'model-ready') {
          const evt: WhisperEvent = { type: 'model-ready' }
          for (const handler of messageHandlers) handler(evt)
        }
        else if (data.type === 'inference-result') {
          const evt: WhisperEvent = { type: 'inference-result', output: data.output }
          for (const handler of messageHandlers) handler(evt)
        }
        else if (data.type === 'error') {
          const evt: WhisperEvent = { type: 'error', payload: data.payload }
          for (const handler of messageHandlers) handler(evt)
        }
      }
      errorListener = (event: ErrorEvent) => {
        handleWorkerError(event)
      }
      worker.addEventListener('message', messageListener)
      worker.addEventListener('error', errorListener)
    }
    return worker
  }

  /**
   * Wait for the message of type `targetType` that answers `requestId`.
   *
   * Messages are matched by `requestId` only; messages for other requests are ignored. A `progress` message for the
   * request goes to `onProgress` and restarts the inactivity timer, so the wait fails only when the worker sends
   * nothing for `timeout` ms. An `error` message for the request rejects: with `InferenceAbortError` for code
   * `CANCELLED`, otherwise with a plain `Error`.
   * If `signal` aborts, sends a `cancel` message to the worker and rejects with `InferenceAbortError`.
   */
  function waitForMessage<TType extends WhisperOutboundMessage['type']>(
    w: Worker,
    requestId: string,
    targetType: TType,
    options: {
      timeout: number
      onProgress?: (payload: ProgressPayload) => void
      signal?: AbortSignal
    },
  ): Promise<Extract<WhisperOutboundMessage, { type: TType }>> {
    const { timeout, onProgress, signal } = options

    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      let abortListener: (() => void) | null = null

      function cleanup(): void {
        if (timeoutId !== undefined)
          clearTimeout(timeoutId)
        pendingWaiters.delete(requestId)
        w.removeEventListener('message', handler)
        if (abortListener && signal)
          signal.removeEventListener('abort', abortListener)
      }

      function restartTimeout(): void {
        if (timeoutId !== undefined)
          clearTimeout(timeoutId)
        timeoutId = setTimeout(() => {
          cleanup()
          // The message must contain 'timeout' so classifyError reports TIMEOUT.
          reject(new WorkerInactivityTimeoutError(`Whisper: timeout after ${timeout}ms without progress waiting for '${targetType}'`))
        }, timeout)
      }

      function handler(event: MessageEvent<WhisperOutboundMessage>): void {
        const message = event.data
        if (message.requestId !== requestId)
          return

        if (message.type === targetType) {
          cleanup()
          resolve(message as Extract<WhisperOutboundMessage, { type: TType }>)
        }
        else if (message.type === 'error') {
          cleanup()
          if (message.payload.code === 'CANCELLED')
            reject(new InferenceAbortError(message.payload.message))
          else
            reject(new Error(message.payload.message ?? 'Worker error'))
        }
        else if (message.type === 'progress') {
          restartTimeout()
          onProgress?.(message.payload)
        }
      }

      w.addEventListener('message', handler)
      pendingWaiters.set(requestId, { cleanup, reject })

      restartTimeout()

      if (signal) {
        if (signal.aborted) {
          cleanup()
          w.postMessage({ type: 'cancel', requestId: createRequestId(), targetRequestId: requestId })
          reject(new InferenceAbortError(typeof signal.reason === 'string' ? signal.reason : undefined))
          return
        }
        abortListener = () => {
          cleanup()
          w.postMessage({ type: 'cancel', requestId: createRequestId(), targetRequestId: requestId })
          const reason = signal.reason
          reject(reason instanceof Error ? reason : new InferenceAbortError(typeof reason === 'string' ? reason : undefined))
        }
        signal.addEventListener('abort', abortListener)
      }
    })
  }

  /**
   * Records a failed or cancelled load. The worker may have disposed the previous model before the failure, so no
   * model is known to be loaded afterwards, and the previous model's GPU allocation is released. A cancelled load
   * returns to 'idle': it is the caller's decision, not a failure.
   */
  function markLoadFailed(modelId: WhisperModelId, error: unknown): void {
    forgetLoadedModel()
    // terminate() removed the status entry, and exhausted restarts already set it to 'error'. The adapter is final,
    // so leave both its state and the status entry unchanged.
    if (state === 'terminated')
      return

    if (isAbortError(error)) {
      state = 'idle'
      updateInferenceStatus(modelId, { state: 'idle' })
      return
    }

    state = 'error'
    updateInferenceStatus(modelId, { state: 'error' })
    if (error instanceof WorkerInactivityTimeoutError)
      destroyWorker()
  }

  async function load(
    onProgress?: (p: ProgressPayload) => void,
    options?: WhisperLoadOptions,
  ): Promise<void> {
    const modelId = options?.modelId ?? DEFAULT_WHISPER_MODEL_ID
    const { vramEstimateBytes } = getWhisperModel(modelId)

    throwIfAborted(options?.signal)
    return operationMutex.runExclusive(async () => {
      throwIfAborted(options?.signal)
      if (worker && state === 'ready' && loadedModelId === modelId)
        return

      // NOTICE: Proactive WASM promotion after repeated device-loss events.
      // See kokoro.ts for rationale. Whisper always requests 'webgpu' from the
      // caller today, so we only check the promotion threshold.
      const requestedDevice: LoadModelRequest['device'] = deviceLossCount >= DEVICE_LOSS_WASM_THRESHOLD ? 'wasm' : 'webgpu'
      if (requestedDevice === 'wasm') {
        console.warn(
          `[WhisperAdapter] ${deviceLossCount} device-loss events recorded, `
          + `promoting load from webgpu to wasm.`,
        )
      }

      state = 'loading'
      // Status entries are keyed by model ID; switching models removes the entry of the previous one.
      if (activeModelId && activeModelId !== modelId)
        removeInferenceStatus(activeModelId)
      activeModelId = modelId
      updateInferenceStatus(modelId, { state: 'downloading', device: requestedDevice, progress: undefined })

      try {
        await getLoadQueue().enqueue(modelId, LOAD_PRIORITY.ASR, async () => {
          throwIfAborted(options?.signal)
          const w = ensureWorker()
          const requestId = createRequestId()
          const downloadedBytes = new Map<string, { loaded: number, total: number }>()
          // Highest aggregate reported in this load. A file that sends its first bytes late, such as the fp32 encoder
          // that the worker downloads after an fp16 failure, grows the byte total and lowers the aggregate. The
          // status keeps the highest figure, so the progress bar never moves back.
          let downloadPercent = -1

          const readyPromise = waitForMessage(w, requestId, 'model-ready', {
            timeout: LOAD_TIMEOUT,
            onProgress: (payload) => {
              const progress: ProgressPayload = {
                phase: payload.phase ?? 'download',
                percent: payload.percent ?? -1,
                message: payload.message,
                file: payload.file,
                loaded: payload.loaded,
                total: payload.total,
              }

              if (progress.phase === 'download' && progress.file) {
                if (progress.loaded === undefined || progress.total === undefined) {
                  // A per-file 'initiate' message: the file has started but has no byte counts yet. It is recorded
                  // with an unknown total, so the aggregate waits for its first bytes. A file that already sent bytes
                  // keeps them.
                  if (!downloadedBytes.has(progress.file))
                    downloadedBytes.set(progress.file, { loaded: 0, total: 0 })
                }
                else {
                  downloadedBytes.set(progress.file, { loaded: progress.loaded, total: progress.total })
                  downloadPercent = Math.max(downloadPercent, aggregateDownloadPercent(downloadedBytes))
                  // Until the weight files send bytes, the status keeps the indeterminate "Loading model..." message.
                  if (downloadPercent >= 0) {
                    updateInferenceStatus(modelId, {
                      progress: { phase: 'download', percent: downloadPercent, message: progress.message },
                    })
                  }
                }
              }
              else if (!progress.file) {
                // Phase messages without a file, such as "Loading model..." or the warm-up.
                updateInferenceStatus(modelId, {
                  state: progress.phase === 'warmup' ? 'warming-up' : 'downloading',
                  progress,
                })
              }

              onProgress?.(progress)
            },
            signal: options?.signal,
          })

          // Protocol: `modelId` is a WhisperModelId. The worker resolves the repository from WHISPER_MODELS.
          const request: LoadModelRequest = { type: 'load-model', requestId, modelId, device: requestedDevice }
          w.postMessage(request)

          const readyResponse = await readyPromise

          // Track GPU memory allocation
          const coordinator = getGPUCoordinator()
          if (allocationToken)
            coordinator.release(allocationToken)
          allocationToken = coordinator.requestAllocation(modelId, vramEstimateBytes)

          // Capture actual device reported by the worker (may fall back to WASM)
          lastManifest = { device: readyResponse.device }
          loadedModelId = modelId
          state = 'ready'
          updateInferenceStatus(modelId, { state: 'ready', device: readyResponse.device, progress: undefined })
          onSuccess()
        }, { signal: options?.signal })
      }
      catch (error) {
        markLoadFailed(modelId, error)
        throw error
      }
    })
  }

  async function transcribe(
    input: WhisperTranscribeInput,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    throwIfAborted(options?.signal)
    return defaultPerfTracer.withMeasure('inference', 'whisper-transcribe', () => operationMutex.runExclusive(async () => {
      throwIfAborted(options?.signal)
      if (!worker || state !== 'ready')
        throw new Error('Model not loaded. Call load() first.')

      // Update LRU timestamp for memory pressure tracking
      if (allocationToken)
        getGPUCoordinator().touch(allocationToken.modelId)

      state = 'transcribing'
      const requestId = createRequestId()

      const resultPromise = waitForMessage(worker, requestId, 'inference-result', {
        timeout: TRANSCRIBE_TIMEOUT,
        signal: options?.signal,
      })

      const request: RunInferenceRequest<WhisperInput> = {
        type: 'run-inference',
        requestId,
        input: {
          audio: input.audio,
          audioFloat32: input.audioFloat32,
          language: input.language,
        },
      }
      worker.postMessage(request)

      try {
        const result = await resultPromise
        state = 'ready'
        onSuccess()
        return result.output.text[0] ?? ''
      }
      catch (error) {
        // terminate() or a worker crash already set the final state.
        if (state !== 'transcribing')
          throw error

        // Cancellation is the caller's decision, not a failure. The worker finishes the cancelled inference in the
        // background and keeps the model loaded, so the adapter stays usable.
        if (isAbortError(error)) {
          state = 'ready'
          throw error
        }

        state = 'error'
        if (error instanceof WorkerInactivityTimeoutError)
          destroyWorker()
        throw error
      }
    }), { language: input.language ?? 'auto', modelId: loadedModelId })
  }

  function terminateAdapter(): void {
    operationMutex.cancel()
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer)
      restartTimer = undefined
    }
    state = 'terminated'
    rejectPendingWaiters(new InferenceAbortError('Whisper adapter terminated.'))
    destroyWorker()
    if (activeModelId) {
      removeInferenceStatus(activeModelId)
      activeModelId = null
    }
    messageHandlers.clear()
  }

  function onMessage(handler: (event: WhisperEvent) => void): () => void {
    messageHandlers.add(handler)
    return () => messageHandlers.delete(handler)
  }

  return {
    load,
    transcribe,
    terminate: terminateAdapter,
    onMessage,
    get state() { return state },
    get loadedModelId() { return loadedModelId },
    get manifest() { return lastManifest },
    get deviceLossCount() { return deviceLossCount },
  }
}

let globalAdapter: WhisperAdapter | null = null
const singletonMutex = new Mutex()

/**
 * Get the process-wide Whisper adapter, backed by the bundled Whisper worker.
 *
 * Creates the adapter on first use and replaces it once it is 'terminated': after `terminate()`, or after the worker
 * crashed more than `MAX_RESTARTS` times in a row. Unlike `getKokoroAdapter`, an adapter in 'error' state is kept:
 * its next `load()` recovers it, and a new adapter would reset `deviceLossCount`, which drives the WASM promotion
 * after repeated WebGPU device losses.
 */
export async function getWhisperAdapter(): Promise<WhisperAdapter> {
  return singletonMutex.runExclusive(() => {
    if (!globalAdapter || globalAdapter.state === 'terminated')
      globalAdapter = createWhisperAdapter(whisperWorkerUrl)

    return globalAdapter
  })
}
