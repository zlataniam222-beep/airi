/**
 * Centralized constants for the inference pipeline.
 *
 * Model IDs, timeout values, and retry parameters shared across
 * all adapters and workers.
 */

// ---------------------------------------------------------------------------
// Model IDs
// ---------------------------------------------------------------------------

/**
 * HuggingFace model repository identifiers.
 * Whisper is not listed here because the user selects one of several repositories; see {@link WHISPER_MODELS}.
 */
export const MODEL_IDS = {
  KOKORO: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  BG_REMOVAL: 'Xenova/modnet',
} as const

/**
 * Short model identifiers used in adapter state tracking and logging.
 * Whisper uses its {@link WhisperModelId} values instead.
 */
export const MODEL_NAMES = {
  KOKORO: 'kokoro-82m',
  BG_REMOVAL: 'modnet',
} as const

/**
 * A Whisper speech-to-text model that the local Whisper worker can load.
 *
 * Hearing settings store `id`, the Whisper adapter sends `id` to the worker in `load-model`, and the worker resolves
 * `repo` from this table. The table is the allow-list: the worker rejects an ID that is not in it.
 */
export interface WhisperModelDefinition {
  /** Stable model ID stored in Hearing settings and sent by the provider. */
  id: 'whisper-base' | 'whisper-small' | 'whisper-large-v3-turbo'
  /** Hugging Face repository that the worker downloads. */
  repo: string
  /** English display name, e.g. 'Whisper Small'. */
  name: string
  /**
   * i18n key of a one-sentence description of the model. The whisper-local provider's model catalog and the
   * Whisper (Local) settings page translate it for their model pickers.
   */
  descriptionKey: string
  /** Rough GPU memory estimate in bytes for the GPU coordinator. */
  vramEstimateBytes: number
}

/**
 * Whisper models offered for local transcription, smallest first.
 *
 * All three repositories are standard transformers.js conversions (`encoder_model{,_fp16}.onnx` and
 * `decoder_model_merged_q4.onnx`), which the worker's dtype selection relies on.
 *
 * `vramEstimateBytes` values are estimates for the fp16 encoder plus the q4 decoder, not measurements. The GPU
 * coordinator only uses them for advisory memory-pressure bookkeeping.
 */
export const WHISPER_MODELS: readonly WhisperModelDefinition[] = Object.freeze([
  {
    id: 'whisper-base',
    repo: 'onnx-community/whisper-base',
    name: 'Whisper Base',
    descriptionKey: 'settings.pages.providers.provider.whisper-local.models.whisper-base.description',
    // Estimate: ~74M parameters.
    vramEstimateBytes: 200 * 1024 * 1024,
  },
  {
    id: 'whisper-small',
    repo: 'onnx-community/whisper-small',
    name: 'Whisper Small',
    descriptionKey: 'settings.pages.providers.provider.whisper-local.models.whisper-small.description',
    // Estimate: ~244M parameters.
    vramEstimateBytes: 500 * 1024 * 1024,
  },
  {
    id: 'whisper-large-v3-turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    descriptionKey: 'settings.pages.providers.provider.whisper-local.models.whisper-large-v3-turbo.description',
    // Estimate: ~809M parameters, most of them in the fp16 encoder.
    vramEstimateBytes: 800 * 1024 * 1024,
  },
])

export type WhisperModelId = WhisperModelDefinition['id']

/** The model that a new local Whisper setup uses. Small balances accuracy against download size and speed. */
export const DEFAULT_WHISPER_MODEL_ID: WhisperModelId = 'whisper-small'

export function isWhisperModelId(value: string): value is WhisperModelId {
  return WHISPER_MODELS.some(model => model.id === value)
}

/**
 * Returns the definition of a Whisper model.
 *
 * Throws when `id` is not in {@link WHISPER_MODELS}. That only happens when an unchecked value was cast to
 * {@link WhisperModelId}; validate untrusted input with {@link isWhisperModelId} first.
 */
export function getWhisperModel(id: WhisperModelId): WhisperModelDefinition {
  const definition = WHISPER_MODELS.find(model => model.id === id)
  if (!definition)
    throw new Error(`Unknown Whisper model: ${id}`)

  return definition
}

// ---------------------------------------------------------------------------
// Timeouts (ms)
// ---------------------------------------------------------------------------

export const TIMEOUTS = {
  /** Kokoro model load timeout */
  KOKORO_LOAD: 120_000,
  /** Kokoro audio generation timeout */
  KOKORO_GENERATE: 120_000,

  /**
   * Whisper model load inactivity timeout: the longest time a load may go without a progress message for its request.
   * Every progress message restarts the timer, so a slow download that keeps progressing does not fail. The silent
   * phases (ONNX session creation and the warm-up run) must each finish within this time.
   */
  WHISPER_LOAD: 180_000,
  /**
   * Whisper transcription inactivity timeout: the longest time a transcription may go without a progress message for
   * its request. The worker sends a progress message for each piece of streamed text, so long outputs do not fail.
   * The encoder pass and the decoding before the first word must finish within this time.
   */
  WHISPER_TRANSCRIBE: 120_000,

  /** Background removal model load timeout */
  BG_REMOVAL_LOAD: 120_000,
  /** Background removal per-image processing timeout */
  BG_REMOVAL_PROCESS: 60_000,
} as const

// ---------------------------------------------------------------------------
// Restart / Retry
// ---------------------------------------------------------------------------

/** Maximum number of automatic worker restarts before giving up */
export const MAX_RESTARTS = 3

/** Base delay in ms between restart attempts (multiplied by attempt number) */
export const RESTART_DELAY_MS = 1_000

// ---------------------------------------------------------------------------
// Device loss resilience
// ---------------------------------------------------------------------------

/**
 * Number of WebGPU device-loss events an adapter tolerates before proactively
 * promoting subsequent loads to WASM. A single device loss may be transient
 * (driver reset, GPU process crash), but repeated losses indicate the WebGPU
 * path is unreliable on this device and WASM is safer.
 */
export const DEVICE_LOSS_WASM_THRESHOLD = 2
