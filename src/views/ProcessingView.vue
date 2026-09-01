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
import { resetTaskForSingleColumnLayout, usesCurrentSingleColumnLayout } from '../core/layout/profile';
import type { QualityReport } from '../core/quality/report';

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
const qualityReport = ref<QualityReport>();
let enteredReader = false;

const task = computed(() => (
  store.current?.projectId === projectId.value ? store.current : null
));

const estimatedRemainingMs = computed(() => {
  if (!task.value || task.value.stage !== 'translating' || task.value.progress.completed <= 0) return null;
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
}, { deep: true });

watch(() => task.value?.status, async (status) => {
  if (status === 'failed' && !previewUrl.value) previewState.value = 'failed';
  if (status === 'failed' || status === 'completed') await loadQualityReport();
});

function pipelineRunner(initial: TaskSnapshot) {
  return async (signal: AbortSignal) => {
    const stages = createBrowserPipelineStages({
      projectId: projectId.value,
      snapshot: initial,
      repository,
      onAiEvent: store.recordAiEvent,
      onPreview: ({ svg }) => {
        if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
        previewUrl.value = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        previewState.value = 'ready';
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

async function loadQualityReport(): Promise<void> {
  const artifact = await repository.findArtifact(`${projectId.value}:quality-report`);
  qualityReport.value = artifact ? JSON.parse(await artifact.blob.text()) as QualityReport : undefined;
}

function hasApiKey(): boolean {
  return Boolean(
    sessionStorage.getItem('paper-parallel.deepseek-key-session')?.trim()
    || localStorage.getItem('paper-parallel.deepseek-key')?.trim(),
  );
}

async function reflowWithCurrentLayout(): Promise<void> {
  if (!store.current || store.current.status === 'running' || store.current.status === 'stopping') return;
  if (!hasApiKey()) {
    loadError.value = '按新版重新排版仍需 DeepSeek 逐页质检，请返回上传页重新验证 API Key。';
    return;
  }
  try {
    await repository.clearProjectLayoutOutputs(projectId.value);
    const reset = resetTaskForSingleColumnLayout(store.current);
    await repository.saveTask(reset);
    store.current = reset;
    store.completionSummary = null;
    qualityReport.value = undefined;
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = undefined;
    previewState.value = 'building';
    startIdleTask(reset);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  }
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
    if (store.current?.status === 'stopping') await store.recoverInterruptedStop();
    if (store.current) await store.restoreAiLog(projectId.value);
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
    await loadQualityReport();
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
        :ai-log-entries="store.aiLog"
        :estimated-remaining-ms="estimatedRemainingMs"
        :last-response-at="store.lastResponseAt"
        @stop="store.safeStop()"
        @resume="resumeTask"
      />
      <div v-if="task.status === 'completed'" class="layout-action-row">
        <span>全部质量门已通过</span>
        <button
          class="button primary"
          data-action="open-reader"
          type="button"
          @click="router.push({ name: 'reader', params: { projectId } })"
        >进入对照阅读</button>
      </div>
      <p v-if="task.status === 'failed'" class="quality-error" role="alert">
        <strong>当前阶段未通过：</strong>{{ task.error }}
      </p>
      <section v-if="qualityReport" class="quality-report-card" aria-label="排版质量报告">
        <div>
          <strong>{{ qualityReport.pass ? '逐页质检通过' : '逐页质检未通过' }}</strong>
          <span>共 {{ qualityReport.attempts.length }} 次排版，检查 {{ qualityReport.attempts.at(-1)?.reviewedPages ?? 0 }} 页</span>
        </div>
        <ul v-if="qualityReport.attempts.at(-1)?.issues.length">
          <li v-for="(issue, index) in qualityReport.attempts.at(-1)?.issues" :key="`${issue.targetPageIndex}-${issue.type}-${index}`">
            第 {{ issue.targetPageIndex + 1 }} 页 · {{ issue.type }}：{{ issue.evidence }}
          </li>
        </ul>
      </section>
      <div v-if="(task.status === 'completed' || task.status === 'failed') && !usesCurrentSingleColumnLayout(task)" class="layout-action-row">
        <span>{{ usesCurrentSingleColumnLayout(task) ? '当前：中文单栏版' : '当前：旧版排版' }}</span>
        <button class="button secondary" type="button" @click="reflowWithCurrentLayout">按新版重新排版</button>
      </div>
      <p class="vision-disclosure">
        版式识别和成品质检会将论文页面图片发送给 DeepSeek Vision Exp，并产生额外 API 用量；页面与结果仍只保存在当前浏览器。
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
