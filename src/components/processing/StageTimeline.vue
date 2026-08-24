<script setup lang="ts">
import { computed } from 'vue';
import type { TaskSnapshot, TaskStage } from '../../types/models';

const props = defineProps<{ task: TaskSnapshot }>();
const stages: { stage: TaskStage; label: string; detail: string }[] = [
  { stage: 'parsing', label: '解析论文', detail: '提取文字与页面结构' },
  { stage: 'analyzing-layout', label: '识别版式', detail: '识别单栏、双栏与混合区域' },
  { stage: 'building-glossary', label: '建立术语表', detail: '统一全文专业术语' },
  { stage: 'translating', label: '翻译正文', detail: '批次翻译并校验保护内容' },
  { stage: 'composing', label: '生成中文排版', detail: '继承原文区域与资产顺序' },
  { stage: 'compiling', label: '编译 PDF', detail: '在浏览器中生成中文 PDF' },
  { stage: 'aligning', label: '建立对齐映射', detail: '构建连续语义组锚点' },
  { stage: 'validating', label: '质量检查', detail: '核对内容、资产与映射' },
];
const currentIndex = computed(() => stages.findIndex((item) => item.stage === props.task.stage));
function visualState(index: number): 'completed' | 'current' | 'pending' {
  if (props.task.status === 'completed') return 'completed';
  if (index < currentIndex.value) return 'completed';
  if (index === currentIndex.value) return 'current';
  return 'pending';
}
</script>

<template>
  <section class="timeline-card" aria-labelledby="task-stages">
    <div class="panel-heading"><h2 id="task-stages">任务进度</h2><span>8 个阶段</span></div>
    <ol class="stage-timeline">
      <li v-for="(item, index) in stages" :key="item.stage" data-stage :class="`is-${visualState(index)}`">
        <span class="stage-marker">{{ visualState(index) === 'completed' ? '✓' : index + 1 }}</span>
        <div><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></div>
      </li>
    </ol>
  </section>
</template>
