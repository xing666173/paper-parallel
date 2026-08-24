<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { AiLogEntry } from '../../stores/task';

const props = defineProps<{ entries: readonly AiLogEntry[] }>();
const autoScroll = ref(true);
const logList = ref<HTMLElement | null>(null);
const copied = ref(false);

watch(() => props.entries.length, async () => {
  if (!autoScroll.value) return;
  await nextTick();
  logList.value?.scrollTo({ top: logList.value.scrollHeight });
});

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}

async function copyLog(): Promise<void> {
  const text = props.entries.map((entry) => `[${formatTime(entry.at)}] ${entry.message}`).join('\n');
  await navigator.clipboard?.writeText(text);
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1_500);
}
</script>

<template>
  <section class="ai-log-card" aria-labelledby="ai-log-title">
    <div class="panel-heading log-heading">
      <div><h2 id="ai-log-title">AI 日志</h2><p>仅显示任务事件，不显示思维过程</p></div>
      <button class="text-button" type="button" @click="copyLog">{{ copied ? '已复制' : '复制' }}</button>
    </div>
    <div ref="logList" class="ai-log-list" aria-live="polite">
      <p v-if="entries.length === 0" class="empty-log">等待第一个 AI 任务事件…</p>
      <div v-for="(entry, index) in entries" :key="`${entry.at}-${index}`" class="log-entry">
        <time>{{ formatTime(entry.at) }}</time><span>{{ entry.message }}</span>
      </div>
    </div>
    <label class="auto-scroll"><input v-model="autoScroll" type="checkbox"> 自动滚动到最新事件</label>
  </section>
</template>
