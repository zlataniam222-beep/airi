/**
 * Whisper ASR Web Worker.
 *
 * Uses the unified inference protocol from protocol.ts.
 * Streaming token updates are sent as progress messages with phase 'inference'.
 *
 * Model selection: `load-model.modelId` is a {@link WhisperModelId}, not a Hugging Face repository. The worker
 * resolves the repository from `WHISPER_MODELS` in constants.ts, so the allow-list and the repository mapping live in
 * one place, and `model-ready.modelId` repeats the requested ID.
 *
 * State model: the worker holds at most one loaded model ({@link loadedModel}). Loading a different model, or the same
 * model for a different device, disposes the current one first. Load, inference, and unload requests run one at a
 * time in arrival order ({@link enqueueOperation}). `cancel` is handled immediately.
 */

import type {
  PreTrainedModel,
  PreTrainedTokenizer,
  Processor,
  ProgressInfo,
  Tensor,
} from '@huggingface/transformers'

import type { WhisperModelId } from '../inference/constants'
import type {
  ErrorResponse,
  InferenceResultResponse,
  LoadModelRequest,
  ModelReadyResponse,
  ModelUnloadedResponse,
  ProgressResponse,
  RunInferenceRequest,
  UnloadModelRequest,
  WorkerInboundMessage,
} from '../inference/protocol'

import {
  AutoProcessor,
  AutoTokenizer,
  full,
  LogitsProcessor,
  LogitsProcessorList,
  SuppressTokensAtBeginLogitsProcessor,
  TextStreamer,
  WhisperForConditionalGeneration,
} from '@huggingface/transformers'
import { toFloat32FromPCM16 } from '@proj-airi/audio/encoding'
import { errorMessageFromValue } from '@proj-airi/stage-shared'

import * as v from 'valibot'

import { getWhisperModel, isWhisperModelId } from '../inference/constants'
import { classifyError, isRecoverable } from '../inference/protocol'

// ---------------------------------------------------------------------------
// Inference-specific input/output types
// ---------------------------------------------------------------------------

export interface WhisperInput {
  /** @deprecated Use audioFloat32 instead */
  audio?: string
  audioFloat32?: Float32Array
  /**
   * Whisper language code or English language name, such as `'en'` or `'japanese'`.
   * When it is omitted or empty, the worker detects the spoken language from the audio.
   */
  language?: string
}

export interface WhisperOutput {
  text: string[]
}

/** Streaming update sent during transcription as a progress message */
export interface WhisperStreamUpdate {
  /** Text that the streamer finalized since the previous update. */
  output: string
  tps?: number
  numTokens: number
}

type WhisperDevice = LoadModelRequest['device']

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

/**
 * Decoder position count of every released Whisper checkpoint. Used only when a model's config.json does not state
 * `max_target_positions`.
 */
const DEFAULT_MAX_TARGET_POSITIONS = 448

/**
 * Fields of the model's config.json that the worker needs.
 *
 * - `num_mel_bins`: height of the encoder's log-mel input. Base and Small use 80; large-v3 and large-v3-turbo use 128.
 * - `max_target_positions`: learned decoder positions. It bounds the whole decoder sequence, prompt tokens included.
 */
const ModelConfigSchema = v.object({
  num_mel_bins: v.pipe(v.number(), v.integer(), v.minValue(1)),
  max_target_positions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), DEFAULT_MAX_TARGET_POSITIONS),
})

/**
 * Fields of the model's generation_config.json that language detection needs. transformers.js does not export its
 * Whisper generation config type from the package entry, so the worker validates the raw JSON.
 */
const PromptConfigSchema = v.object({
  decoder_start_token_id: v.number(),
  is_multilingual: v.nullish(v.boolean()),
  lang_to_id: v.nullish(v.record(v.string(), v.number())),
  task_to_id: v.nullish(v.record(v.string(), v.number())),
  no_timestamps_token_id: v.nullish(v.number()),
  begin_suppress_tokens: v.nullish(v.array(v.number())),
})

