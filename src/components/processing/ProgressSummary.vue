<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { TaskSnapshot } from '../../types/models';

const props = defineProps<{
  task: TaskSnapshot;
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

const percentage = computed(() => {
  if (props.task.status === 'completed') return 100;
  if (props.task.progress.total === 0) return 0;
  return Math.min(100, Math.round(
    (props.task.progress.completed / props.task.progress.total) * 100,
  ));
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
      <strong>{{ percentage }}%</strong><span>{{ task.progress.completed }} / {{ task.progress.total }} 个文本块</span>
    </div>
    <div class="progress-track" role="progressbar" :aria-valuenow="percentage" aria-valuemin="0" aria-valuemax="100">
      <span :style="{ width: `${percentage}%` }" />
    </div>
    <dl class="task-metrics">
      <div><dt>已用时间</dt><dd>{{ elapsed }}</dd></div>
      <div><dt>预计剩余</dt><dd>{{ remaining }}</dd></div>
      <div><dt>最近响应</dt><dd>{{ lastResponse }}</dd></div>
      <div><dt>已通过</dt><dd>{{ task.progress.completed }}</dd></div>
      <div><dt>重试</dt><dd>{{ task.progress.retries }}</dd></div>
      <div><dt>失败</dt><dd>{{ task.progress.failed }}</dd></div>
    </dl>
    <button
      v-if="task.status === 'running' || task.status === 'stopping'"
      class="button danger" type="button" :disabled="task.status === 'stopping'" @click="$emit('stop')"
    >{{ task.status === 'stopping' ? '正在停止…' : '安全停止' }}</button>
    <button
      v-else-if="task.status === 'stopped'"
      class="button primary" type="button" @click="$emit('resume')"
    >继续处理</button>
    <p v-if="task.status === 'running' || task.status === 'stopping' || task.status === 'stopped'" class="stop-note">
      停止会取消正在进行的请求，已经校验并写入的翻译缓存会保留。
    </p>
  </section>
</template>
