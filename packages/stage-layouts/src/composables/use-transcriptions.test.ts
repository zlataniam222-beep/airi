import type { Ref } from 'vue'

import { mount } from '@vue/test-utils'
import { until } from '@vueuse/core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import { useTranscriptions } from './use-transcriptions'

function createMockStore() {
  return {
    activeTranscriptionProvider: undefined,
    configured: ref(false),
    autoSendEnabled: ref(true),
    autoSendDelay: ref(2000),
    initializeProvider: vi.fn(),
  }
}

const mockTranscribedContent = 'test content'
interface MockStreamingCallbacks {
  onSentenceEnd: (delta: string) => void
  onSpeechEnd?: (text: string) => void
  onTranscriptionUpdate?: (text: string) => void
}

function createMockPipeline() {
  return {
    removeStreamingTranscriptionConsumer: vi.fn(),
    transcribeForMediaStream: vi.fn().mockImplementation((_stream, options: MockStreamingCallbacks) => {
      options.onSentenceEnd(mockTranscribedContent)
    }),
    transcribeForRecording: vi.fn<(recording: Blob | null | undefined) => Promise<string | undefined>>()
      .mockResolvedValue(mockTranscribedContent),
    stopStreamingTranscription: vi.fn().mockResolvedValue(undefined),
    supportsStreamInput: ref(true),
  }
}

/**
 * Platform boundaries of the recorder-backed dictation session.
 *
 * `useVoiceInputSession` runs for real; only the VAD model worker and the mediabunny recorder are replaced.
 * Tests drive speech through the captured VAD callbacks, the same way the VAD worklet does in the browser.
 */
const voiceInputBoundary = await vi.hoisted(async () => {
  const vue = await import('vue')

  return {
    vad: {
      callbacks: undefined as { onSpeechStart?: () => void, onSpeechEnd?: () => void } | undefined,
      init: vi.fn<() => Promise<void>>(),
      start: vi.fn<(stream: MediaStream) => Promise<void>>(),
      dispose: vi.fn<() => void>(),
    },
    recorder: {
      isRecording: vue.ref(false),
      startRecord: vi.fn<() => Promise<void>>(),
      stopRecord: vi.fn<() => Promise<void>>(),
      onStopRecordHook: undefined as ((recording: Blob | undefined) => Promise<void>) | undefined,
    },
  }
})

vi.mock('@proj-airi/stage-ui/stores/ai/models/vad', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')

  return {
    useVAD: (_workletUrl: string, options: typeof voiceInputBoundary.vad.callbacks) => {
      voiceInputBoundary.vad.callbacks = options
      return {
        init: voiceInputBoundary.vad.init,
        start: voiceInputBoundary.vad.start,
        dispose: voiceInputBoundary.vad.dispose,
        loaded: vue.ref(true),
        loading: vue.ref(false),
        isSpeech: vue.ref(false),
        isSpeechProb: vue.ref(0),
        isSpeechHistory: vue.ref([]),
        inferenceError: vue.ref(),
        minSilenceDurationMs: vue.ref(1200),
      }
    },
  }
})

vi.mock('@proj-airi/stage-ui/composables/audio/audio-recorder', () => {
  return {
    useAudioRecorder: () => ({
      isRecording: voiceInputBoundary.recorder.isRecording,
      startRecord: voiceInputBoundary.recorder.startRecord,
      stopRecord: voiceInputBoundary.recorder.stopRecord,
      onStopRecord: (hook: (recording: Blob | undefined) => Promise<void>) => {
        voiceInputBoundary.recorder.onStopRecordHook = hook
        return () => {}
      },
    }),
  }
})

function resetVoiceInputBoundary() {
  const { recorder, vad } = voiceInputBoundary
  vad.callbacks = undefined
  vad.init.mockResolvedValue(undefined)
  vad.start.mockResolvedValue(undefined)
  recorder.isRecording.value = false
  recorder.onStopRecordHook = undefined
  recorder.startRecord.mockImplementation(async () => {
    recorder.isRecording.value = true
  })
  // Mirrors useAudioRecorder: the recorder becomes idle first, then stop hooks receive the finalized WAV blob.
  recorder.stopRecord.mockImplementation(async () => {
    recorder.isRecording.value = false
    await recorder.onStopRecordHook?.(new Blob(['segment-audio'], { type: 'audio/wav' }))
  })
}

