import type { ProgressInfo } from '@xsai-transformers/shared/types'

import type { WhisperModelId } from '../../../inference/constants'
import type { ProgressPayload } from '../../../inference/protocol'
import type { ModelInfo } from '../../types'

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
 * Serves `POST audio/transcriptions` for `generateTranscription` in this renderer.
 *
 * The request URL is ignored because this function is the only endpoint behind
 * {@link WHISPER_LOCAL_BASE_URL}. `init.signal` cancels model loading and inference.
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
  await adapter.load(undefined, { signal, modelId: request.modelId })
  const text = await adapter.transcribe({ audioFloat32, language: request.language }, { signal })
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
    listModels: async (_config, _provider, contextOptions): Promise<ModelInfo[]> => WHISPER_MODELS.map(model => ({
      id: model.id,
      name: model.name,
      provider: WHISPER_LOCAL_PROVIDER_ID,
      description: contextOptions ? contextOptions.t(model.descriptionKey) : model.descriptionKey,
    })),
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
