<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { TaskSnapshot } from '../../types/models';
import type { AiLogEntry } from '../../stores/task';

const props = defineProps<{
  task: TaskSnapshot;
  aiLogEntries: readonly AiLogEntry[];
  estimatedRemainingMs: number | null;
  lastResponseAt: number | null;
}>();

defineEmits<{ stop: []; resume: [] }>();

const now = ref(Date.now());
let heartbeat: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  heartbeat = setInterval(() => { now.value = Date.now(); }, 1_000);
});

onBeforeUnmount(() => {
  if (heartbeat) clearInterval(heartbeat);
});

const processingStages = [
  'parsing', 'analyzing-layout', 'building-glossary', 'translating',
  'composing', 'compiling', 'aligning', 'validating',
] as const;
const stageLabels: Record<(typeof processingStages)[number], string> = {
  parsing: '解析论文',
  'analyzing-layout': '识别版式',
  'building-glossary': '建立术语表',
  translating: '翻译正文',
  composing: '生成中文排版',
  compiling: '编译 PDF',
  aligning: '建立对齐映射',
  validating: '最终质量检查',
};

function latestEntry(types: AiLogEntry['type'][]): AiLogEntry | undefined {
  return [...props.aiLogEntries].reverse().find((entry) => types.includes(entry.type));
}

const currentStageFraction = computed(() => {
  if (props.task.stage === 'translating') {
    if (props.task.progress.total === 0) return 0;
    return Math.min(1, props.task.progress.completed / props.task.progress.total);
  }
  if (props.task.stage === 'analyzing-layout') {
    const attempt = props.task.visionAttempt;
    if (attempt?.totalPages) {
      return Math.min(0.99, Math.max(0, attempt.validatedPages / attempt.totalPages));
    }
    const entry = latestEntry(['vision-layout-page', 'vision-layout-page-phase', 'vision-layout-page-started']);
    if (!entry?.page || !entry.totalPages) return 0;
    const completed = entry.type === 'vision-layout-page' ? entry.page : entry.page - 1;
    return Math.min(0.99, Math.max(0, completed / entry.totalPages));
  }
  if (props.task.stage === 'validating') {
    if (latestEntry(['quality-persisted'])) return 0.99;
    if (latestEntry(['quality-finalizing'])) return 0.96;
    if (latestEntry(['vision-review-completed'])) return 0.94;
    const entry = latestEntry([
      'vision-review-page', 'vision-review-page-timeout', 'vision-review-page-phase',
      'vision-review-page-waiting', 'vision-review-page-started',
    ]);
    if (!entry?.page || !entry.totalPages) return 0;
    const completed = entry.type === 'vision-review-page' ? entry.page : entry.page - 1;
    return Math.min(0.92, Math.max(0, completed / entry.totalPages) * 0.92);
  }
  return 0;
});

const percentage = computed(() => {
  if (props.task.status === 'completed') return 100;
  const stageIndex = processingStages.indexOf(props.task.stage as (typeof processingStages)[number]);
  if (stageIndex < 0) return 0;
  const overall = Math.floor(((stageIndex + currentStageFraction.value) / processingStages.length) * 100);
  return Math.min(99, props.task.status === 'running' ? Math.max(1, overall) : Math.max(0, overall));
});

