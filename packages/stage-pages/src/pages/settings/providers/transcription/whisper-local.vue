<script setup lang="ts">
import type { TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import { errorMessageFrom } from '@moeru/std'
import {
  ProviderBasicSettings,
  ProviderSettingsContainer,
  ProviderSettingsLayout,
  TranscriptionPlayground,
} from '@proj-airi/stage-ui/components'
import { useInferenceStatus } from '@proj-airi/stage-ui/composables/use-inference-status'
import { selectProviderMetadata } from '@proj-airi/stage-ui/libs'
import { DEFAULT_WHISPER_MODEL_ID, getWhisperModel, isWhisperModelId } from '@proj-airi/stage-ui/libs/inference/constants'
import { WHISPER_LOCAL_PROVIDER_ID } from '@proj-airi/stage-ui/libs/providers/providers/whisper-local/constants'
import { useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useProviderConfigStore } from '@proj-airi/stage-ui/stores/providers/config'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { Button, Callout, FieldCombobox, Progress } from '@proj-airi/ui'
import { computedAsync } from '@vueuse/core'
import { cloneDeep } from 'es-toolkit'
import { storeToRefs } from 'pinia'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const providerId = WHISPER_LOCAL_PROVIDER_ID

const { t } = useI18n()
const router = useRouter()
const hearingStore = useHearingStore()
const providersStore = useProviderStore()
const providerConfigStore = useProviderConfigStore()
const { activeTranscriptionProvider, activeTranscriptionModel } = storeToRefs(hearingStore)
const { models: inferenceModels } = useInferenceStatus()

const providerMetadata = computedAsync(() => selectProviderMetadata(
  providersStore.getProviderDefinition(providerId),
  t,
  { id: providerId },
))

const providerModels = computed(() => providersStore.getModelsForProvider(providerId))
const isLoadingModels = computed(() => providersStore.isLoadingModels[providerId] || false)
const modelOptions = computed(() => providerModels.value.map(model => ({
  value: model.id,
  label: model.name,
  // The catalog is fetched once, so a description from it keeps the locale of that fetch.
  description: isWhisperModelId(model.id) ? t(getWhisperModel(model.id).descriptionKey) : model.description,
})))

const isUsedByHearing = computed(() => activeTranscriptionProvider.value === providerId)

/**
 * The Whisper model that this page shows, downloads, and tests.
 *
 * Hearing owns the model choice, so the model field writes the Hearing store.
 * While Hearing uses another provider, the page shows the default model, because
 * the "Use for Hearing" action selects that model. A Hearing model id that is not
 * a Whisper model (left from another provider) also resolves to the default.
 */
const selectedModel = computed({
  get: () => {
    if (isUsedByHearing.value && isWhisperModelId(activeTranscriptionModel.value))
      return activeTranscriptionModel.value
    return DEFAULT_WHISPER_MODEL_ID
  },
  set: (value: string | undefined) => {
    if (value)
      activeTranscriptionModel.value = value
  },
})

function useForHearing() {
  // Hearing is a synchronized store. Set both fields in one tick, so that the
  // state proposal never pairs Whisper with the model id of the previous provider.
  activeTranscriptionProvider.value = providerId
  activeTranscriptionModel.value = DEFAULT_WHISPER_MODEL_ID
}

/**
 * Download state of {@link selectedModel}, owned by this page.
 *
 * - `idle`: no download from this page yet. The model can still be on this device.
 * - `loading`: `loadProviderModel` is pending.
 * - `ready`: the model loaded. The browser cache keeps the files for offline use.
 * - `error`: the load failed. `downloadError` holds the reason.
 *
 * A change of the selected model resets the state, and a result for a previous model is ignored.
 */
const downloadState = shallowRef<'idle' | 'loading' | 'ready' | 'error'>('idle')
const downloadError = shallowRef('')

watch(selectedModel, () => {
  downloadState.value = 'idle'
  downloadError.value = ''
})

// NOTICE:
// `loadProviderModel` runs in the leader window. The inference status map is module state of
// that window, so a follower window (Electron settings) gets no progress. There the page shows
// the pending action without a percentage.
const selectedModelStatus = computed(() => inferenceModels.value.find(status => status.modelId === selectedModel.value))
const downloadPercent = computed(() => {
  const percent = selectedModelStatus.value?.progress?.percent
  // The adapters report -1 for an unknown total size.
  if (percent === undefined || percent < 0)
    return undefined
  return Math.round(percent)
})
const isModelReady = computed(() => {
  if (downloadState.value === 'ready')
    return true
  // A load from another place in this window, such as the playground, also makes the model ready.
  return downloadState.value === 'idle' && selectedModelStatus.value?.state === 'ready'
})

async function downloadModel() {
  const model = selectedModel.value
  downloadState.value = 'loading'
  downloadError.value = ''

  try {
    await providersStore.initializeProvider(providerId)
    // Synchronized actions send their arguments with structuredClone, which rejects reactive proxies.
    const config = cloneDeep(providerConfigStore.getProviderConfig(providerId))
    await providersStore.loadProviderModel(providerId, { ...config, model })
    if (selectedModel.value === model)
      downloadState.value = 'ready'
  }
  catch (error) {
    console.error('[Whisper Local] Failed to load the model:', error)
    if (selectedModel.value !== model)
      return
    downloadState.value = 'error'
    downloadError.value = errorMessageFrom(error) ?? ''
  }
}

async function handleGenerateTranscription(file: File) {
  const provider = await providersStore.getProviderInstance<TranscriptionProviderWithExtraOptions<string, Record<string, unknown>>>(providerId)
  return await hearingStore.transcription(providerId, provider, selectedModel.value, file, 'json')
}

onMounted(async () => {
  await providersStore.initializeProvider(providerId)
  await providersStore.fetchModelsForProvider(providerId)
})
</script>

<template>
  <ProviderSettingsLayout
    :provider-name="providerMetadata?.localizedName"
    :provider-icon="providerMetadata?.icon"
    :provider-icon-color="providerMetadata?.iconColor"
    :on-back="() => router.back()"
  >
    <div :class="['flex flex-col gap-6', 'md:flex-row']">
      <ProviderSettingsContainer :class="['w-full', 'md:w-[40%]']">
        <Callout :label="t('settings.pages.providers.provider.whisper-local.callout.label')">
          <p>{{ t('settings.pages.providers.provider.whisper-local.callout.privacy') }}</p>
          <p>{{ t('settings.pages.providers.provider.whisper-local.callout.download') }}</p>
          <p>{{ t('settings.pages.providers.provider.whisper-local.callout.models') }}</p>
        </Callout>

        <ProviderBasicSettings
          :title="t('settings.pages.providers.common.section.basic.title')"
          :description="t('settings.pages.providers.common.section.basic.description')"
        >
          <div :class="['flex flex-col gap-2']">
            <div :class="['text-sm font-medium']">
              {{ t('settings.pages.providers.provider.whisper-local.hearing.label') }}
            </div>
            <div
              v-if="isUsedByHearing"
              :class="[
                'flex items-center gap-2',
                'text-sm text-green-700 dark:text-green-400',
              ]"
            >
              <div :class="['i-solar:check-circle-line-duotone', 'shrink-0 text-lg']" />
              <span>{{ t('settings.pages.providers.provider.whisper-local.hearing.active') }}</span>
            </div>
            <template v-else>
              <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
                {{ t('settings.pages.providers.provider.whisper-local.hearing.inactive') }}
              </div>
              <Button
                icon="i-solar:microphone-3-line-duotone"
                color="primary"
                variant="primary"
                :label="t('settings.pages.providers.provider.whisper-local.hearing.use')"
                block
                @click="useForHearing"
              />
            </template>
          </div>

          <FieldCombobox
            v-if="isUsedByHearing"
            v-model="selectedModel"
            :label="t('settings.pages.providers.provider.whisper-local.fields.field.model.label')"
            :description="t('settings.pages.providers.provider.whisper-local.fields.field.model.description')"
            :options="modelOptions"
            :disabled="isLoadingModels || modelOptions.length === 0"
            layout="vertical"
          />

          <div :class="['flex flex-col gap-3']">
            <div>
              <div :class="['text-sm font-medium']">
                {{ t('settings.pages.providers.provider.whisper-local.download.label') }}
              </div>
              <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
                {{ t('settings.pages.providers.provider.whisper-local.download.description') }}
              </div>
            </div>

            <template v-if="downloadState === 'loading'">
              <Progress v-if="downloadPercent !== undefined" :progress="downloadPercent" />
              <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
                <template v-if="downloadPercent !== undefined">
                  {{ t('settings.pages.providers.provider.whisper-local.download.status.progress', { percent: downloadPercent }) }}
                </template>
                <template v-else>
                  {{ t('settings.pages.providers.provider.whisper-local.download.status.loading') }}
                </template>
              </div>
            </template>

            <div
              v-else-if="isModelReady"
              :class="[
                'flex items-center gap-2',
                'text-sm text-green-700 dark:text-green-400',
              ]"
            >
              <div :class="['i-solar:check-circle-line-duotone', 'shrink-0 text-lg']" />
              <span>{{ t('settings.pages.providers.provider.whisper-local.download.status.ready') }}</span>
            </div>

            <div
              v-if="downloadState === 'error'"
              :class="[
                'flex flex-col gap-1',
                'rounded-lg p-3',
                'border border-red-200 dark:border-red-800',
                'bg-red-50 dark:bg-red-900/20',
                'text-sm text-red-700 dark:text-red-400',
              ]"
            >
              <span :class="['font-medium']">{{ t('settings.pages.providers.provider.whisper-local.download.status.error') }}</span>
              <span v-if="downloadError" :class="['break-words text-xs']">{{ downloadError }}</span>
            </div>

            <Button
              v-if="!isModelReady"
              icon="i-solar:download-minimalistic-line-duotone"
              :label="downloadState === 'error'
                ? t('settings.pages.providers.provider.whisper-local.download.action.retry')
                : t('settings.pages.providers.provider.whisper-local.download.action.download')"
              :loading="downloadState === 'loading'"
              block
              @click="downloadModel"
            />
          </div>
        </ProviderBasicSettings>
      </ProviderSettingsContainer>

      <div :class="['flex flex-col gap-6', 'w-full md:w-[60%]']">
        <TranscriptionPlayground
          :generate-transcription="handleGenerateTranscription"
          :api-key-configured="true"
        />
      </div>
    </div>
  </ProviderSettingsLayout>
</template>

<route lang="yaml">
  meta:
    layout: settings
    stageTransition:
      name: slide
</route>