/** Decoder prompt that lets the model choose the language token itself. */
interface LanguageDetectionPrompt {
  /** `<|startoftranscript|>`, the only token given to the decoder. */
  startTokenId: number
  /**
   * Allowed token IDs for each prompt position after the start token: the language tokens, then `<|transcribe|>`,
   * then `<|notimestamps|>` when the model has it.
   */
  allowedTokenIdsByStep: ReadonlyArray<ReadonlySet<number>>
  /** Tokens that must not start the transcript, such as a blank or end-of-text. Applied right after the prompt. */
  beginSuppressTokens: number[] | null
}

interface LoadedModel {
  id: WhisperModelId
  /** Device the adapter asked for. A load request for another device reloads the model. */
  requestedDevice: WhisperDevice
  /** Device actually used after the WebGPU availability check. */
  device: WhisperDevice
  tokenizer: PreTrainedTokenizer
  processor: Processor
  model: PreTrainedModel
  maxTargetPositions: number
  /** Null when the model cannot detect the language: an English-only model, or no language tokens in its config. */
  languageDetection: LanguageDetectionPrompt | null
}

/** The model that inference uses. Null before the first load, after an unload, and while a replacement loads. */
let loadedModel: LoadedModel | null = null

/**
 * Reads the language-detection prompt from a model's generation config, or returns null when the model cannot detect
 * the language.
 */
function createLanguageDetectionPrompt(generationConfig: unknown): LanguageDetectionPrompt | null {
  const result = v.safeParse(PromptConfigSchema, generationConfig)
  if (!result.success)
    return null

  const config = result.output
  const languageTokenIds = config.lang_to_id ? Object.values(config.lang_to_id) : []
  const transcribeTokenId = config.task_to_id?.transcribe
  if (!config.is_multilingual || languageTokenIds.length === 0 || transcribeTokenId == null)
    return null

  const allowedTokenIdsByStep = [new Set(languageTokenIds), new Set([transcribeTokenId])]
  if (config.no_timestamps_token_id != null)
    allowedTokenIdsByStep.push(new Set([config.no_timestamps_token_id]))

  return {
    startTokenId: config.decoder_start_token_id,
    allowedTokenIdsByStep,
    beginSuppressTokens: config.begin_suppress_tokens ?? null,
  }
}

/**
 * Restricts each decoder position after `<|startoftranscript|>` to a set of allowed tokens.
 *
 * NOTICE:
 * transformers.js does not detect the language. When `language` is omitted for a multilingual model,
 * `WhisperForConditionalGeneration._retrieve_init_tokens` logs "No language specified - defaulting to English (en)"
 * and forces `<|en|>`, so non-English speech is transcribed as English.
 * We start the decoder with `<|startoftranscript|>` only and allow only language tokens at the next position. Greedy
 * decoding then picks the language token with the highest score, which is how OpenAI Whisper detects the language.
 * The next positions are forced to `<|transcribe|>` and `<|notimestamps|>`, the prompt that transformers.js builds for
 * an explicit language.
 * Source: node_modules/@huggingface/transformers/src/models.js, `_retrieve_init_tokens`
 * ("TODO: Implement language detection"), v3.8.1.
 * Removal condition: transformers.js detects the language when `language` is omitted.
 */
class PromptTokenConstraintLogitsProcessor extends LogitsProcessor {
  private readonly allowedTokenIdsByStep: ReadonlyArray<ReadonlySet<number>>

  constructor(allowedTokenIdsByStep: ReadonlyArray<ReadonlySet<number>>) {
    super()
    this.allowedTokenIdsByStep = allowedTokenIdsByStep
  }

