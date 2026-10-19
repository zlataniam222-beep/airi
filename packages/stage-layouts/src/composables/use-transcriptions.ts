import type { VoiceInputSessionGate, VoiceInputSessionLogLevel } from '@proj-airi/stage-ui/composables/audio/voice-input-session'
import type { MaybeRefOrGetter, Ref } from 'vue'

import { useVoiceInputSession } from '@proj-airi/stage-ui/composables/audio/voice-input-session'
import { useStreamingTranscriptionInput } from '@proj-airi/stage-ui/composables/use-streaming-transcription-input'
import { useHearingSpeechInputPipeline, useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { useSettingsAudioDevice } from '@proj-airi/stage-ui/stores/settings'
import { until } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { nextTick, onScopeDispose, ref, toValue, useId, watch } from 'vue'

interface TranscriptionOptions {
  messageInputRef: Ref<string>
  sendMessage: () => void
  isStageTamagotchi: MaybeRefOrGetter<boolean>
}

/**
 * Transport that delivers dictation text while listening.
 *
 * - `streaming`: the shared Hearing streaming session sends text to this consumer by its consumer id.
 * - `recording`: a local voice-input session records each spoken segment and transcribes it with
 *   `transcribeForRecording`. Used when the Hearing provider cannot stream input, such as Whisper (Local).
 */
type DictationTransport = 'streaming' | 'recording'

/** Forwards voice-input session diagnostics to the console with this composable as the source. */
function logVoiceInputSession(level: VoiceInputSessionLogLevel, event: string, message: string, details?: Record<string, unknown>) {
  const output = `[Dictation] ${event}: ${message}`
  if (level === 'error') {
    console.error(output, details ?? {}, { source: 'useTranscriptions' })
    return
  }
  if (level === 'warn') {
    console.warn(output, details ?? {}, { source: 'useTranscriptions' })
    return
  }

  // NOTICE: The volume fallback reports a microphone level sample every two seconds while dictation runs.
  // That sample only helps when tuning thresholds, so it is not forwarded; every other event is.
  if (event === 'volume-fallback-level')
    return

  console.info(output, details ?? {}, { source: 'useTranscriptions' })
}

/**
 * Chat-input dictation for the chat area microphone button.
 *
 * Start chooses one {@link DictationTransport} from the Hearing provider's `supportsStreamInput` and keeps it
 * until stop. Both transports write into `messageInputRef` through the same handlers, so callers do not branch
 * on the provider.
 *
 * Stop ends the active transport and clears a pending auto-send. On the recording transport, stop drops the
 * segment that is being recorded and every segment that is still waiting for or running transcription: no text
 * from those segments reaches the input. The microphone stream belongs to the audio device settings store and
 * stays open.
 */
export function useTranscriptions(options: TranscriptionOptions) {
  const { messageInputRef: messageInput, sendMessage, isStageTamagotchi } = options

  const hearingStore = useHearingStore()
  const audioDeviceSettingsStore = useSettingsAudioDevice()
  const hearingPipeline = useHearingSpeechInputPipeline()
  const { removeStreamingTranscriptionConsumer, transcribeForMediaStream, stopStreamingTranscription } = hearingPipeline
  const { supportsStreamInput } = storeToRefs(hearingPipeline)
  const { configured: hearingConfigured, autoSendEnabled, autoSendDelay } = storeToRefs(hearingStore)
  const { enabled: hearingEnabled, stream } = storeToRefs(audioDeviceSettingsStore)
  const providersStore = useProviderStore()
  const { askPermission, startStream } = audioDeviceSettingsStore

  const isListening = ref(false)
  const transcriptionConsumerId = `interactive-area:${useId()}`
  const streamingInput = useStreamingTranscriptionInput(messageInput)

  /**
   * Transport that owns the current listening session; `undefined` when not listening.
   * Set when a transport starts and cleared at the start of stop, before any await, so recorder results that
   * settle during or after stop see that dictation ended.
   */
  let activeTransport: DictationTransport | undefined

  /**
   * Tail of recorder-session start and stop work.
   *
   * Starting loads the VAD model, which can take seconds. `useVAD` does not cancel a load that is in progress,
   * so a stop that ran during the load would leave the VAD worklet running after it finishes. Each start and
   * stop waits for the previous one; the last requested operation decides the final state.
   */
  let recordingLifecycle: Promise<void> = Promise.resolve()

  function queueRecordingLifecycle(operation: () => Promise<void>) {
    const run = recordingLifecycle.then(operation)
    // A failed operation must not block later starts or stops; the caller of that operation gets the error.
    recordingLifecycle = run.catch(() => {})
    return run
  }

  /**
   * Skips recorder segments that settle after dictation stopped.
   *
   * `voiceInputSession.stop()` invalidates queued and running transcription work. A segment whose recorder was
   * still finalizing when stop ran is queued after that reset, so it looks current to the session. Checking the
   * transport before and after the provider call drops that segment too.
   */
  function inspectRecordingDelivery(): VoiceInputSessionGate | undefined {
    if (activeTransport === 'recording')
      return undefined

    return { skip: true, reason: 'dictation-stopped' }
  }

  /**
   * Final transcript text from either transport. Both transports send final text here, so manual-edit
   * detection and auto-send behave the same for streaming and recorder-backed providers.
   */
  function handleSentenceEnd(delta: string) {
    if (streamingInput.commit(delta)) {
      console.info('Received final transcription:', delta, { source: 'useTranscriptions' })
      debouncedAutoSend()
    }
  }

  /**
   * Recorder-backed transport for providers that cannot stream input.
   * VAD segments each utterance; each segment becomes one `transcribeForRecording` call and one final text.
   */
  const voiceInputSession = useVoiceInputSession(stream, {
    onLog: logVoiceInputSession,
    inspectBeforeTranscription: inspectRecordingDelivery,
    inspectAfterTranscription: inspectRecordingDelivery,
    onTranscriptionResult: ({ text }) => handleSentenceEnd(text),
  })

  // Auto-send logic
  let autoSendTimeout: ReturnType<typeof setTimeout> | undefined
  function clearPendingAutoSend() {
    if (autoSendTimeout) {
      clearTimeout(autoSendTimeout)
      autoSendTimeout = undefined
    }
  }
  async function debouncedAutoSend() {
    // Double-check auto-send is enabled before proceeding
    if (!autoSendEnabled.value) {
      clearPendingAutoSend()
      return
    }
    if (autoSendTimeout) {
      clearTimeout(autoSendTimeout)
    }

    autoSendTimeout = setTimeout(async () => {
      // Final check before sending - auto-send might have been disabled while waiting
      if (!autoSendEnabled.value) {
        clearPendingAutoSend()
        return
      }
      sendMessage()
      autoSendTimeout = undefined
    }, autoSendDelay.value)
  }

  const stopStreaming = async () => {
    removeStreamingTranscriptionConsumer(transcriptionConsumerId)
    streamingInput.clear()

    if (!isListening.value)
      return

    const transport = activeTransport
    activeTransport = undefined
    clearPendingAutoSend()

    if (transport === 'recording') {
      await stopRecording()
      return
    }

    try {
      console.info('Stopping transcription...', { source: 'useTranscriptions' })
      await stopStreamingTranscription(true)
      isListening.value = false
      console.info('Transcription stopped', { source: 'useTranscriptions' })
    }
    catch (err) {
      console.error('Error stopping transcription:', err, { source: 'useTranscriptions' })
      isListening.value = false
    }
  }

  /**
   * Stops recorder-backed dictation. Drops the active recording and invalidates queued or running
   * transcriptions (see `useTranscriptions`). The shared streaming session is left alone because other
   * consumers may still use it.
   */
  async function stopRecording() {
    // Listening ends before teardown, so a button press during teardown starts a new session that the
    // lifecycle queue runs after this stop, instead of a second stop.
    isListening.value = false
    console.info('Stopping recorder-backed transcription...', { source: 'useTranscriptions' })

    try {
      await queueRecordingLifecycle(() => voiceInputSession.stop({ flushActiveRecording: false }))
      console.info('Recorder-backed transcription stopped', { source: 'useTranscriptions' })
    }
    catch (err) {
      console.error('Error stopping recorder-backed transcription:', err, { source: 'useTranscriptions' })
    }
  }

  /**
   * Starts recorder-backed dictation on the current microphone stream.
   * Listening state is set before the VAD model loads so a second button press during the load stops dictation.
   */
  async function startRecording() {
    if (activeTransport === 'recording')
      return

    activeTransport = 'recording'
    isListening.value = true

    try {
      await queueRecordingLifecycle(() => voiceInputSession.startAutoSegmentation())
      console.info('Recorder-backed transcription initiated successfully', { source: 'useTranscriptions' })
    }
    catch (err) {
      console.error('Failed to start recorder-backed transcription:', err, { source: 'useTranscriptions' })
      // Runs the normal stop so listening state resets and no partly started recorder work stays alive.
      await stopStreaming()
      throw err
    }
  }

  const startStreaming = async () => {
    console.info('Starting streaming transcription', {
      enabled: hearingEnabled.value,
      hasStream: !!stream.value,
      supportsStreamInput: supportsStreamInput.value,
      hearingConfigured: hearingConfigured.value,
    }, { source: 'useTranscriptions' })

    // Auto-configure Web Speech API as default if no provider is configured
    if (!hearingConfigured.value) {
      console.info('No transcription provider configured. Auto-configuring Web Speech API as default', { source: 'useTranscriptions' })
      // Check if Web Speech API is available in the browser
      // Web Speech API is NOT available in Electron (stage-tamagotchi) - it requires Google's embedded API keys
      // which are not available in Electron, causing it to fail at runtime
      const isWebSpeechAvailable = typeof window !== 'undefined'
        && !toValue(isStageTamagotchi) // Explicitly exclude Electron
        && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)

      if (!isWebSpeechAvailable) {
        // TODO: also propagate to user
        const errorMsg = 'Web Speech API is not available and no transcription provider is configured. Please go to Settings > Modules > Hearing to configure a transcription provider. '
        console.error(errorMsg, 'Browser support:', {
          hasWindow: typeof window !== 'undefined',
          hasWebkitSpeechRecognition: typeof window !== 'undefined' && 'webkitSpeechRecognition' in window,
          hasSpeechRecognition: typeof window !== 'undefined' && 'SpeechRecognition' in window,
        }, { source: 'useTranscriptions' })
        isListening.value = false
        return
      }

      // Initialize the provider in the providers store first
      try {
        await providersStore.initializeProvider('browser-web-speech-api')
        hearingStore.activeTranscriptionProvider = 'browser-web-speech-api'
      }
      catch (err) {
        console.warn('Error initializing Web Speech API provider:', err, { source: 'useTranscriptions' })
      }
      // Wait for reactivity to update
      await nextTick()

      // Verify the provider was set to Web Speech API
      if (hearingStore.activeTranscriptionProvider !== 'browser-web-speech-api') {
        console.error('Failed to set Web Speech API as default provider', { source: 'useTranscriptions' })
        isListening.value = false
        return
      }
      console.info('Web Speech API configured as default provider', { source: 'useTranscriptions' })
    }

    try {
      // Request microphone permission if needed (microphone should already be enabled by the user)
      if (!stream.value) {
        console.info('Requesting microphone permission', { source: 'useTranscriptions' })
        await askPermission()

        // If still no stream, try starting it manually
        if (!stream.value && hearingEnabled.value) {
          console.info('Attempting to start stream manually', { source: 'useTranscriptions' })
          startStream()
          // Wait for the stream to become available with a timeout.
          try {
            await until(stream).toBeTruthy({ timeout: 3000, throwOnTimeout: true })
          }
          catch {
            console.error('Timed out waiting for audio stream. Stopping transcription.', { source: 'useTranscriptions' })
            isListening.value = false
            return
          }
        }
      }
    }
    catch (err) {
      console.error('Failed to request microphone permission:', err, { source: 'useTranscriptions' })
      isListening.value = false
    }

    if (!stream.value) {
      const errorMsg = 'Failed to get audio stream for transcription. Please check microphone permissions and ensure a device is selected.'
      console.error(errorMsg, { source: 'useTranscriptions' })
      isListening.value = false
      return
    }

    if (!supportsStreamInput.value) {
      console.info('Starting recorder-backed transcription with stream:', stream.value.id, { source: 'useTranscriptions' })
      await startRecording()
      return
    }

    console.info('Starting streaming transcription with stream:', stream.value.id, { source: 'useTranscriptions' })

    // Allow calling this even if already listening - transcribeForMediaStream will handle session reuse/restart
    // Call transcribeForMediaStream - it's async so we await it
    // Set listening state AFTER successful call
    try {
      await transcribeForMediaStream(stream.value, {
        consumerId: transcriptionConsumerId,
        onSentenceEnd: handleSentenceEnd,
        onSpeechEnd: streamingInput.clear,
        onTranscriptionUpdate: streamingInput.replace,
      })

      // Only set listening to true if transcription started successfully
      // (transcribeForMediaStream might return early if session already exists)
      activeTransport = 'streaming'
      isListening.value = true
      console.info('Streaming transcription initiated successfully', { source: 'useTranscriptions' })
    }
    catch (err) {
      streamingInput.clear()
      console.error('Transcription error:', err, { source: 'useTranscriptions' })
      isListening.value = false
      throw err
    }
  }

  // Watch for auto-send setting changes and clear pending sends if disabled
  watch(autoSendEnabled, (enabled) => {
    if (!enabled) {
      clearPendingAutoSend()
      console.info('Auto-send disabled', { source: 'useTranscriptions' })
    }
  })

  // Watch for auto-send setting changes and clear pending sends if disabled
  watch(hearingEnabled, async (enabled) => {
    if (!enabled) {
      await stopStreaming()
      console.info('Stopping streaming transcription because hearing is disabled.', { source: 'useTranscriptions' })
    }
  })

  onScopeDispose(() => {
    clearPendingAutoSend()
    stopStreaming()
  })

  return {
    startStreamingTranscription: startStreaming,
    stopStreamingTranscription: stopStreaming,
    isListening,
    autoSendEnabled,
  }
}
