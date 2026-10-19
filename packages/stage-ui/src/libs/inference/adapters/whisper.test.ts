import type { removeInferenceStatus, updateInferenceStatus } from '../../../composables/use-inference-status'
import type { AllocationToken } from '../gpu-resource-coordinator'
import type { LoadModelRequest, WorkerInboundMessage, WorkerOutboundMessage } from '../protocol'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getWhisperModel, MAX_RESTARTS, RESTART_DELAY_MS, TIMEOUTS } from '../constants'

type MockWorkerEvent = { data: WorkerOutboundMessage } | { error: Error }

class MockWorker {
  static instances: MockWorker[] = []

  listeners = new Map<string, Set<(event: MockWorkerEvent) => void>>()
  addEventListener = vi.fn((type: string, listener: (event: MockWorkerEvent) => void) => {
    if (!this.listeners.has(type))
      this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  })

  removeEventListener = vi.fn((type: string, listener: (event: MockWorkerEvent) => void) => {
    this.listeners.get(type)?.delete(listener)
  })

  postMessage = vi.fn<(message: WorkerInboundMessage) => void>()
  terminate = vi.fn()

  constructor() {
    MockWorker.instances.push(this)
  }

  dispatch(type: string, event: MockWorkerEvent): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event)
  }
}

vi.stubGlobal('Worker', MockWorker)

const inferenceStatus = vi.hoisted(() => ({
  removeInferenceStatus: vi.fn<typeof removeInferenceStatus>(),
  updateInferenceStatus: vi.fn<typeof updateInferenceStatus>(),
}))

vi.mock('../../../composables/use-inference-status', () => inferenceStatus)

const enqueueMock = vi.fn((_id: string, _p: number, loader: () => Promise<unknown>) => loader())
const recordDeviceLoss = vi.fn()
const release = vi.fn<(token: AllocationToken) => void>()
const requestAllocation = vi.fn((modelId: string, bytes: number): AllocationToken => ({ allocatedAt: 0, bytes, lastUsedAt: 0, modelId }))

vi.mock('../coordinator', () => ({
  getGPUCoordinator: () => ({
    recordDeviceLoss,
    release,
    requestAllocation,
    touch: vi.fn(),
  }),
  getLoadQueue: () => ({
    enqueue: enqueueMock,
  }),
  MODEL_VRAM_ESTIMATES: {},
}))

vi.mock('@proj-airi/stage-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@proj-airi/stage-shared')>()

  return {
    ...actual,
    defaultPerfTracer: {
      withMeasure: vi.fn((_category: string, _name: string, fn: () => unknown) => fn()),
    },
  }
})

function loadRequestsOf(worker: MockWorker): LoadModelRequest[] {
  return worker.postMessage.mock.calls.flatMap(([message]) => message.type === 'load-model' ? [message] : [])
}

function answerLoad(worker: MockWorker, request: LoadModelRequest): void {
  worker.dispatch('message', {
    data: {
      device: 'webgpu',
      modelId: request.modelId,
      requestId: request.requestId,
      type: 'model-ready',
    },
  })
}

/** Download percentages written to the inference status entry of `modelId`, in the order they were written. */
function reportedDownloadPercents(modelId: string): number[] {
  return inferenceStatus.updateInferenceStatus.mock.calls.flatMap(([id, update]) =>
    id === modelId && update.progress?.phase === 'download' ? [update.progress.percent] : [])
}

async function createLoadedAdapter(modelId: 'whisper-base' | 'whisper-small') {
  const { createWhisperAdapter } = await import('./whisper')
  const adapter = createWhisperAdapter(new URL('whisper-worker.ts', import.meta.url))

  const loading = adapter.load(undefined, { modelId })
  await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1))
  const worker = MockWorker.instances[0]
  await vi.waitFor(() => expect(loadRequestsOf(worker)).toHaveLength(1))
  answerLoad(worker, loadRequestsOf(worker)[0])
  await loading

  return { adapter, worker }
}