  override _call(inputIds: bigint[][], logits: Tensor): Tensor {
    // `logits` holds the next-token scores of each batch row: dims [batch, vocabulary], stored row by row.
    const data = logits.data
    const vocabularySize = logits.dims.at(-1)
    if (!(data instanceof Float32Array) || vocabularySize === undefined)
      throw new TypeError('Whisper language detection expects float32 logits of shape [batch, vocabulary]')

    for (let row = 0; row < inputIds.length; row++) {
      // A sequence of length 1 holds only <|startoftranscript|>, so step 0 is the language position.
      const allowed = this.allowedTokenIdsByStep[inputIds[row].length - 1]
      if (!allowed)
        continue

      const offset = row * vocabularySize
      for (let tokenId = 0; tokenId < vocabularySize; tokenId++) {
        if (!allowed.has(tokenId))
          data[offset + tokenId] = -Infinity
      }
    }

    return logits
  }
}

/**
 * Returns the `generate` options that select the transcription language.
 *
 * An explicit language goes to transformers.js, which builds the decoder prompt. Without one, the decoder starts from
 * `<|startoftranscript|>` and the model picks the language token ({@link PromptTokenConstraintLogitsProcessor}).
 * A model without language detection gets no language option: an English-only model needs none, and for a
 * multilingual model without language tokens in its config, transformers.js falls back to English.
 */
function createLanguageOptions(loaded: LoadedModel, language: string | undefined): Record<string, unknown> {
  if (language)
    return { language }

  const detection = loaded.languageDetection
  if (!detection)
    return {}

  // NOTICE: transformers.js appends its own processors to the list that it receives, so each call needs a new list.
  const logitsProcessor = new LogitsProcessorList()
  logitsProcessor.push(new PromptTokenConstraintLogitsProcessor(detection.allowedTokenIdsByStep))
  if (detection.beginSuppressTokens) {
    // transformers.js applies `begin_suppress_tokens` right after the prompt that it receives, which is only the start
    // token here. Apply them again after the full prompt: the start token plus one token for each constrained step.
    const promptLength = 1 + detection.allowedTokenIdsByStep.length
    logitsProcessor.push(new SuppressTokensAtBeginLogitsProcessor(detection.beginSuppressTokens, promptLength))
  }

  return {
    decoder_input_ids: [detection.startTokenId],
    logits_processor: logitsProcessor,
  }
}

// ---------------------------------------------------------------------------
// Model lifecycle
// ---------------------------------------------------------------------------

/**
 * Detect whether WebGPU is available inside the worker.
 * Workers don't have access to `navigator.gpu` on all browsers,
 * so we do a simple feature check.
 */
async function detectWebGPUInWorker(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu)
      return false
    const adapter = await navigator.gpu.requestAdapter()
    return adapter != null
  }
  catch {
    return false
  }
}

/** Falls back from WebGPU to WASM when the worker has no WebGPU adapter. */
async function resolveDevice(requestedDevice: WhisperDevice): Promise<WhisperDevice> {
  if (requestedDevice !== 'webgpu')
    return requestedDevice

  if (await detectWebGPUInWorker())
    return 'webgpu'

  console.warn('[Whisper Worker] WebGPU not available, falling back to WASM')
  return 'wasm'
}

async function createModel(repo: string, device: WhisperDevice, progress_callback: (info: ProgressInfo) => void): Promise<PreTrainedModel> {
  // NOTICE: fp16 encoder may fail on some devices/browsers. Fall back to fp32
  // if the initial load fails. Decoder fp16 is known broken (see Issue #989).
  // https://github.com/huggingface/transformers.js/issues/989
  try {
    return await WhisperForConditionalGeneration.from_pretrained(repo, {
      dtype: {
        encoder_model: 'fp16',
        decoder_model_merged: 'q4',
      },
      device,
      progress_callback,
    })
  }
  catch (error) {
    console.warn(
      '[Whisper Worker] fp16 encoder failed, falling back to fp32:',
      errorMessageFromValue(error),
    )
    return await WhisperForConditionalGeneration.from_pretrained(repo, {
      dtype: {
        encoder_model: 'fp32',
        decoder_model_merged: 'q4',
      },
      device,
      progress_callback,
    })
  }
}