const progressDetail = computed(() => {
  if (props.task.stage === 'completed') return '全部阶段已完成';
  if (props.task.stage === 'translating') {
    return `翻译文本块 ${props.task.progress.completed} / ${props.task.progress.total}`;
  }
  if (props.task.stage === 'analyzing-layout') {
    const latest = latestEntry([
      'vision-correction-started', 'vision-correction-completed', 'vision-correction-stopped',
      'vision-layout-page', 'vision-layout-page-phase', 'vision-layout-page-started',
    ]);
    if (latest?.type.startsWith('vision-correction-') && latest.round && latest.page && latest.totalPages) {
      return `Exp 版式纠错 ${latest.round} / 2 · 第 ${latest.page} / ${latest.totalPages} 页 · 调用 ${latest.correctionCallsUsed ?? 0} / ${latest.maxCorrectionCalls ?? 0}`;
    }
    if (latest?.page && latest.totalPages) return `Exp 初次识别第 ${latest.page} / ${latest.totalPages} 页`;
  }
  if (props.task.stage === 'validating') {
    const repair = latestEntry(['layout-repair-started', 'layout-repair-action', 'layout-repair-completed']);
    if (repair?.attempt) return `排版自动修复 ${repair.attempt} / 2`;
    const completed = latestEntry(['vision-review-completed']);
    const pageEntry = latestEntry([
      'vision-review-page', 'vision-review-page-timeout', 'vision-review-page-phase',
      'vision-review-page-waiting', 'vision-review-page-started',
    ]);
    if (completed && pageEntry?.totalPages) {
      return `视觉质检已返回 ${completed.reviewedPages ?? 0} / ${pageEntry.totalPages} 页`;
    }
    if (pageEntry?.page && pageEntry.totalPages) return `视觉质检第 ${pageEntry.page} / ${pageEntry.totalPages} 页`;
  }
  return `当前：${stageLabels[props.task.stage as keyof typeof stageLabels] ?? '准备处理'}`;
});

const statusLabel = computed(() => ({
  idle: '等待启动', running: '运行中', pausing: '正在暂停', paused: '等待恢复',
  stopping: '正在安全停止', stopped: '已安全停止',
  failed: '需要处理', completed: '处理完成',
}[props.task.status]));
const resumeLabel = computed(() => {
  if (props.task.status === 'failed') return '继续未完成任务';
  if (props.task.status !== 'paused') return '继续处理';
  return props.task.pauseReason === 'vision-correction-budget-exhausted'
    ? '重新分析失败页面'
    : '重试网络或渲染';
});

