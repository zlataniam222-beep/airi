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

/** Whisper reads 16 kHz audio, so a recording at this rate decodes to the same samples. */
const WHISPER_SAMPLE_RATE = 16_000

/** Largest window that the Whisper feature extractor reads without truncation: 30 s at 16 kHz. */
const WHISPER_WINDOW_SAMPLES = 30 * WHISPER_SAMPLE_RATE

/** A span of the recording in seconds, with the tone amplitude in that span. 0 is silence. */
interface RecordingSpan {
  from: number
  to: number
  amplitude: number
}

/**
 * Creates a mono 16 kHz WAV recording of a 220 Hz tone that stands in for speech.
 *
 * Each span sets the tone amplitude from `from` to `to` seconds. Time outside every span is silent.
 */
function createSpokenRecording(durationSeconds: number, spans: RecordingSpan[]) {
  const samples = new Float32Array(durationSeconds * WHISPER_SAMPLE_RATE)
  for (const span of spans) {
    for (let index = span.from * WHISPER_SAMPLE_RATE; index < span.to * WHISPER_SAMPLE_RATE; index++)
      samples[index] = span.amplitude * Math.sin(2 * Math.PI * 220 * index / WHISPER_SAMPLE_RATE)
  }

  return new File([toWav(samples.buffer, WHISPER_SAMPLE_RATE)], 'recording.wav', { type: 'audio/wav' })
}

function peakOf(samples: Float32Array) {
  return samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
}

