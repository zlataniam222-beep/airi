import type { ProgressInfo } from '@xsai-transformers/shared/types'

import type { WhisperModelId } from '../../../inference/constants'
import type { ProgressPayload } from '../../../inference/protocol'
import type { ProviderModelCatalog } from '../../types'

import { z } from 'zod'

import { getWhisperAdapter } from '../../../inference/adapters/whisper'
import { DEFAULT_WHISPER_MODEL_ID, isWhisperModelId, WHISPER_MODELS } from '../../../inference/constants'
import { defineProvider } from '../registry'
import { WHISPER_LOCAL_PROVIDER_ID } from './constants'

export { WHISPER_LOCAL_PROVIDER_ID } from './constants'

/**
 * Host name of the OpenAI-shaped endpoint that this provider serves in-process.
 * xsAI builds request URLs from it, but no network request leaves the renderer.
 */
const WHISPER_LOCAL_BASE_URL = 'http://whisper-local/v1/'

/** Whisper feature extraction reads mono PCM samples at 16 kHz. */
const WHISPER_SAMPLE_RATE = 16_000

/**
 * Language codes that transformers.js accepts as a Whisper language hint.
 *
 * NOTICE:
 * transformers.js throws for a code outside this table instead of detecting the language.
 * Hearing sends the UI locale by default, so a locale such as `fil` would fail every request.
 * Copied from `WHISPER_LANGUAGES` in `@huggingface/transformers` 3.8.1
 * (`src/models/whisper/common_whisper.js`). The package does not export the table, and
 * importing the package on the main thread would load the whole inference runtime.
 * Remove when transformers.js exports the table from a side-effect-free entry.
 */
const WHISPER_LANGUAGE_CODES: ReadonlySet<string> = new Set([
  'en',
  'zh',
  'de',
  'es',
  'ru',
  'ko',
  'fr',
  'ja',
  'pt',
  'tr',
  'pl',
  'ca',
  'nl',
  'ar',
  'sv',
  'it',
  'id',
  'hi',
  'fi',
  'vi',
  'he',
  'uk',
  'el',
  'ms',
  'cs',
  'ro',
  'da',
  'hu',
  'ta',
  'no',
  'th',
  'ur',
  'hr',
  'bg',
  'lt',
  'la',
  'mi',
  'ml',
  'cy',
  'sk',
  'te',
  'fa',
  'lv',
  'bn',
  'sr',
  'az',
  'sl',
  'kn',
  'et',
  'mk',
  'br',
  'eu',
  'is',
  'hy',
  'ne',
  'mn',
  'bs',
  'kk',
  'sq',
  'sw',
  'gl',
  'mr',
  'pa',
  'si',
  'km',
  'sn',
  'yo',
  'so',
  'af',
  'oc',
  'ka',
  'be',
  'tg',
  'sd',
  'gu',
  'am',
  'yi',
  'lo',
  'uz',
  'fo',
  'ht',
  'ps',
  'tk',
  'nn',
  'mt',
  'sa',
  'lb',
  'my',
  'bo',
  'tl',
  'mg',
  'as',
  'tt',
  'haw',
  'ln',
  'ha',
  'ba',
  'jw',
  'su',
])

const whisperLocalConfigSchema = z.object({
  /**
   * Model preloaded by provider settings. Transcription requests use the Hearing model first;
   * see `resolveActiveTranscriptionModel` in the Hearing store.
   */
  model: z.string().optional(),
})

type WhisperLocalConfig = z.input<typeof whisperLocalConfigSchema>

/** Fields read from the multipart body that `generateTranscription` from `@xsai/generate-transcription` sends. */
interface WhisperTranscriptionRequest {
  file: Blob
  modelId: WhisperModelId
  /** Omitted when Whisper should detect the spoken language. */
  language?: string
}

/**
 * Resolves the language hint that Whisper can accept.
 *
 * Hearing sends an OpenAI-style `language` field, usually the primary subtag of the UI locale.
 * An unsupported code resolves to `undefined`, so Whisper detects the spoken language instead of
 * rejecting the request.
 *
 * @example
 * resolveWhisperLanguage('zh-Hans')
 * // => 'zh'
 *
 * @example
 * resolveWhisperLanguage('fil')
 * // => undefined
 */
