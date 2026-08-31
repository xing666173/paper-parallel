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
  idle: '等待启动', running: '运行中', stopping: '正在安全停止', stopped: '已安全停止',
  failed: '需要处理', completed: '处理完成',
}[props.task.status]));

const terminal = computed(() => ['failed', 'completed', 'stopped'].includes(props.task.status));
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
  if (props.task.status === 'stopped') return '已暂停';
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
    </dl>
    <button
      v-if="task.status === 'running' || task.status === 'stopping'"
      class="button danger" type="button" :disabled="task.status === 'stopping'" @click="$emit('stop')"
    >{{ task.status === 'stopping' ? '正在停止…' : '安全停止' }}</button>
    <button
      v-else-if="task.status === 'stopped' || task.status === 'failed'"
      class="button primary" type="button" @click="$emit('resume')"
    >{{ task.status === 'failed' ? '继续未完成任务' : '继续处理' }}</button>
    <p v-if="task.status === 'running' || task.status === 'stopping' || task.status === 'stopped'" class="stop-note">
      停止会取消正在进行的请求，已经校验并写入的翻译缓存会保留。
    </p>
  </section>
</template>