/** Plays one VAD-detected utterance: speech start opens a recorder segment and speech end finalizes it. */
async function speakSegment() {
  voiceInputBoundary.vad.callbacks?.onSpeechStart?.()
  await vi.waitFor(() => expect(voiceInputBoundary.recorder.isRecording.value).toBe(true))
  voiceInputBoundary.vad.callbacks?.onSpeechEnd?.()
}

function createMockAudioDevice() {
  const instance = {
    enabled: ref(false),
    stream: ref(null),
    askPermission: vi.fn().mockResolvedValue(undefined),
    startStream: vi.fn(),
  }
  return instance
}

let mockHearingStore: ReturnType<typeof createMockStore>
let mockHearingPipeline: ReturnType<typeof createMockPipeline>
let mockAudioDevice: ReturnType<typeof createMockAudioDevice>
let mockProvidersStore: ReturnType<typeof createMockStore>

// Mock the modules
vi.mock('@proj-airi/stage-ui/stores/modules/hearing', () => ({
  useHearingStore: vi.fn().mockImplementation(() => mockHearingStore),
  useHearingSpeechInputPipeline: vi.fn().mockImplementation(() => mockHearingPipeline),
}))

vi.mock('@proj-airi/stage-ui/stores/providers/provider', () => ({
  useProviderStore: vi.fn().mockImplementation(() => mockProvidersStore),
}))

vi.mock('@proj-airi/stage-ui/stores/settings', () => ({
  useSettingsAudioDevice: vi.fn().mockImplementation(() => mockAudioDevice),
}))

vi.mock('pinia', () => ({
  storeToRefs: vi.fn().mockImplementation((val: any) => val),
}))

vi.mock('@vueuse/core', () => ({
  until: vi.fn(),
}))

// Global setup for jsdom environment
beforeAll(() => {
  // Ensure window is available
  if (typeof window === 'undefined') {
    ;(globalThis as any).window = {
      webkitSpeechRecognition: undefined,
      SpeechRecognition: undefined,
    }
  }
})

afterAll(() => {
  vi.clearAllMocks()
})

