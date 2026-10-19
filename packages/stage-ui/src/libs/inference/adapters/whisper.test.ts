import type { LoadModelRequest, WorkerInboundMessage, WorkerOutboundMessage } from '../protocol'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getWhisperModel, TIMEOUTS } from '../constants'

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
  removeInferenceStatus: vi.fn(),
  updateInferenceStatus: vi.fn(),
}))

vi.mock('../../../composables/use-inference-status', () => inferenceStatus)

const enqueueMock = vi.fn((_id: string, _p: number, loader: () => Promise<unknown>) => loader())
const recordDeviceLoss = vi.fn()
const requestAllocation = vi.fn((modelId: string, bytes: number) => ({ allocatedAt: 0, bytes, lastUsedAt: 0, modelId }))

vi.mock('../coordinator', () => ({
  getGPUCoordinator: () => ({
    recordDeviceLoss,
    release: vi.fn(),
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
})

describe('whisper adapter model selection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWorker.instances.length = 0
    enqueueMock.mockClear()
    enqueueMock.mockImplementation((_id: string, _p: number, loader: () => Promise<unknown>) => loader())
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

  it('reports the download of all model files as one percentage under the model ID', async () => {
    const { createWhisperAdapter } = await import('./whisper')
    const adapter = createWhisperAdapter(new URL('whisper-worker.ts', import.meta.url))

    const loading = adapter.load(undefined, { modelId: 'whisper-base' })
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1))
    const worker = MockWorker.instances[0]
    await vi.waitFor(() => expect(loadRequestsOf(worker)).toHaveLength(1))
    const request = loadRequestsOf(worker)[0]

    const reportFile = (file: string, loaded: number, total: number) => worker.dispatch('message', {
      data: { type: 'progress', requestId: request.requestId, payload: { phase: 'download', percent: Math.round(loaded / total * 100), file, loaded, total } },
    })

    reportFile('onnx/encoder_model_fp16.onnx', 50, 100)
    reportFile('onnx/decoder_model_merged_q4.onnx', 0, 300)
    expect(inferenceStatus.updateInferenceStatus).toHaveBeenLastCalledWith('whisper-base', {
      progress: expect.objectContaining({ phase: 'download', percent: 13 }),
    })

    reportFile('onnx/decoder_model_merged_q4.onnx', 300, 300)
    expect(inferenceStatus.updateInferenceStatus).toHaveBeenLastCalledWith('whisper-base', {
      progress: expect.objectContaining({ phase: 'download', percent: 88 }),
    })

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
