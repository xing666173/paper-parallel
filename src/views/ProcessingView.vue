<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import AiLogPanel from '../components/processing/AiLogPanel.vue';
import PaperPreview from '../components/processing/PaperPreview.vue';
import type { PreviewState } from '../components/processing/PaperPreview.vue';
import ProgressSummary from '../components/processing/ProgressSummary.vue';
import StageTimeline from '../components/processing/StageTimeline.vue';
import { createProjectRepository } from '../core/project/repository';
import { canEnterReader } from '../core/task/completion';
import { estimateRemainingMs } from '../core/task/metrics';
import { useTaskStore } from '../stores/task';
import { runProductionPipeline } from '../core/pipeline/productionPipeline';
import { createBrowserPipelineStages } from '../core/pipeline/browserStages';
import type { TaskSnapshot } from '../types/models';

const route = useRoute();
const router = useRouter();
const store = useTaskStore();
const repository = createProjectRepository();
const projectId = computed(() => String(route.params.projectId));
const loading = ref(false);
const loadError = ref('');
const sourceUrl = ref<string>();
const previewUrl = ref<string>();
const previewState = ref<PreviewState>('empty');
let enteredReader = false;

const task = computed(() => (
  store.current?.projectId === projectId.value ? store.current : null
));

const estimatedRemainingMs = computed(() => {
  if (!task.value || task.value.progress.completed <= 0) return null;
  const remainingBlocks = Math.max(0, task.value.progress.total - task.value.progress.completed);
  const sampledTokens = store.throughputSamples.reduce((sum, sample) => sum + sample.tokens, 0);
  if (sampledTokens === 0) return null;
  const tokensPerBlock = sampledTokens / task.value.progress.completed;
  return estimateRemainingMs(store.throughputSamples, Math.ceil(tokensPerBlock * remainingBlocks));
});

watch(() => store.completionSummary, async (summary) => {
  if (enteredReader || !summary || !canEnterReader(summary)) return;
  enteredReader = true;
  await router.replace({ name: 'reader', params: { projectId: projectId.value }, query: { auto: '1' } });
}, { deep: true, immediate: true });

function pipelineRunner(initial: TaskSnapshot) {
  return async (signal: AbortSignal) => {
    const stages = createBrowserPipelineStages({
      projectId: projectId.value,
      snapshot: initial,
      repository,
      onAiEvent: store.recordAiEvent,
      onValidated: (count) => {
        if (!store.current || store.current.stage !== 'translating') return;
        store.current = {
          ...store.current,
          progress: {
            ...store.current.progress,
            completed: Math.min(store.current.progress.total, store.current.progress.completed + count),
          },
          updatedAt: Date.now(),
        };
        void repository.saveTask(store.current);
      },
    });
    const result = await runProductionPipeline({
      snapshot: initial,
      repository,
      signal,
      stages,
      onSnapshot: (snapshot) => { store.current = snapshot; },
    });
    store.current = result.snapshot;
    store.completionSummary = result.completion;
  };
}

function startIdleTask(snapshot: TaskSnapshot) {
  void store.start(snapshot, pipelineRunner(snapshot)).catch(() => undefined);
}

function resumeTask() {
  if (!store.current) return;
  const snapshot = store.current;
  void store.resume(pipelineRunner(snapshot)).catch(() => undefined);
}

onMounted(async () => {
  loading.value = !task.value;
  try {
    if (!task.value) store.current = await repository.loadTask(projectId.value) ?? null;
    const artifact = await repository.findArtifact(`${projectId.value}:english-pdf`);
    if (artifact?.blob instanceof Blob && typeof URL.createObjectURL === 'function') {
      sourceUrl.value = URL.createObjectURL(artifact.blob);
    }
    const preview = await repository.findArtifact(`${projectId.value}:typst-preview`);
    if (preview?.blob instanceof Blob && typeof URL.createObjectURL === 'function') {
      previewUrl.value = URL.createObjectURL(preview.blob);
      previewState.value = 'ready';
    } else if (task.value?.status === 'failed') {
      previewState.value = 'failed';
    } else if (task.value?.stage === 'composing' || task.value?.stage === 'compiling') {
      previewState.value = 'building';
    }
    if (!store.current) loadError.value = '未找到该翻译任务，请重新选择论文。';
    else if (store.current.status === 'idle') startIdleTask(store.current);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value);
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
});

onBeforeRouteLeave(() => {
  if (task.value?.status !== 'running' && task.value?.status !== 'stopping') return true;
  return window.confirm('任务仍在运行。离开页面前建议先安全停止，确定继续离开吗？');
});
</script>

<template>
  <main class="processing-page">
    <div v-if="loading" class="task-loading">正在恢复本地任务…</div>
    <div v-else-if="loadError || !task" class="task-missing" role="alert">
      <h1>无法打开任务</h1><p>{{ loadError }}</p><RouterLink to="/">重新选择论文</RouterLink>
    </div>
    <template v-else>
      <ProgressSummary
        :task="task"
        :estimated-remaining-ms="estimatedRemainingMs"
        :last-response-at="store.lastResponseAt"
        @stop="store.safeStop()"
        @resume="resumeTask"
      />
      <p v-if="task.status === 'failed'" class="quality-error" role="alert">
        <strong>当前阶段未通过：</strong>{{ task.error }}
      </p>
      <div class="processing-workspace">
        <aside class="processing-sidebar">
          <StageTimeline :task="task" />
          <AiLogPanel :entries="store.aiLog" />
        </aside>
        <PaperPreview
          :source-url="sourceUrl"
          :preview-url="previewUrl"
          :preview-state="previewState"
        />
      </div>
    </template>
  </main>
</template>