describe('useTranscriptions', () => {
  // Setup mutable instances before each test
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers() // Use fake timers for auto-send tests
    mockHearingStore = createMockStore()
    mockHearingPipeline = createMockPipeline()
    mockAudioDevice = createMockAudioDevice()
    mockProvidersStore = createMockStore()
    resetVoiceInputBoundary()

    // Mock 'until' to resolve immediately for stream checks
    ;(until as any).mockImplementation((_source: Ref) => ({
      toBeTruthy: vi.fn().mockResolvedValue(undefined),
    }))

    // Mock SpeechRecognition for browser tests
    if (typeof window !== 'undefined') {
      (window as any).SpeechRecognition = function () {
        this.start = vi.fn()
        this.stop = vi.fn()
        this.onresult = null
      }
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  const createOptions = (isTamagotchi = false) => ({
    messageInputRef: ref(''),
    sendMessage: vi.fn(),
    isStageTamagotchi: ref(isTamagotchi),
  })

  describe('initialization', () => {
    it('should initialize with isListening false', () => {
      const { isListening } = useTranscriptions(createOptions())

      expect(isListening.value).toBe(false)
    })

    it('should expose startListening and stopListening', () => {
      const { startStreamingTranscription, stopStreamingTranscription } = useTranscriptions(createOptions())

      expect(startStreamingTranscription).toBeInstanceOf(Function)
      expect(stopStreamingTranscription).toBeInstanceOf(Function)
    })
  })

  describe('auto-Configuration (Web Speech API)', () => {
    it('should auto-configure Web Speech API if no provider is set', async () => {
      mockHearingStore.configured.value = false
      mockAudioDevice.enabled.value = true

      const { startStreamingTranscription }
        = useTranscriptions(createOptions())
      await startStreamingTranscription()

      expect(mockProvidersStore.initializeProvider).toHaveBeenCalledWith('browser-web-speech-api')
      expect(mockHearingStore.activeTranscriptionProvider).toBe('browser-web-speech-api')
    })

    it('should fail gracefully if Web Speech API is not available', async () => {
      // Setup: Tamagotchi mode or no API
      if (typeof window !== 'undefined') {
        delete (window as any).SpeechRecognition
        delete (window as any).webkitSpeechRecognition
      }

      mockHearingStore.configured.value = false
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true

      const { isListening, startStreamingTranscription }
        = useTranscriptions(createOptions())
      await startStreamingTranscription()

      expect(isListening.value).toBe(false)
      expect(mockHearingPipeline.transcribeForMediaStream).not.toHaveBeenCalled()
    })

    it('should handle tamagotchi', async () => {
      mockHearingStore.configured.value = false
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true

      const { isListening, stopStreamingTranscription }
        = useTranscriptions(createOptions(true))
      await stopStreamingTranscription()
      expect(isListening.value).toBe(false)
    })
  })

  describe('streaming Logic', () => {
    it('should start streaming if stream exists and provider supports it', async () => {
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true

      const { isListening, startStreamingTranscription } = useTranscriptions(createOptions())

      await startStreamingTranscription()

      await nextTick()
      expect(isListening.value).toBe(true)
      expect(mockHearingPipeline.transcribeForMediaStream).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'stream-1' }),
        expect.any(Object),
      )
    })

    it('should request permission if stream is missing', async () => {
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = null
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true

      const { startStreamingTranscription } = useTranscriptions(createOptions())

      await startStreamingTranscription()
      await nextTick()

      expect(mockAudioDevice.askPermission).toHaveBeenCalled()
      expect(mockAudioDevice.startStream).toHaveBeenCalled()
    })

    it('should stop streaming if stream is missing after permission', async () => {
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = null
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true;

      // simulate failure (stream never appears)
      (until as any).mockImplementation(() => ({
        toBeTruthy: vi.fn().mockRejectedValue(new Error('Timeout')),
      }))

      const { isListening, startStreamingTranscription } = useTranscriptions(createOptions())

      await startStreamingTranscription()
      await nextTick()

      expect(isListening.value).toBe(false)
    })
  })

  describe('transcription & Input', () => {
    it('should append transcribed text to messageInputRef', async () => {
      const mockInput = ref('')
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true

      const { startStreamingTranscription }
        = useTranscriptions({ ...createOptions(), messageInputRef: mockInput })

      await startStreamingTranscription()
      await nextTick()

      expect(mockInput.value).toBe(mockTranscribedContent)
    })

    it('should append transcribed text with a space when input contains value', async () => {
      const prependText = 'prepend text'
      const mockInput = ref(prependText)
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true

      const { startStreamingTranscription }
        = useTranscriptions({ ...createOptions(), messageInputRef: mockInput })

      await startStreamingTranscription()
      await nextTick()

      expect(mockInput.value).toBe(`${prependText} ${mockTranscribedContent}`)
    })

    it('replaces volatile snapshots when the provider corrects text', async () => {
      // ROOT CAUSE:
      //
      // The input consumer only accepted final deltas. It had no operation for
      // replacing a provider-owned draft when the provider corrected that text.
      const mockInput = ref('prefix')
      const observedInputs: string[] = []
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true
      mockHearingPipeline.transcribeForMediaStream.mockImplementation((_stream, options: MockStreamingCallbacks) => {
        options.onTranscriptionUpdate?.('今天天气很号')
        observedInputs.push(mockInput.value)
        options.onTranscriptionUpdate?.('今天天气很好')
        observedInputs.push(mockInput.value)
        options.onSentenceEnd('今天天气很好')
      })

      const { startStreamingTranscription }
        = useTranscriptions({ ...createOptions(), messageInputRef: mockInput })

      await startStreamingTranscription()

      expect(observedInputs).toEqual(['prefix 今天天气很号', 'prefix 今天天气很好'])
      expect(mockInput.value).toBe('prefix 今天天气很好')
    })

    it('preserves manual input changes during a volatile transcription', async () => {
      const mockInput = ref('prefix')
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true
      mockHearingPipeline.transcribeForMediaStream.mockImplementation((_stream, options: MockStreamingCallbacks) => {
        options.onTranscriptionUpdate?.('provider draft')
        mockInput.value = 'manual edit'
        options.onTranscriptionUpdate?.('provider correction')
        options.onSentenceEnd('provider final')
      })

      const { startStreamingTranscription }
        = useTranscriptions({ ...createOptions(), messageInputRef: mockInput })

      await startStreamingTranscription()

      expect(mockInput.value).toBe('manual edit')
    })

    it('should trigger auto-send after delay', async () => {
      const mockInput = ref('')
      const mockSendMessage = vi.fn()

      mockHearingStore.autoSendDelay.value = 500
      mockHearingStore.configured.value = true
      mockHearingStore.autoSendEnabled.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true

      const { startStreamingTranscription }
        = useTranscriptions({ ...createOptions(), messageInputRef: mockInput, sendMessage: mockSendMessage })

      await startStreamingTranscription()
      await nextTick()

      expect(mockSendMessage).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1000)

      expect(mockSendMessage).toHaveBeenCalled()
    })

    it('should clear pending auto-send if disabled', async () => {
      const mockInput = ref('')
      const mockSendMessage = vi.fn()

      mockHearingStore.autoSendDelay.value = 500
      mockHearingStore.configured.value = true
      mockHearingStore.autoSendEnabled.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true

      const { startStreamingTranscription }
        = useTranscriptions({ ...createOptions(), messageInputRef: mockInput, sendMessage: mockSendMessage })

      await startStreamingTranscription()
      await nextTick()

      // Disable auto-send before timeout
      mockHearingStore.autoSendEnabled.value = false

      vi.advanceTimersByTime(1000)

      expect(mockSendMessage).not.toHaveBeenCalled()
    })
  })

  describe('cleanup', () => {
    it('should stop streaming and clear timeout', async () => {
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true

      const { isListening, startStreamingTranscription, stopStreamingTranscription } = useTranscriptions(createOptions())

      await startStreamingTranscription()
      await nextTick()
      expect(isListening.value).toBe(true)

      await stopStreamingTranscription()
      await nextTick()
      expect(isListening.value).toBe(false)
      expect(mockHearingPipeline.stopStreamingTranscription).toHaveBeenCalledWith(true)
      expect(mockHearingPipeline.removeStreamingTranscriptionConsumer).toHaveBeenCalledOnce()
    })

    it('should stop streaming on unmount', async () => {
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true

      const app = mount({
        setup() {
          const { startStreamingTranscription } = useTranscriptions(createOptions())
          startStreamingTranscription()
        },
        template: '<div></div>',
      })
      await nextTick()
      expect(mockHearingPipeline.transcribeForMediaStream).toHaveBeenCalled()

      app.unmount()
      await nextTick()
      expect(mockHearingPipeline.stopStreamingTranscription).toHaveBeenCalled()
      expect(mockHearingPipeline.removeStreamingTranscriptionConsumer).toHaveBeenCalled()
    })
  })

  describe('recorder-backed dictation (non-streaming providers)', () => {
    function prepareRecorderBackedProvider() {
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = false
    }

    it('transcribes each spoken segment into the input and auto-sends it', async () => {
      // ROOT CAUSE:
      //
      // Whisper (Local), the Hearing default, cannot stream input, so startStreaming() returned early.
      //
      // if (!supportsStreamInput.value) { ...; isListening.value = false; return }
      //
      // We fixed this with useVoiceInputSession: each transcribed segment goes to the streaming final-text handler.
      prepareRecorderBackedProvider()
      mockHearingStore.autoSendDelay.value = 500
      const mockInput = ref('prefix')
      const mockSendMessage = vi.fn()

      const { isListening, startStreamingTranscription }
        = useTranscriptions({ ...createOptions(), messageInputRef: mockInput, sendMessage: mockSendMessage })
      await startStreamingTranscription()

      expect(isListening.value).toBe(true)
      expect(voiceInputBoundary.vad.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'stream-1' }))
      expect(mockHearingPipeline.transcribeForMediaStream).not.toHaveBeenCalled()

      await speakSegment()
      await vi.waitFor(() => expect(mockInput.value).toBe(`prefix ${mockTranscribedContent}`))

      expect(mockHearingPipeline.transcribeForRecording).toHaveBeenCalledOnce()
      expect(mockHearingPipeline.transcribeForRecording).toHaveBeenCalledWith(expect.any(Blob))
      expect(mockSendMessage).not.toHaveBeenCalled()

      vi.advanceTimersByTime(500)

      expect(mockSendMessage).toHaveBeenCalledOnce()
    })

    it('stops the recorder and drops the segment that is being recorded', async () => {
      prepareRecorderBackedProvider()
      const mockInput = ref('')

      const { isListening, startStreamingTranscription, stopStreamingTranscription }
        = useTranscriptions({ ...createOptions(), messageInputRef: mockInput })
      await startStreamingTranscription()

      voiceInputBoundary.vad.callbacks?.onSpeechStart?.()
      await vi.waitFor(() => expect(voiceInputBoundary.recorder.isRecording.value).toBe(true))

      await stopStreamingTranscription()

      expect(isListening.value).toBe(false)
      expect(voiceInputBoundary.recorder.stopRecord).toHaveBeenCalledOnce()
      expect(voiceInputBoundary.recorder.isRecording.value).toBe(false)
      expect(voiceInputBoundary.vad.dispose).toHaveBeenCalled()
      expect(mockHearingPipeline.transcribeForRecording).not.toHaveBeenCalled()
      expect(mockHearingPipeline.stopStreamingTranscription).not.toHaveBeenCalled()
      expect(mockInput.value).toBe('')
    })

    it('drops a segment whose transcription finishes after stop', async () => {
      prepareRecorderBackedProvider()
      const mockInput = ref('')
      const mockSendMessage = vi.fn()
      let finishTranscription: (text: string) => void = () => {}
      mockHearingPipeline.transcribeForRecording.mockImplementation(() => new Promise((resolve) => {
        finishTranscription = resolve
      }))

      const { startStreamingTranscription, stopStreamingTranscription }
        = useTranscriptions({ ...createOptions(), messageInputRef: mockInput, sendMessage: mockSendMessage })
      await startStreamingTranscription()
      await speakSegment()
      await vi.waitFor(() => expect(mockHearingPipeline.transcribeForRecording).toHaveBeenCalledOnce())

      await stopStreamingTranscription()
      finishTranscription(mockTranscribedContent)
      await vi.waitFor(() => expect(voiceInputBoundary.vad.dispose).toHaveBeenCalled())
      vi.advanceTimersByTime(5000)

      expect(mockInput.value).toBe('')
      expect(mockSendMessage).not.toHaveBeenCalled()
    })

    it('drops a segment whose recorder finishes finalizing after stop', async () => {
      // The session resets its transcription queue on stop, but this segment is queued after that reset,
      // so only the dictation delivery gate can drop it.
      prepareRecorderBackedProvider()
      const mockInput = ref('')
      const { recorder } = voiceInputBoundary
      let finishFinalize: () => void = () => {}
      recorder.stopRecord.mockImplementation(async () => {
        recorder.isRecording.value = false
        await new Promise<void>((resolve) => {
          finishFinalize = resolve
        })
        await recorder.onStopRecordHook?.(new Blob(['segment-audio'], { type: 'audio/wav' }))
      })

      const { startStreamingTranscription, stopStreamingTranscription }
        = useTranscriptions({ ...createOptions(), messageInputRef: mockInput })
      await startStreamingTranscription()
      await speakSegment()
      await vi.waitFor(() => expect(recorder.stopRecord).toHaveBeenCalledOnce())

      await stopStreamingTranscription()
      finishFinalize()
      vi.advanceTimersByTime(5000)
      // stopRecord resolves after its stop hook has queued and processed the late segment.
      await vi.waitFor(() => expect(recorder.stopRecord).toHaveResolved())

      expect(mockHearingPipeline.transcribeForRecording).not.toHaveBeenCalled()
      expect(mockInput.value).toBe('')
    })

    it('tears down a VAD start that finishes loading after stop', async () => {
      prepareRecorderBackedProvider()
      let finishVadLoad: () => void = () => {}
      voiceInputBoundary.vad.init.mockImplementation(() => new Promise((resolve) => {
        finishVadLoad = resolve
      }))

      const { isListening, startStreamingTranscription, stopStreamingTranscription } = useTranscriptions(createOptions())
      const starting = startStreamingTranscription()
      await vi.waitFor(() => expect(voiceInputBoundary.vad.init).toHaveBeenCalledOnce())

      expect(isListening.value).toBe(true)

      const stopping = stopStreamingTranscription()
      finishVadLoad()
      await Promise.all([starting, stopping])

      expect(isListening.value).toBe(false)
      expect(voiceInputBoundary.vad.start).toHaveBeenCalledOnce()
      expect(voiceInputBoundary.vad.dispose).toHaveBeenCalledOnce()
      expect(voiceInputBoundary.vad.dispose.mock.invocationCallOrder[0])
        .toBeGreaterThan(voiceInputBoundary.vad.start.mock.invocationCallOrder[0])
    })
  })

  describe('reactive watchers', () => {
    it('should stop listening if microphone is disabled', async () => {
      mockHearingStore.configured.value = true
      mockAudioDevice.stream.value = { id: 'stream-1' } as any
      mockAudioDevice.enabled.value = true
      mockHearingPipeline.supportsStreamInput.value = true

      const { isListening, startStreamingTranscription } = useTranscriptions(createOptions())

      await startStreamingTranscription()

      await nextTick()
      expect(isListening.value).toBe(true)

      mockAudioDevice.enabled.value = false

      await nextTick()
      expect(isListening.value).toBe(false)
    })
  })
})