const terminal = computed(() => ['failed', 'completed', 'stopped', 'paused'].includes(props.task.status));
const stageOrder = [
  'idle', 'parsing', 'analyzing-layout', 'building-glossary', 'translating',
  'composing', 'compiling', 'aligning', 'validating', 'completed',
];

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '正在估算';
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes} 分 ${totalSeconds % 60} 秒`;
}

const elapsed = computed(() => formatDuration(
  props.task.startedAt
    ? (terminal.value ? props.task.updatedAt : now.value) - props.task.startedAt
    : 0,
));
const remaining = computed(() => {
  if (props.task.status === 'failed') return '无法估算';
  if (props.task.status === 'stopped' || props.task.status === 'paused') return '已暂停';
  if (props.task.status === 'completed') return '0 秒';
  return formatDuration(props.estimatedRemainingMs);
});
const lastResponse = computed(() => (
  props.lastResponseAt === null
    ? props.task.status === 'failed' && stageOrder.indexOf(props.task.stage) < stageOrder.indexOf('translating')
      ? '未进入 AI 翻译'
      : props.task.status === 'failed'
        ? '未收到 AI 响应'
        : '等待首次响应'
    : new Date(props.lastResponseAt).toLocaleTimeString('zh-CN', { hour12: false })
));

const visionRegionLabel = computed(() => ({
  figure: '插图', table: '表格', display_formula: '公式', code: '代码', page: '整页',
}[props.task.visionAttempt?.regionType ?? 'page']));
const visionActionLabel = computed(() => ({
  'adjust-geometry': '调整资产边界',
  'adjust-caption': '重连或收紧标题',
  'adjust-reading-order': '验证阅读顺序候选',
  'add-or-remove-region': '增删错误区域',
}[props.task.visionAttempt?.repairAction ?? 'adjust-geometry']));
</script>

<template>
  <section class="progress-card" aria-labelledby="overall-progress">
    <div class="progress-title-row">
      <div><p class="eyebrow">CURRENT TASK</p><h1 id="overall-progress">总体进度</h1></div>
      <span class="task-status" :class="`status-${task.status}`">{{ statusLabel }}</span>
    </div>
    <div class="progress-number-row">
      <strong>{{ percentage }}%</strong><span>{{ progressDetail }}</span>
    </div>
    <div class="progress-track" role="progressbar" :aria-valuenow="percentage" aria-valuemin="0" aria-valuemax="100">
      <span :style="{ width: `${percentage}%` }" />
    </div>
    <dl class="task-metrics">
      <div><dt>已用时间</dt><dd>{{ elapsed }}</dd></div>
      <div><dt>预计剩余时间</dt><dd>{{ remaining }}</dd></div>
      <div><dt>最近响应</dt><dd>{{ lastResponse }}</dd></div>
      <div><dt>译文已通过</dt><dd>{{ task.progress.completed }}</dd></div>
      <div><dt>重试</dt><dd>{{ task.progress.retries }}</dd></div>
      <div><dt>失败</dt><dd>{{ task.progress.failed }}</dd></div>
      <div v-if="task.visionAttempt"><dt>版式纠错调用</dt><dd>{{ task.visionAttempt.correctionCallsUsed }} / {{ task.visionAttempt.maxCorrectionCalls }}</dd></div>
      <div v-if="task.visionAttempt"><dt>源视觉 token</dt><dd>{{ task.visionAttempt.promptTokens + task.visionAttempt.completionTokens }}</dd></div>
      <div v-if="task.visionAttempt?.correctionRound"><dt>本页剩余轮次</dt><dd>{{ task.visionAttempt.remainingPageRounds }}</dd></div>
      <div v-if="task.visionAttempt?.errorCode"><dt>当前版式问题</dt><dd>{{ task.visionAttempt.errorCode }}</dd></div>
    </dl>
    <section v-if="task.visionAttempt" class="vision-attempt-card" aria-label="当前视觉处理状态">
      <strong>当前视觉处理</strong>
      <dl>
        <div><dt>页面</dt><dd>{{ (task.visionAttempt.pageIndex ?? 0) + 1 }} / {{ task.visionAttempt.totalPages }}</dd></div>
        <div><dt>区域</dt><dd>{{ visionRegionLabel }}</dd></div>
        <div><dt>动作</dt><dd>{{ visionActionLabel }}</dd></div>
        <div><dt>轮次</dt><dd>{{ task.visionAttempt.correctionRound }} / 2</dd></div>
        <div><dt>页面统计</dt><dd>通过 {{ task.visionAttempt.validatedPages }} · 失败 {{ task.visionAttempt.failedPages.length }} · 缓存 {{ task.visionAttempt.cachedPages }}</dd></div>
        <div><dt>本轮 token</dt><dd>{{ (task.visionAttempt.roundPromptTokens ?? 0) + (task.visionAttempt.roundCompletionTokens ?? 0) }}</dd></div>
      </dl>
    </section>
    <button
      v-if="task.status === 'running' || task.status === 'stopping'"
      class="button danger" type="button" :disabled="task.status === 'stopping'" @click="$emit('stop')"
    >{{ task.status === 'stopping' ? '正在停止…' : '安全停止' }}</button>
    <button
      v-else-if="task.status === 'stopped' || task.status === 'paused' || task.status === 'failed'"
      class="button primary" type="button" @click="$emit('resume')"
    >{{ resumeLabel }}</button>
    <p v-if="task.status === 'running' || task.status === 'stopping' || task.status === 'stopped' || task.status === 'paused'" class="stop-note">
      停止会取消正在进行的请求，已经校验并写入的翻译缓存会保留。
    </p>
  </section>
</template>

<style scoped>
.vision-attempt-card {
  margin: 1rem 0;
  padding: 0.9rem 1rem;
  border: 1px solid var(--line, #d9e2ef);
  border-radius: 0.75rem;
  background: var(--surface-soft, #f7faff);
}

.vision-attempt-card dl {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.6rem 1rem;
  margin: 0.65rem 0 0;
}

.vision-attempt-card dt { color: var(--text-muted, #607089); font-size: 0.8rem; }
.vision-attempt-card dd { margin: 0.15rem 0 0; font-weight: 600; }
</style>
