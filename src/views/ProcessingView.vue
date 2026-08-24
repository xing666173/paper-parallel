<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import AiLogPanel from '../components/processing/AiLogPanel.vue';
import PaperPreview from '../components/processing/PaperPreview.vue';
import ProgressSummary from '../components/processing/ProgressSummary.vue';
import StageTimeline from '../components/processing/StageTimeline.vue';
import { createProjectRepository } from '../core/project/repository';
import { canEnterReader } from '../core/task/completion';
import { estimateRemainingMs } from '../core/task/metrics';
import { useTaskStore } from '../stores/task';

const route = useRoute();
const router = useRouter();
const store = useTaskStore();
const repository = createProjectRepository();
const projectId = computed(() => String(route.params.projectId));
const loading = ref(false);
const loadError = ref('');
const sourceUrl = ref<string>();
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
  await router.replace({ name: 'reader', params: { projectId: projectId.value } });
}, { deep: true, immediate: true });

onMounted(async () => {
  loading.value = !task.value;
  try {
    if (!task.value) store.current = await repository.loadTask(projectId.value) ?? null;
    const artifact = await repository.findArtifact(`${projectId.value}:english-pdf`);
    if (artifact?.blob instanceof Blob && typeof URL.createObjectURL === 'function') {
      sourceUrl.value = URL.createObjectURL(artifact.blob);
    }
    if (!store.current) loadError.value = '未找到该翻译任务，请重新选择论文。';
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value);
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
      />
      <p v-if="task.status === 'failed'" class="quality-error" role="alert">
        <strong>当前阶段未通过：</strong>{{ task.error }}
      </p>
      <div class="processing-workspace">
        <aside class="processing-sidebar">
          <StageTimeline :task="task" />
          <AiLogPanel :entries="store.aiLog" />
        </aside>
        <PaperPreview :source-url="sourceUrl" />
      </div>
    </template>
  </main>
</template>