describe('whisper adapter worker failure handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWorker.instances.length = 0
    enqueueMock.mockClear()
    enqueueMock.mockImplementation((_id: string, _p: number, loader: () => Promise<unknown>) => loader())
    recordDeviceLoss.mockClear()
    release.mockClear()
    requestAllocation.mockClear()
    inferenceStatus.updateInferenceStatus.mockClear()
    inferenceStatus.removeInferenceStatus.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('rejects an in-flight model load as soon as the worker errors', async () => {
    const { createWhisperAdapter } = await import('./whisper')
    const adapter = createWhisperAdapter(new URL('whisper-worker.ts', import.meta.url))

    const loading = adapter.load()

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalled())
    const worker = MockWorker.instances.at(-1)!
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'load-model' }))

    worker.dispatch('error', { error: new Error('Whisper worker crashed while loading') })

    await expect(loading).rejects.toThrow('Whisper worker crashed while loading')
    expect(adapter.state).toBe('error')
  })

  it('rejects an in-flight transcription as soon as the worker errors', async () => {
    const { adapter, worker } = await createLoadedAdapter('whisper-small')
    expect(adapter.state).toBe('ready')

    const transcribing = adapter.transcribe({ audio: 'data:audio/wav;base64,test', language: 'en' })

    await vi.waitFor(() => {
      expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'run-inference' }))
    })

    worker.dispatch('error', { error: new Error('Whisper worker crashed during transcription') })

    await expect(transcribing).rejects.toThrow('Whisper worker crashed during transcription')
    expect(adapter.state).toBe('error')
  })

  it('starts a new worker after the restart delay when the worker crashes', async () => {
    const { worker } = await createLoadedAdapter('whisper-small')

    worker.dispatch('error', { error: new Error('Whisper worker crashed') })
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)

    expect(worker.terminate).toHaveBeenCalled()
    expect(MockWorker.instances).toHaveLength(2)
  })

  // ROOT CAUSE:
  //
  // `terminate()` kept the restart timer that a crash scheduled, and the timer did not check the state, so a
  // terminated adapter started a new worker.
  //
  // setTimeout(() => ensureWorker(), delay)
  //
  // We fixed this by clearing the timer in `terminate()` and checking the state.
  // if (state !== 'terminated') ensureWorker()
  it('does not start a new worker when terminate() runs during the restart delay', async () => {
    const { adapter, worker } = await createLoadedAdapter('whisper-small')

    worker.dispatch('error', { error: new Error('Whisper worker crashed') })
    adapter.terminate()
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS * MAX_RESTARTS)

    expect(MockWorker.instances).toHaveLength(1)
    expect(adapter.state).toBe('terminated')
  })
})

describe('getWhisperAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWorker.instances.length = 0
    enqueueMock.mockClear()
    enqueueMock.mockImplementation((_id: string, _p: number, loader: () => Promise<unknown>) => loader())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns the same adapter while it is in error state', async () => {
    const { getWhisperAdapter } = await import('./whisper')
    const adapter = await getWhisperAdapter()

    const loading = adapter.load()
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1))
    MockWorker.instances[0].dispatch('error', { error: new Error('Whisper worker crashed while loading') })
    await expect(loading).rejects.toThrow('Whisper worker crashed while loading')
    expect(adapter.state).toBe('error')

    // The next load() recovers this adapter. A new adapter would reset its device-loss count, which moves loads to
    // WASM after repeated WebGPU device losses.
    await expect(getWhisperAdapter()).resolves.toBe(adapter)
  })

  it('returns a new adapter after the previous one is terminated', async () => {
    const { getWhisperAdapter } = await import('./whisper')
    const adapter = await getWhisperAdapter()

    adapter.terminate()
    const replacement = await getWhisperAdapter()

    expect(replacement).not.toBe(adapter)
    expect(replacement.state).toBe('idle')
  })
})