function resolveWhisperLanguage(language: FormDataEntryValue | null): string | undefined {
  if (typeof language !== 'string')
    return undefined

  const primarySubtag = language.trim().split(/[-_]/)[0]?.toLowerCase() ?? ''
  return WHISPER_LANGUAGE_CODES.has(primarySubtag) ? primarySubtag : undefined
}

function readTranscriptionRequest(body: RequestInit['body']): WhisperTranscriptionRequest {
  if (!(body instanceof FormData))
    throw new Error('Whisper (Local) expects the multipart body that generateTranscription sends.')

  const file = body.get('file')
  if (!(file instanceof Blob))
    throw new Error('Whisper (Local) transcription request has no audio file.')

  const model = body.get('model')
  if (typeof model !== 'string' || !isWhisperModelId(model)) {
    const expected = WHISPER_MODELS.map(definition => definition.id).join(', ')
    throw new Error(`Unknown Whisper model "${String(model)}". Select one of these models in Settings > Hearing: ${expected}.`)
  }

  // NOTICE: The adapter has no prompt input, so an OpenAI `prompt` field is not forwarded.
  return {
    file,
    modelId: model,
    language: resolveWhisperLanguage(body.get('language')),
  }
}

/**
 * Decodes recorded audio to the mono 16 kHz samples that Whisper reads.
 *
 * Decoding stays on the main thread because workers have no `OfflineAudioContext`.
 */
async function decodeWhisperAudio(file: Blob): Promise<Float32Array> {
  // `decodeAudioData` resamples to the rate of its context, so this returns
  // 16 kHz frames that keep the channel count of the recording.
  const decodeContext = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE)
  const decoded = await decodeContext.decodeAudioData(await file.arrayBuffer())
  if (decoded.numberOfChannels === 1 || decoded.length === 0)
    return decoded.getChannelData(0)

  // A one-channel destination applies the Web Audio down-mix rules,
  // for example `0.5 * (left + right)` for stereo input.
  const mixContext = new OfflineAudioContext(1, decoded.length, WHISPER_SAMPLE_RATE)
  const source = mixContext.createBufferSource()
  source.buffer = decoded
  source.connect(mixContext.destination)
  source.start()
  const rendered = await mixContext.startRendering()
  return rendered.getChannelData(0)
}

/**
 * How {@link splitIntoWhisperWindows} splits a recording that is longer than one Whisper input.
 *
 * The Whisper feature extractor in transformers.js reads at most 30 s of audio and silently drops
 * the rest (`n_samples` in `WhisperFeatureExtractor`, `@huggingface/transformers` 3.8.1). Each
 * window therefore ends at the quietest point of the last seconds before its 30 s limit, so a cut
 * lands in a pause between words when the speaker made one, and inside speech only when they did not.
 */
const whisperWindowPolicy = {
  /** Longest window that Whisper reads without truncation: 30 s, or 480000 samples at 16 kHz. */
  maxSamples: 30 * WHISPER_SAMPLE_RATE,
  /** The cut is searched in the last 5 s of each window. A longer span finds more pauses but makes shorter windows. */
  cutSearchSamples: 5 * WHISPER_SAMPLE_RATE,
  /**
   * Length of the frames whose loudness is compared: 100 ms. This is longer than the near-silent
   * closure of most stop consonants, so the quietest frame is usually a pause and not a gap inside a word.
   */
  frameSamples: WHISPER_SAMPLE_RATE / 10,
  /**
   * A window of a split recording is not transcribed when its loudest frame is more than 50 dB
   * quieter than the loudest frame of the recording. This ratio compares mean squares, so 1e-5 is -50 dB.
   *
   * NOTICE:
   * Whisper invents text for silence, such as "you". A recording whose speech ends before 30 s but
   * that continues for a few silent seconds would otherwise get that text at the end.
   * Soft speech stays well within 50 dB of the loudest speech, while digital silence and noise-suppressed
   * microphone silence are far below it. Room noise without noise suppression can be louder than this
   * limit, so its window is still transcribed, as a recording of 30 s or less always is.
   * In an end-to-end run, Whisper returned "you" for the silent last 2 s of a 32 s recording whose
   * speech ended at 29 s (`packages/testing-audio/cases/two-utterance-streaming/input.test.wav`).
   */
  silentWindowEnergyRatio: 1e-5,
}