/**
 * Releases a model's ONNX sessions. A failed release can leak the sessions' memory, but it must not stop the worker
 * from loading the next model, so the error is only logged.
 */
async function disposeModel(model: PreTrainedModel): Promise<void> {
  try {
    await model.dispose()
  }
  catch (error) {
    console.warn('[Whisper Worker] Failed to dispose a Whisper model:', errorMessageFromValue(error))
  }
}

/**
 * Unloads the current model. `loadedModel` is cleared before the sessions are released, so inference can never use a
 * model that is being disposed. The tokenizer and processor hold no native resources and are dropped with it.
 */
async function unloadCurrentModel(): Promise<void> {
  const previous = loadedModel
  if (!previous)
    return

  loadedModel = null
  await disposeModel(previous.model)
}

/**
 * Downloads, initializes, and warms up a model. On failure, nothing stays loaded: a model that was created before the
 * failure is disposed.
 */
async function initializeModel(requestId: string, id: WhisperModelId, requestedDevice: WhisperDevice): Promise<LoadedModel> {
  const { repo } = getWhisperModel(id)
  sendProgress(requestId, 'download', -1, 'Loading model...')

  const device = await resolveDevice(requestedDevice)
  const progress_callback = createDownloadProgressForwarder(requestId)

  const modelPromise = createModel(repo, device, progress_callback)
  let tokenizer: PreTrainedTokenizer
  let processor: Processor
  try {
    [tokenizer, processor] = await Promise.all([
      AutoTokenizer.from_pretrained(repo, { progress_callback }),
      AutoProcessor.from_pretrained(repo, { progress_callback }),
    ])
  }
  catch (error) {
    // The model download keeps running; dispose its sessions when it finishes instead of leaving them unreachable.
    await modelPromise.then(disposeModel, () => {})
    throw error
  }

  const model = await modelPromise
  try {
    const config = v.safeParse(ModelConfigSchema, model.config)
    if (!config.success)
      throw new Error(`${repo} has no valid num_mel_bins or max_target_positions in config.json: ${v.summarize(config.issues)}`)

    sendProgress(requestId, 'warmup', -1, 'Compiling shaders and warming up model...')

    // Run model with dummy input to compile WebGPU shaders.
    // NOTICE: Using minimal time-steps (1) instead of 3000 to reduce warm-up latency.
    // The feature height must match the encoder's mel bins: 80 for base/small, 128 for large-v3/turbo.
    const warmUpOptions: Record<string, unknown> = {
      input_features: full([1, config.output.num_mel_bins, 1], 0.0),
      max_new_tokens: 1,
    }
    await model.generate(warmUpOptions)

    return {
      id,
      requestedDevice,
      device,
      tokenizer,
      processor,
      model,
      maxTargetPositions: config.output.max_target_positions,
      languageDetection: createLanguageDetectionPrompt(model.generation_config),
    }
  }
  catch (error) {
    await disposeModel(model)
    throw error
  }
}

/**
 * Convert base64-encoded WAV audio to Float32Array features.
 * @deprecated Prefer sending Float32Array directly via transferable for zero-copy.
 */