describe('whisper adapter model selection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWorker.instances.length = 0
    enqueueMock.mockClear()
    enqueueMock.mockImplementation((_id: string, _p: number, loader: () => Promise<unknown>) => loader())
    release.mockClear()
    requestAllocation.mockClear()
    inferenceStatus.updateInferenceStatus.mockClear()
    inferenceStatus.removeInferenceStatus.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('loads Whisper Small when no model is given', async () => {
    const { createWhisperAdapter } = await import('./whisper')
    const adapter = createWhisperAdapter(new URL('whisper-worker.ts', import.meta.url))

    const loading = adapter.load()
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1))
    const worker = MockWorker.instances[0]
    await vi.waitFor(() => expect(loadRequestsOf(worker)).toHaveLength(1))

    expect(loadRequestsOf(worker)[0].modelId).toBe('whisper-small')

    answerLoad(worker, loadRequestsOf(worker)[0])
    await loading
    expect(adapter.loadedModelId).toBe('whisper-small')
  })

  it('resolves without a worker request when the requested model is already loaded and ready', async () => {
    const { adapter, worker } = await createLoadedAdapter('whisper-small')

    await adapter.load(undefined, { modelId: 'whisper-small' })

    expect(loadRequestsOf(worker)).toHaveLength(1)
    expect(enqueueMock).toHaveBeenCalledTimes(1)
    expect(adapter.state).toBe('ready')
  })

  it('posts a new load when a different model is requested and tracks the new model', async () => {
    const { adapter, worker } = await createLoadedAdapter('whisper-base')
    expect(adapter.loadedModelId).toBe('whisper-base')

    const switching = adapter.load(undefined, { modelId: 'whisper-small' })
    await vi.waitFor(() => expect(loadRequestsOf(worker)).toHaveLength(2))
    const switchRequest = loadRequestsOf(worker)[1]

    expect(switchRequest.modelId).toBe('whisper-small')
    expect(adapter.state).toBe('loading')
    expect(inferenceStatus.removeInferenceStatus).toHaveBeenCalledWith('whisper-base')

    answerLoad(worker, switchRequest)
    await switching

    expect(adapter.loadedModelId).toBe('whisper-small')
    expect(requestAllocation).toHaveBeenLastCalledWith('whisper-small', getWhisperModel('whisper-small').vramEstimateBytes)
    expect(inferenceStatus.updateInferenceStatus).toHaveBeenLastCalledWith('whisper-small', expect.objectContaining({ state: 'ready', device: 'webgpu' }))
  })

  // ROOT CAUSE:
  //
  // A failed model switch cleared `loadedModelId` but kept the previous model's GPU allocation, although the worker
  // disposes that model before it loads the next one.
  //
  // loadedModelId = null
  //
  // We fixed this by releasing the allocation whenever `loadedModelId` is cleared.
  // forgetLoadedModel()
  it('releases the previous model\'s GPU allocation when a model switch fails', async () => {
    const { adapter, worker } = await createLoadedAdapter('whisper-base')
    const baseAllocation = requestAllocation.mock.results[0].value

    const switching = adapter.load(undefined, { modelId: 'whisper-small' })
    await vi.waitFor(() => expect(loadRequestsOf(worker)).toHaveLength(2))
    worker.dispatch('message', {
      data: {
        type: 'error',
        requestId: loadRequestsOf(worker)[1].requestId,
        payload: { code: 'LOAD_FAILED', message: 'Failed to download whisper-small', recoverable: false },
      },
    })

    await expect(switching).rejects.toThrow('Failed to download whisper-small')
    expect(adapter.state).toBe('error')
    expect(adapter.loadedModelId).toBeNull()
    expect(release).toHaveBeenCalledWith(baseAllocation)
  })

  // ROOT CAUSE:
  //
  // The percentage summed only files that had sent bytes. config.json finishes before the weight files send bytes,
  // so the status read 100% and then fell.
  //
  // percent: aggregateDownloadPercent(downloadedBytes)
  //
  // We fixed this by waiting for every started weight file and keeping the highest figure.
  // Math.max(downloadPercent, aggregateDownloadPercent(downloadedBytes))
  it('reports one download percentage that waits for every started weight file and never falls', async () => {
    const { createWhisperAdapter } = await import('./whisper')
    const adapter = createWhisperAdapter(new URL('whisper-worker.ts', import.meta.url))

    const loading = adapter.load(undefined, { modelId: 'whisper-base' })
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1))
    const worker = MockWorker.instances[0]
    await vi.waitFor(() => expect(loadRequestsOf(worker)).toHaveLength(1))
    const request = loadRequestsOf(worker)[0]

    // The worker forwards transformers.js 'initiate' events without byte counts, then 'progress' events with them.
    const startFile = (file: string) => worker.dispatch('message', {
      data: { type: 'progress', requestId: request.requestId, payload: { phase: 'download', percent: 0, message: `Loading ${file}`, file } },
    })
    const reportFile = (file: string, loaded: number, total: number) => worker.dispatch('message', {
      data: { type: 'progress', requestId: request.requestId, payload: { phase: 'download', percent: Math.round(loaded / total * 100), file, loaded, total } },
    })

    reportFile('config.json', 10, 10)
    startFile('onnx/decoder_model_merged_q4.onnx')
    startFile('onnx/encoder_model_fp16.onnx')
    // An encoder read from the browser cache can finish before the decoder sends its first bytes.
    reportFile('onnx/encoder_model_fp16.onnx', 90, 90)
    expect(reportedDownloadPercents('whisper-base')).toEqual([])

    reportFile('onnx/decoder_model_merged_q4.onnx', 100, 300)
    expect(reportedDownloadPercents('whisper-base')).toEqual([50])

    // The fp16 encoder failed to start, so the worker downloads the fp32 encoder. It lowers the aggregate to 30%.
    startFile('onnx/encoder_model.onnx')
    reportFile('onnx/encoder_model.onnx', 40, 400)
    reportFile('onnx/decoder_model_merged_q4.onnx', 300, 300)
    expect(reportedDownloadPercents('whisper-base')).toEqual([50, 50, 55])

    answerLoad(worker, request)
    await loading
  })

  it('fails a load only after the worker sends no progress for the whole load timeout', async () => {
    const { createWhisperAdapter } = await import('./whisper')
    const adapter = createWhisperAdapter(new URL('whisper-worker.ts', import.meta.url))

    const loading = adapter.load()
    let settled = false
    const markSettled = () => {
      settled = true
    }
    loading.then(markSettled, markSettled)
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1))
    const worker = MockWorker.instances[0]
    await vi.waitFor(() => expect(loadRequestsOf(worker)).toHaveLength(1))
    const request = loadRequestsOf(worker)[0]

    // vi.waitFor advances fake timers while it polls, so keep a margin below the timeout. Together the two waits
    // exceed one timeout, so a timer that progress does not restart would already have fired.
    const margin = 1_000
    await vi.advanceTimersByTimeAsync(TIMEOUTS.WHISPER_LOAD - margin)
    worker.dispatch('message', {
      data: { type: 'progress', requestId: request.requestId, payload: { phase: 'download', percent: 1, file: 'onnx/encoder_model_fp16.onnx', loaded: 1, total: 100 } },
    })
    await vi.advanceTimersByTimeAsync(TIMEOUTS.WHISPER_LOAD - margin)

    expect(settled).toBe(false)
    expect(adapter.state).toBe('loading')

    await vi.advanceTimersByTimeAsync(margin)

    await expect(loading).rejects.toThrow('timeout')
    expect(adapter.state).toBe('error')
    // A stalled worker would block every later request, so the adapter replaces it on the next load.
    expect(worker.terminate).toHaveBeenCalled()
  })
})
