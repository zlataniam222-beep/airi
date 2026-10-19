import type { TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { ProgressInfo } from '@xsai-transformers/shared/types'

import type { WhisperAdapter } from '../../../inference/adapters/whisper'

import { toWav } from '@proj-airi/audio/encoding'
import { generateTranscription } from '@xsai/generate-transcription'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_WHISPER_MODEL_ID, WHISPER_MODELS } from '../../../inference/constants'
import { getDefinedProvider } from '../registry'
import { WHISPER_LOCAL_PROVIDER_ID } from './constants'

import './index'

// The adapter owns the inference worker and model downloads. Tests replace that
// boundary and keep request parsing and Web Audio decoding real.
const whisperAdapter = vi.hoisted(() => ({
  load: vi.fn<WhisperAdapter['load']>(),
  transcribe: vi.fn<WhisperAdapter['transcribe']>(),
}))

vi.mock('../../../inference/adapters/whisper', () => ({
  getWhisperAdapter: async () => whisperAdapter,
}))

function getWhisperLocalDefinition() {
  const definition = getDefinedProvider(WHISPER_LOCAL_PROVIDER_ID)
  if (!definition)
    throw new Error('Whisper (Local) is not registered.')

  return definition
}

async function createWhisperLocalProvider() {
  const provider = await getWhisperLocalDefinition().createProvider({})
  if (!('transcription' in provider))
    throw new Error('Whisper (Local) does not create a transcription provider.')

  return provider as TranscriptionProviderWithExtraOptions<string, Record<string, unknown>>
}

/** Creates a 0.5 second stereo WAV recording at 48 kHz with constant channel levels. */
function createStereoRecording(left: number, right: number) {
  const sampleRate = 48_000
  const frames = sampleRate / 2
  const interleaved = new Float32Array(frames * 2)
  for (let frame = 0; frame < frames; frame++) {
    interleaved[frame * 2] = left
    interleaved[frame * 2 + 1] = right
  }

  return new File([toWav(interleaved.buffer, sampleRate, 2)], 'recording.wav', { type: 'audio/wav' })
}

describe('whisper-local provider', () => {
  beforeEach(() => {
    whisperAdapter.load.mockReset().mockResolvedValue(undefined)
    whisperAdapter.transcribe.mockReset().mockResolvedValue('hello from whisper')
  })

  it('returns the Whisper text through generateTranscription', async () => {
    const provider = await createWhisperLocalProvider()

    const result = await generateTranscription({
      ...provider.transcription('whisper-small', { language: 'en' }),
      file: createStereoRecording(0.4, 0.2),
      fileName: 'recording.wav',
    })

    expect(result.text).toBe('hello from whisper')
  })

  it('loads the requested model with the request signal before transcription', async () => {
    const provider = await createWhisperLocalProvider()
    const controller = new AbortController()

    await generateTranscription({
      ...provider.transcription('whisper-base', { language: 'en' }),
      abortSignal: controller.signal,
      file: createStereoRecording(0.4, 0.2),
    })

    expect(whisperAdapter.load).toHaveBeenCalledWith(undefined, { modelId: 'whisper-base', signal: controller.signal })
    expect(whisperAdapter.transcribe).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal })
    expect(whisperAdapter.load.mock.invocationCallOrder[0]).toBeLessThan(whisperAdapter.transcribe.mock.invocationCallOrder[0])
  })

  it('decodes stereo 48 kHz audio to mono 16 kHz samples', async () => {
    const provider = await createWhisperLocalProvider()

    await generateTranscription({
      ...provider.transcription('whisper-small'),
      file: createStereoRecording(0.4, 0.2),
    })

    const input = whisperAdapter.transcribe.mock.calls[0][0]
    // 0.5 seconds at 16 kHz. The one-channel render averages both channels.
    expect(input.audioFloat32).toHaveLength(8_000)
    expect(input.audioFloat32?.[4_000]).toBeCloseTo(0.3, 2)
  })

  it('passes a supported language hint to Whisper', async () => {
    const provider = await createWhisperLocalProvider()

    await generateTranscription({
      ...provider.transcription('whisper-small', { language: 'ja' }),
      file: createStereoRecording(0.4, 0.2),
    })

    expect(whisperAdapter.transcribe.mock.calls[0][0].language).toBe('ja')
  })

  it('omits a language that Whisper does not support so it detects the language', async () => {
    const provider = await createWhisperLocalProvider()

    await generateTranscription({
      ...provider.transcription('whisper-small', { language: 'fil' }),
      file: createStereoRecording(0.4, 0.2),
    })

    expect(whisperAdapter.transcribe).toHaveBeenCalledTimes(1)
    expect(whisperAdapter.transcribe.mock.calls[0][0].language).toBeUndefined()
  })

  it('rejects an unknown model without loading Whisper', async () => {
    const provider = await createWhisperLocalProvider()

    await expect(generateTranscription({
      ...provider.transcription('whisper-tiny'),
      file: createStereoRecording(0.4, 0.2),
    })).rejects.toThrow('Unknown Whisper model "whisper-tiny"')

    expect(whisperAdapter.load).not.toHaveBeenCalled()
    expect(whisperAdapter.transcribe).not.toHaveBeenCalled()
  })

  it('answers verbose_json without segments because Whisper reports no confidence', async () => {
    const provider = await createWhisperLocalProvider()

    const result = await generateTranscription({
      ...provider.transcription('whisper-small'),
      file: createStereoRecording(0.4, 0.2),
      responseFormat: 'verbose_json',
    })

    expect(result.text).toBe('hello from whisper')
    expect(result.segments).toBeUndefined()
  })

  it('lists every Whisper model for the Hearing model picker', async () => {
    const definition = getWhisperLocalDefinition()
    const models = await definition.extraMethods?.listModels?.({}, await definition.createProvider({}), { t: key => `translated:${key}` })

    expect(models?.map(model => model.id)).toEqual(WHISPER_MODELS.map(model => model.id))
    expect(models?.[0]?.provider).toBe(WHISPER_LOCAL_PROVIDER_ID)
    expect(models?.[0]?.description).toBe(`translated:${WHISPER_MODELS[0].descriptionKey}`)
  })

  it('preloads the default model for an unknown configured model and forwards progress', async () => {
    const definition = getWhisperLocalDefinition()
    const onProgress = vi.fn<(progress: ProgressInfo) => void>()
    whisperAdapter.load.mockImplementation(async (reportProgress) => {
      reportProgress?.({ phase: 'download', percent: 40, file: 'encoder_model.onnx', loaded: 4, total: 10 })
    })

    await definition.extraMethods?.loadModel?.({ model: 'whisper-tiny' }, await definition.createProvider({}), { onProgress })

    expect(whisperAdapter.load).toHaveBeenCalledWith(expect.any(Function), { modelId: DEFAULT_WHISPER_MODEL_ID })
    expect(onProgress).toHaveBeenCalledWith({
      name: 'encoder_model.onnx',
      file: 'encoder_model.onnx',
      progress: 40,
      status: 'progress',
      loaded: 4,
      total: 10,
    })
  })
})
