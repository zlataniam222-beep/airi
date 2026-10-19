import type { RenderResult } from 'vitest-browser-vue'

import en from '@proj-airi/i18n/locales/en'

import { PiniaColada } from '@pinia/colada'
import { useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-vue'
import { page } from 'vitest/browser'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import HearingPage from './hearing.vue'

import 'virtual:uno.css'

/**
 * Saves the OpenAI transcription Provider as configured, so the Hearing page lists it.
 * Its model list is built in, so no request leaves the browser.
 */
function saveConfiguredOpenAITranscriptionProvider() {
  localStorage.setItem('settings/providers/configured', JSON.stringify({
    'openai-audio-transcription': {
      id: 'openai-audio-transcription',
      definitionId: 'openai-audio-transcription',
      config: { apiKey: 'hearing-page-test-key', baseUrl: 'https://api.openai.com/v1/' },
      status: 'configured',
      configuredBy: 'user',
    },
  }))
}

/**
 * Selects a Provider radio card the way a user's click does.
 *
 * The card draws its radio circle over the hidden input, so Playwright reports that the circle
 * intercepts a normal click. A forced click lands on the same point, and the card label then
 * selects its input.
 */
async function selectProviderCard(screen: RenderResult<unknown>, name: RegExp) {
  await screen.getByRole('radio', { name }).click({ force: true })
}

/** Saves the Hearing selection that the page reads when it opens. */
function saveHearingSelection(provider: string, model: string) {
  localStorage.setItem('settings/hearing/active-provider', provider)
  localStorage.setItem('settings/hearing/active-model', model)
}

describe('hearing module page', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    localStorage.clear()
    pinia = createPinia()
  })

  afterEach(() => {
    disposePinia(pinia)
    localStorage.clear()
  })

  async function renderPage() {
    await page.viewport(1100, 1100)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:path(.*)*', component: { template: '<div />' } }],
    })
    await router.push('/')
    return await render(HearingPage, {
      global: {
        plugins: [pinia, PiniaColada, router, createI18n({ legacy: false, locale: 'en', messages: { en } })],
        directives: { 'motion': {}, 'auto-animate': {} },
      },
    })
  }

  // ROOT CAUSE:
  //
  // Choosing Whisper (Local) selected Whisper Base. The watcher took the first listed model.
  //
  // activeTranscriptionModel.value = models[0].id // => 'whisper-base'
  //
  // We fixed this by declaring Whisper Small as the catalog default and preferring it.
  // activeTranscriptionModel.value = defaultModel // => 'whisper-small'
  it('selects the default Whisper (Local) model when the user switches to Whisper (Local)', async () => {
    saveConfiguredOpenAITranscriptionProvider()
    saveHearingSelection('openai-audio-transcription', 'whisper-1')
    const screen = await renderPage()
    const hearingStore = useHearingStore(pinia)
    await expect.element(screen.getByText('Current model: whisper-1')).toBeInTheDocument()

    await selectProviderCard(screen, /^Whisper \(Local\)/)

    await expect.poll(() => hearingStore.activeTranscriptionProvider).toBe('whisper-local')
    await expect.poll(() => hearingStore.activeTranscriptionModel).toBe('whisper-small')
  })

  it('selects the first listed model for a Provider without a default model', async () => {
    saveConfiguredOpenAITranscriptionProvider()
    saveHearingSelection('whisper-local', 'whisper-small')
    const screen = await renderPage()
    const hearingStore = useHearingStore(pinia)
    await expect.element(screen.getByText('Current model: whisper-small')).toBeInTheDocument()

    await selectProviderCard(screen, /^OpenAI\b/)

    await expect.poll(() => hearingStore.activeTranscriptionProvider).toBe('openai-audio-transcription')
    await expect.poll(() => hearingStore.activeTranscriptionModel).toBe('gpt-4o-transcribe')
  })

  it('keeps a saved Whisper (Local) model that is not the default', async () => {
    saveHearingSelection('whisper-local', 'whisper-large-v3-turbo')
    const screen = await renderPage()
    const hearingStore = useHearingStore(pinia)

    await expect.element(screen.getByText('Current model: whisper-large-v3-turbo')).toBeInTheDocument()
    expect(hearingStore.activeTranscriptionModel).toBe('whisper-large-v3-turbo')
  })
})