function transcribedWindows() {
  return whisperAdapter.transcribe.mock.calls.map(([input]) => {
    if (!input.audioFloat32)
      throw new Error('Whisper (Local) sent a window without decoded samples.')

    return input.audioFloat32
  })
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

  // ROOT CAUSE:
  //
  // Speech after 30 s was lost. One adapter call got the whole recording,
  // and Whisper feature extraction keeps only 30 s.
  //
  // adapter.transcribe({ audioFloat32 }) // 40 s in, text of 0-30 s out
  //
  // We fixed this by transcribing windows of at most 30 s, cut in a pause.
  it('transcribes a 40 s recording as two windows of at most 30 s, in order', async () => {
    const provider = await createWhisperLocalProvider()
    const controller = new AbortController()
    whisperAdapter.transcribe
      .mockResolvedValueOnce(' First part of the speech.')
      .mockResolvedValueOnce(' Second part of the speech.')

    const result = await generateTranscription({
      ...provider.transcription('whisper-base', { language: 'de' }),
      abortSignal: controller.signal,
      // The tone is louder after the pause, so each window shows which part of the recording it holds.
      file: createSpokenRecording(40, [
        { from: 0, to: 27, amplitude: 0.2 },
        { from: 27.5, to: 40, amplitude: 0.4 },
      ]),
    })

    const windows = transcribedWindows()
    expect(result.text).toBe('First part of the speech. Second part of the speech.')
    expect(windows).toHaveLength(2)
    expect(windows[0].length).toBeLessThanOrEqual(WHISPER_WINDOW_SAMPLES)
    expect(windows[1].length).toBeLessThanOrEqual(WHISPER_WINDOW_SAMPLES)
    expect(windows[0].length + windows[1].length).toBe(40 * WHISPER_SAMPLE_RATE)
    expect(peakOf(windows[0])).toBeCloseTo(0.2, 2)
    expect(peakOf(windows[1])).toBeCloseTo(0.4, 2)
    expect(whisperAdapter.transcribe).toHaveBeenNthCalledWith(1, expect.objectContaining({ language: 'de' }), { signal: controller.signal })
    expect(whisperAdapter.transcribe).toHaveBeenNthCalledWith(2, expect.objectContaining({ language: 'de' }), { signal: controller.signal })
    expect(whisperAdapter.load).toHaveBeenLastCalledWith(undefined, { modelId: 'whisper-base', signal: controller.signal })
  })

  it('cuts a long recording in its quietest pause before the 30 s limit', async () => {
    const provider = await createWhisperLocalProvider()

    await generateTranscription({
      ...provider.transcription('whisper-small'),
      // A silent pause from 26.0 s to 26.4 s, and a softer stretch that is not silent from 28.5 s to 29.5 s.
      file: createSpokenRecording(40, [
        { from: 0, to: 26, amplitude: 0.3 },
        { from: 26.4, to: 28.5, amplitude: 0.3 },
        { from: 28.5, to: 29.5, amplitude: 0.05 },
        { from: 29.5, to: 40, amplitude: 0.3 },
      ]),
    })

    const windows = transcribedWindows()
    const cutSeconds = windows[0].length / WHISPER_SAMPLE_RATE
    expect(windows).toHaveLength(2)
    expect(cutSeconds).toBeGreaterThanOrEqual(26)
    expect(cutSeconds).toBeLessThanOrEqual(26.4)
  })

  it('does not transcribe the silent end of a long recording', async () => {
    const provider = await createWhisperLocalProvider()

    const result = await generateTranscription({
      ...provider.transcription('whisper-small'),
      // Speech ends at 28 s and the recording stops at 34 s.
      file: createSpokenRecording(34, [{ from: 0, to: 28, amplitude: 0.3 }]),
    })

    const windows = transcribedWindows()
    expect(result.text).toBe('hello from whisper')
    expect(windows).toHaveLength(1)
    expect(windows[0].length).toBeLessThanOrEqual(WHISPER_WINDOW_SAMPLES)
    expect(windows[0].length).toBeGreaterThanOrEqual(28 * WHISPER_SAMPLE_RATE)
  })

  it('transcribes soft speech after the cut', async () => {
    const provider = await createWhisperLocalProvider()

    await generateTranscription({
      ...provider.transcription('whisper-small'),
      // The speech after the pause is 40 dB softer than the speech before it.
      file: createSpokenRecording(40, [
        { from: 0, to: 27, amplitude: 0.3 },
        { from: 27.5, to: 40, amplitude: 0.003 },
      ]),
    })

    const windows = transcribedWindows()
    expect(windows).toHaveLength(2)
    expect(peakOf(windows[1])).toBeCloseTo(0.003, 3)
  })

  it('joins window texts with the separator that Whisper gives each language', async () => {
    const provider = await createWhisperLocalProvider()
    const longRecording = () => createSpokenRecording(40, [
      { from: 0, to: 27, amplitude: 0.3 },
      { from: 28, to: 40, amplitude: 0.3 },
    ])

    whisperAdapter.transcribe
      .mockResolvedValueOnce('今日はいい天気です。')
      .mockResolvedValueOnce('公園に行きます。')
    const japanese = await generateTranscription({ ...provider.transcription('whisper-small', { language: 'ja' }), file: longRecording() })

    whisperAdapter.transcribe
      .mockResolvedValueOnce(' The weather is nice today.')
      .mockResolvedValueOnce(' I am going to the park.')
    const english = await generateTranscription({ ...provider.transcription('whisper-small', { language: 'en' }), file: longRecording() })

    expect(japanese.text).toBe('今日はいい天気です。公園に行きます。')
    expect(english.text).toBe('The weather is nice today. I am going to the park.')
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

  it('lists every Whisper model for the Hearing model picker, with Whisper Small as the default', async () => {
    const definition = getWhisperLocalDefinition()
    const catalog = await definition.extraMethods?.listModelCatalog?.({}, await definition.createProvider({}), { t: key => `translated:${key}` })

    expect(catalog?.models.map(model => model.id)).toEqual(WHISPER_MODELS.map(model => model.id))
    expect(catalog?.models[0]?.provider).toBe(WHISPER_LOCAL_PROVIDER_ID)
    expect(catalog?.models[0]?.description).toBe(`translated:${WHISPER_MODELS[0].descriptionKey}`)
    expect(catalog?.defaultModel).toBe('whisper-small')
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