function meanSquare(samples: Float32Array, start: number, end: number): number {
  let sum = 0
  for (let index = start; index < end; index++)
    sum += samples[index] * samples[index]

  return sum / (end - start)
}

/**
 * Returns the sample index of the cut in the quietest frame between `searchStart` and `searchEnd`.
 *
 * The cut is the middle of the quietest frame, so both windows start or end in that quiet stretch.
 * The returned index is always below `searchEnd`.
 */
function findQuietestCut(samples: Float32Array, searchStart: number, searchEnd: number): number {
  const { frameSamples } = whisperWindowPolicy
  let quietestEnergy = Number.POSITIVE_INFINITY
  let cut = searchStart + frameSamples / 2

  for (let frameStart = searchStart; frameStart + frameSamples <= searchEnd; frameStart += frameSamples) {
    const energy = meanSquare(samples, frameStart, frameStart + frameSamples)
    // `<=` keeps the latest of equally quiet frames, such as a long stretch of silence.
    // A later cut makes the window longer, so the recording needs fewer Whisper calls.
    if (energy <= quietestEnergy) {
      quietestEnergy = energy
      cut = frameStart + frameSamples / 2
    }
  }

  return cut
}

/** Mean square of the loudest frame. A last part shorter than one frame counts as a frame. */
function loudestFrameEnergy(samples: Float32Array): number {
  const { frameSamples } = whisperWindowPolicy
  let loudestEnergy = 0
  for (let frameStart = 0; frameStart < samples.length; frameStart += frameSamples)
    loudestEnergy = Math.max(loudestEnergy, meanSquare(samples, frameStart, Math.min(frameStart + frameSamples, samples.length)))

  return loudestEnergy
}

/**
 * Splits decoded 16 kHz audio into the windows that Whisper transcribes, in recording order.
 *
 * Audio of 30 s or less is returned as the only window, even when it is silent. Longer audio is cut
 * by {@link whisperWindowPolicy}, and windows that are silent next to the rest of the recording are
 * left out. Windows never overlap, so no speech is transcribed twice.
 *
 * NOTICE:
 * Windows are copies, not `subarray` views. The adapter posts each window to the inference worker,
 * and a view would clone, or after a transfer detach, the whole recording buffer instead of one window.
 *
 * @example
 * splitIntoWhisperWindows(fortySecondsWithPauseAt27s)
 * // => [samples from 0 s to about 27 s, samples from about 27 s to 40 s]
 *
 * @example
 * splitIntoWhisperWindows(speechUntil28sThenSilenceUntil32s)
 * // => [samples from 0 s to about 30 s]
 */
function splitIntoWhisperWindows(samples: Float32Array): Float32Array[] {
  const { maxSamples, cutSearchSamples, silentWindowEnergyRatio } = whisperWindowPolicy
  if (samples.length <= maxSamples)
    return [samples]

  const windows: Float32Array[] = []
  let windowStart = 0
  while (samples.length - windowStart > maxSamples) {
    const windowLimit = windowStart + maxSamples
    const cut = findQuietestCut(samples, windowLimit - cutSearchSamples, windowLimit)
    windows.push(samples.slice(windowStart, cut))
    windowStart = cut
  }
  windows.push(samples.slice(windowStart))

  const windowEnergies = windows.map(loudestFrameEnergy)
  // A recording that is silent everywhere keeps all windows, because 0 >= 0 * ratio.
  const silenceLimit = Math.max(...windowEnergies) * silentWindowEnergyRatio
  return windows.filter((_, index) => windowEnergies[index] >= silenceLimit)
}

/**
 * Serves `POST audio/transcriptions` for `generateTranscription` in this renderer.
 *
 * The request URL is ignored because this function is the only endpoint behind
 * {@link WHISPER_LOCAL_BASE_URL}. `init.signal` cancels model loading and inference.
 *
 * A recording longer than 30 s is transcribed as several windows, one after another, with the same
 * model, language hint, and signal (see {@link splitIntoWhisperWindows}). If any window fails or the
 * signal aborts, the whole request fails, so Hearing never receives part of the text as a full result.
 */