async function base64ToFeatures(base64Audio: string): Promise<Float32Array> {
  const binaryString = atob(base64Audio)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  return toFloat32FromPCM16(bytes.subarray(44))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * RequestIds the main thread has asked us to cancel. When an in-flight
 * operation resolves, we check this set before posting the result; if
 * the id is present, we send a `CANCELLED` error instead so the adapter
 * rejects the caller's promise deterministically.
 *
 * We cannot synchronously interrupt a transformers.js call already running
 * on this thread (no abort primitive is exposed) — cancellation here is
 * about not leaking the stale result, not about stopping GPU work.
 * A queued operation whose id is in the set is skipped when its turn comes.
 */
const cancelledRequestIds = new Set<string>()

function markCancelled(targetRequestId: string): void {
  cancelledRequestIds.add(targetRequestId)
  // Emit the error now so the adapter can resolve immediately even if
  // the inference keeps running in the background.
  const msg: ErrorResponse = {
    type: 'error',
    requestId: targetRequestId,
    payload: {
      code: 'CANCELLED',
      message: 'Operation cancelled by caller',
      recoverable: false,
    },
  }
  globalThis.postMessage(msg)
}

function isCancelled(requestId: string): boolean {
  return cancelledRequestIds.has(requestId)
}

function clearCancelled(requestId: string): void {
  cancelledRequestIds.delete(requestId)
}

function sendProgress(requestId: string, phase: 'download' | 'compile' | 'warmup' | 'inference', percent: number, message?: string, extra?: Record<string, unknown>): void {
  const msg: ProgressResponse = {
    type: 'progress',
    requestId,
    payload: {
      phase,
      percent,
      message,
      ...extra,
    },
  }
  globalThis.postMessage(msg)
}

function sendError(requestId: string, error: unknown, phase?: 'load' | 'inference'): void {
  const message = errorMessageFromValue(error)
  const code = classifyError(error, phase)
  const msg: ErrorResponse = {
    type: 'error',
    requestId,
    payload: {
      code,
      message,
      recoverable: isRecoverable(code),
    },
  }
  globalThis.postMessage(msg)
}

/** Forwards transformers.js download events of one load request as protocol progress messages. */
function createDownloadProgressForwarder(requestId: string): (info: ProgressInfo) => void {
  return (info) => {
    // A cancelled load keeps downloading in the background, and the adapter no longer waits for it.
    if (isCancelled(requestId))
      return

    if (info.status === 'initiate') {
      sendProgress(requestId, 'download', 0, `Loading ${info.file}`, { file: info.file })
    }
    else if (info.status === 'progress') {
      // transformers.js reports `progress` in the 0-100 range already.
      sendProgress(requestId, 'download', Math.round(info.progress), undefined, {
        file: info.file,
        loaded: info.loaded,
        total: info.total,
      })
    }
  }
}

function postModelReady(requestId: string, loaded: LoadedModel): void {
  const ready: ModelReadyResponse = {
    type: 'model-ready',
    requestId,
    modelId: loaded.id,
    device: loaded.device,
  }
  globalThis.postMessage(ready)
}

/**
 * Tail of the operation queue. Load, inference, and unload requests run one at a time in arrival order: a
 * transformers.js call cannot be interrupted, and a load or unload disposes the model that an inference may still use,
 * for example after the adapter stopped waiting for a cancelled transcription.
 */
let operationQueue: Promise<void> = Promise.resolve()

function enqueueOperation(operation: () => Promise<void>): void {
  operationQueue = operationQueue
    .then(operation)
    // Operations report their own errors to the adapter. This only keeps an unexpected rejection from stopping every
    // later operation in the queue.
    .catch(error => console.error('[Whisper Worker] Unhandled operation error:', errorMessageFromValue(error)))
}

// ---------------------------------------------------------------------------
// Load model
// ---------------------------------------------------------------------------

async function loadModel(request: LoadModelRequest): Promise<void> {
  const { requestId, modelId, device } = request
  if (isCancelled(requestId)) {
    clearCancelled(requestId)
    return
  }

  try {
    if (!isWhisperModelId(modelId))
      throw new Error(`Unknown Whisper model ID: ${modelId}`)

    // The adapter loads again after a failed or cancelled operation because it cannot tell what the worker still holds.
    // Reply at once when the model is already here instead of downloading and warming it up again.
    if (loadedModel?.id === modelId && loadedModel.requestedDevice === device) {
      postModelReady(requestId, loadedModel)
      return
    }

    await unloadCurrentModel()
    loadedModel = await initializeModel(requestId, modelId, device)

    if (isCancelled(requestId)) {
      // Adapter already received a CANCELLED error; drop the stale result.
      // The model stays loaded, so a later request for it is answered at once.
      clearCancelled(requestId)
      return
    }

    postModelReady(requestId, loadedModel)
  }
  catch (error) {
    if (isCancelled(requestId))
      clearCancelled(requestId)
    else
      sendError(requestId, error, 'load')
  }
}

async function unloadModel(request: UnloadModelRequest): Promise<void> {
  await unloadCurrentModel()
  const unloaded: ModelUnloadedResponse = { type: 'model-unloaded', requestId: request.requestId }
  globalThis.postMessage(unloaded)
}

// ---------------------------------------------------------------------------
// Run inference (transcription)
// ---------------------------------------------------------------------------

async function resolveAudio(input: WhisperInput): Promise<Float32Array> {
  if (input.audioFloat32)
    return input.audioFloat32
  if (input.audio)
    return base64ToFeatures(input.audio)

  throw new Error('Whisper input has no audio: send audioFloat32 or audio')
}

async function runInference(request: RunInferenceRequest<WhisperInput>): Promise<void> {
  const { requestId, input } = request
  if (isCancelled(requestId)) {
    clearCancelled(requestId)
    return
  }

  try {
    const loaded = loadedModel
    if (!loaded)
      throw new Error('No Whisper model is loaded. Send load-model before run-inference.')

    sendProgress(requestId, 'inference', 0, 'Starting transcription...')

    const audioData = await resolveAudio(input)

    let startTime: number | undefined
    let numTokens = 0
    const streamer = new TextStreamer(loaded.tokenizer, {
      skip_prompt: true,
      decode_kwargs: { skip_special_tokens: true },
      callback_function: (text: string) => {
        const now = performance.now()
        startTime ??= now

        let tps: number | undefined
        if (numTokens++ > 0) {
          tps = numTokens / (now - startTime) * 1000
        }

        // Send streaming updates as progress messages with inference phase
        const update: WhisperStreamUpdate = { output: text, tps, numTokens }
        sendProgress(requestId, 'inference', -1, undefined, { ...update })
      },
    })

    const inputs = await loaded.processor(audioData)

    const generateOptions: Record<string, unknown> = {
      ...inputs,
      // Whisper's decoder has `max_target_positions` (448) positions, and the prompt tokens use some of them. Capping
      // the whole sequence with `max_length` leaves the text every remaining position, enough for a full 30-second
      // window. `max_new_tokens: null` stops generation_config.json from overriding the cap.
      max_length: loaded.maxTargetPositions,
      max_new_tokens: null,
      streamer,
      ...createLanguageOptions(loaded, input.language),
    }
    const outputs = await loaded.model.generate(generateOptions)

    const outputText = loaded.tokenizer.batch_decode(outputs as Tensor, { skip_special_tokens: true })

    if (isCancelled(requestId)) {
      clearCancelled(requestId)
    }
    else {
      const result: InferenceResultResponse<WhisperOutput> = {
        type: 'inference-result',
        requestId,
        output: { text: outputText },
      }
      globalThis.postMessage(result)
    }
  }
  catch (error) {
    if (isCancelled(requestId))
      clearCancelled(requestId)
    else
      sendError(requestId, error, 'inference')
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

globalThis.addEventListener('message', (event: MessageEvent<WorkerInboundMessage<WhisperInput>>) => {
  const message = event.data

  switch (message.type) {
    case 'load-model':
      enqueueOperation(() => loadModel(message))
      break
    case 'run-inference':
      enqueueOperation(() => runInference(message))
      break
    case 'unload-model':
      enqueueOperation(() => unloadModel(message))
      break
    case 'cancel':
      // Not queued: the cancel must reach an operation that is waiting in the queue or already running.
      markCancelled(message.targetRequestId)
      break
  }
})
