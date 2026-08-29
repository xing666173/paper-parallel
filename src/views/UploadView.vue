<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import PdfDropzone from '../components/upload/PdfDropzone.vue';
import TranslationSettings from '../components/upload/TranslationSettings.vue';
import { createProjectRepository } from '../core/project/repository';
import { createTaskSnapshot } from '../core/task/stateMachine';
import {
  CURRENT_DEEPSEEK_MODELS,
  listModels,
  type DeepSeekModel,
} from '../core/translate/client';

const KEY_STORAGE = 'paper-parallel.deepseek-key';
const SESSION_KEY_STORAGE = 'paper-parallel.deepseek-key-session';
const router = useRouter();
const repository = createProjectRepository();
const file = ref<File | null>(null);
const models = ref<DeepSeekModel[]>(CURRENT_DEEPSEEK_MODELS.map((model) => ({ ...model })));
const model = ref(models.value[0]!.id);
const thinkingMode = ref<'enabled' | 'disabled'>('disabled');
const storedKey = localStorage.getItem(KEY_STORAGE) ?? '';
const apiKey = ref(storedKey);
const saveKey = ref(Boolean(storedKey));
const testing = ref(false);
const creating = ref(false);
const connectionStatus = ref<'idle' | 'success' | 'error'>('idle');
const errorMessage = ref('');

const canStart = computed(() => (
  file.value !== null
  && connectionStatus.value === 'success'
  && !creating.value
));

watch([model, thinkingMode, apiKey], () => {
  connectionStatus.value = 'idle';
});

function updateFile(selected: File | null): void {
  file.value = selected;
  errorMessage.value = '';
}

async function testConnection(): Promise<void> {
  testing.value = true;
  errorMessage.value = '';
  connectionStatus.value = 'idle';
  try {
    const discovered = await listModels({
      baseUrl: 'https://api.deepseek.com',
      apiKey: apiKey.value.trim(),
    });
    if (discovered.length === 0) throw new Error('当前账户未返回受支持的模型');
    models.value = discovered;
    if (!discovered.some((item) => item.id === model.value)) model.value = discovered[0]!.id;
    if (saveKey.value) localStorage.setItem(KEY_STORAGE, apiKey.value.trim());
    else localStorage.removeItem(KEY_STORAGE);
    connectionStatus.value = 'success';
  } catch (error) {
    connectionStatus.value = 'error';
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    testing.value = false;
  }
}

async function sha256(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function startTask(): Promise<void> {
  if (!file.value || !canStart.value) return;
  creating.value = true;
  errorMessage.value = '';
  try {
    const fileHash = await sha256(file.value);
    const projectId = `pp-${fileHash}`;
    await repository.putArtifact({
      key: `${projectId}:english-pdf`,
      projectId,
      kind: 'english-pdf',
      blob: file.value,
      updatedAt: Date.now(),
    });
    sessionStorage.setItem(SESSION_KEY_STORAGE, apiKey.value.trim());
    await repository.saveTask({
      ...createTaskSnapshot(projectId),
      settings: {
        modelId: model.value,
        thinkingMode: thinkingMode.value,
        sourceFileName: file.value.name,
        sourceFileHash: fileHash,
      },
    });
    await repository.clearAiLog(projectId);
    await router.push({ name: 'process', params: { projectId } });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <main class="upload-page">
    <section class="upload-hero">
      <p class="eyebrow">ACADEMIC PDF TRANSLATOR</p>
      <h1>把英文论文转换为可对照阅读的中文论文</h1>
      <p>保留论文的版式结构与技术内容，生成中文 PDF 和双语阅读任务。</p>
    </section>
    <form class="upload-card" @submit.prevent="startTask">
      <PdfDropzone :model-value="file" @update:model-value="updateFile" @error="errorMessage = $event" />
      <TranslationSettings
        v-model="model"
        v-model:thinking-mode="thinkingMode"
        v-model:api-key="apiKey"
        v-model:save-key="saveKey"
        :models="models"
        :testing="testing"
        :connection-status="connectionStatus"
        @test-connection="testConnection"
      />
      <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
      <div class="start-row">
        <span>{{ file ? file.name : '等待选择论文' }}</span>
        <button class="button primary" data-action="start" type="submit" :disabled="!canStart">
          {{ creating ? '正在创建任务…' : '开始翻译' }}
        </button>
      </div>
    </form>
  </main>
</template>