async function transcribeLocally(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = readTranscriptionRequest(init?.body)
  const signal = init?.signal ?? undefined
  signal?.throwIfAborted()

  const audioFloat32 = await decodeWhisperAudio(request.file)
  // NOTICE: A recording without samples has no speech to transcribe. An empty
  // text lets Hearing report its existing "no transcription result" error
  // without loading a model.
  if (audioFloat32.length === 0)
    return transcriptionResponse('')

  const adapter = await getWhisperAdapter()
  const windowTexts: string[] = []
  for (const windowSamples of splitIntoWhisperWindows(audioFloat32)) {
    // `load` resolves at once while the requested model is loaded. Calling it for each window keeps
    // every window on the requested model if another request switched the adapter between windows.
    await adapter.load(undefined, { signal, modelId: request.modelId })
    windowTexts.push(await adapter.transcribe({ audioFloat32: windowSamples, language: request.language }, { signal }))
  }

  // Whisper's text already carries the separator of its language: it starts with a space in languages
  // that use spaces, and with none in Chinese or Japanese. Joining the texts unchanged keeps that
  // separator at each cut. A window without speech is dropped so it adds no extra space.
  const text = windowTexts
    .filter(windowText => windowText.trim().length > 0)
    .join('')
    .trim()
  return transcriptionResponse(text)
}

/**
 * Builds the response for both `json` and `verbose_json` requests.
 *
 * NOTICE:
 * A `verbose_json` request also receives only `{ text }`. The Hearing confidence filter reads
 * `segments[].avg_logprob`, and the Whisper adapter returns no token log probabilities.
 * Segments without that field make `filterTranscriptionByConfidence` return an empty string, and
 * an invented value would accept or reject speech at random. Without `segments`, Hearing keeps
 * the full text and logs that the provider does not support confidence filtering.
 * Remove when the adapter returns per-segment log probabilities.
 */
function transcriptionResponse(text: string): Response {
  return new Response(JSON.stringify({ text }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

function toProgressInfo(progress: ProgressPayload): ProgressInfo {
  return {
    name: progress.file ?? '',
    file: progress.file ?? '',
    // Indeterminate progress uses -1 in the inference protocol.
    progress: progress.percent >= 0 ? progress.percent : 0,
    status: 'progress',
    loaded: progress.loaded ?? 0,
    total: progress.total ?? 0,
  }
}

export const providerWhisperLocal = defineProvider<WhisperLocalConfig, typeof WHISPER_LOCAL_PROVIDER_ID>({
  id: WHISPER_LOCAL_PROVIDER_ID,
  name: 'Whisper (Local)',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.whisper-local.title'),
  description: 'Local speech-to-text with OpenAI Whisper, running on this device.',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.whisper-local.description'),
  tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
  icon: 'i-lobe-icons:openai',
  requiresCredentials: false,
  capabilities: {
    transcription: {
      protocol: 'http',
      generateOutput: true,
      streamOutput: false,
      streamInput: false,
    },
  },
  createProviderConfig: () => whisperLocalConfigSchema,
  createProvider: () => ({
    transcription: (model: string, extraOptions?: Record<string, unknown>) => ({
      baseURL: WHISPER_LOCAL_BASE_URL,
      model,
      ...extraOptions,
      fetch: transcribeLocally,
    }),
  }),
  validationRequiredWhen: () => false,
  extraMethods: {
    // The catalog lists models from smallest to largest. `defaultModel` is the model that Settings > Hearing
    // selects when the user switches to this provider, so the choice does not depend on list order.
    listModelCatalog: async (_config, _provider, contextOptions): Promise<ProviderModelCatalog> => ({
      models: WHISPER_MODELS.map(model => ({
        id: model.id,
        name: model.name,
        provider: WHISPER_LOCAL_PROVIDER_ID,
        description: contextOptions ? contextOptions.t(model.descriptionKey) : model.descriptionKey,
      })),
      defaultModel: DEFAULT_WHISPER_MODEL_ID,
    }),
    loadModel: async (config, _provider, hooks) => {
      // Preloading only warms the adapter. A missing or unknown model loads the
      // default, and each transcription request still validates its own model.
      const modelId = config.model && isWhisperModelId(config.model) ? config.model : DEFAULT_WHISPER_MODEL_ID
      const adapter = await getWhisperAdapter()
      await adapter.load(
        hooks?.onProgress ? progress => void hooks.onProgress?.(toProgressInfo(progress)) : undefined,
        { modelId },
      )
    },
  },
})
