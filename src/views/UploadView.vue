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
import {
  CURRENT_LAYOUT_PROFILE,
  CURRENT_TARGET_LAYOUT_POLICY,
} from '../core/layout/profile';
import { useTaskStore } from '../stores/task';

const KEY_STORAGE = 'paper-parallel.deepseek-key';
const SESSION_KEY_STORAGE = 'paper-parallel.deepseek-key-session';
const router = useRouter();
const repository = createProjectRepository();
const taskStore = useTaskStore();
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
    const existingTask = await repository.loadTask(projectId);
    if (existingTask?.status === 'running' || existingTask?.status === 'stopping') {
      throw new Error('同一篇论文已有任务正在运行，请先在处理页安全停止后再重新开始。');
    }
    // projectId intentionally follows the source hash so translation and
    // source-analysis caches remain reusable. A new run must nevertheless
    // remove every old final-layout artifact before it advertises an idle task.
    await repository.clearProjectLayoutOutputs(projectId);
    await repository.putArtifact({
      key: `${projectId}:english-pdf`,
      projectId,
      kind: 'english-pdf',
      blob: file.value,
      updatedAt: Date.now(),
    });
    sessionStorage.setItem(SESSION_KEY_STORAGE, apiKey.value.trim());
    const snapshot = {
      ...createTaskSnapshot(projectId),
      settings: {
        modelId: model.value,
        thinkingMode: thinkingMode.value,
        sourceFileName: file.value.name,
        sourceFileHash: fileHash,
        targetLayoutPolicy: CURRENT_TARGET_LAYOUT_POLICY,
        layoutProfileVersion: CURRENT_LAYOUT_PROFILE,
      },
    };
    await repository.saveTask(snapshot);
    await repository.clearAiLog(projectId);
    taskStore.current = snapshot;
    taskStore.completionSummary = null;
    taskStore.aiLog = [];
    taskStore.throughputSamples = [];
    taskStore.lastResponseAt = null;
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
      <p>英文原文保持不变，中文统一重排为适合阅读的单栏 PDF，并保留图表、公式与双语对应。</p>
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
