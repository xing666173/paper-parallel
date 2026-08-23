<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ReviewIssue } from '../core/review/index';

const issues = ref<ReviewIssue[]>([
  { id: 'r1', kind: 'rule', severity: 'error', blockId: 'b3', message: '数字 18.3 在译文中缺失', rule: 'R8', resolved: false },
  { id: 'r2', kind: 'ai', severity: 'warn', blockId: 'b5', message: '术语缩写建议复核', rule: 'AI', resolved: false },
]);

const unresolvedErrors = computed(() => issues.value.filter((i) => i.severity === 'error' && !i.resolved).length);
const approved = computed(() => unresolvedErrors.value === 0);

function toggle(id: string) {
  const it = issues.value.find((i) => i.id === id);
  if (it) it.resolved = !it.resolved;
}
</script>

<template>
  <main class="review">
    <h1>二次审核</h1>
    <p class="gate" :class="approved ? 'ok' : 'bad'">
      门禁:{{ approved ? '✅ 通过(所有 error 已人工消解)' : `❌ 未通过(剩余 ${unresolvedErrors} 个 error)` }}
    </p>
    <table>
      <thead><tr><th>级别</th><th>来源</th><th>规则</th><th>问题</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="i in issues" :key="i.id">
          <td :class="i.severity">{{ i.severity }}</td>
          <td>{{ i.kind }}</td>
          <td>{{ i.rule }}</td>
          <td>{{ i.message }}</td>
          <td>{{ i.resolved ? '已消解' : '待处理' }}</td>
          <td><button @click="toggle(i.id)">{{ i.resolved ? '重开' : '消解' }}</button></td>
        </tr>
      </tbody>
    </table>
    <p class="note">演示数据。真实审核问题来自规则引擎(P16)与 AI 复审(P17)。</p>
  </main>
</template>

<style scoped>
.review { max-width: 880px; margin: 32px auto; padding: 0 16px; font-family: 'Microsoft YaHei', system-ui, sans-serif; }
h1 { font-size: 20px; }
.gate { padding: 10px 12px; border-radius: 6px; font-size: 14px; }
.gate.ok { background: #e6f6ee; color: #0a7d4f; }
.gate.bad { background: #fdecea; color: #c0392b; }
table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 12px; }
th, td { border: 1px solid #d8dee6; padding: 6px 8px; text-align: left; }
th { background: #f4f6f9; }
td.error { color: #c0392b; font-weight: 700; }
td.warn { color: #b45309; font-weight: 700; }
button { padding: 4px 10px; border: 1px solid #0f4c81; border-radius: 4px; background: #fff; color: #0f4c81; cursor: pointer; }
.note { color: #8a97a5; font-size: 12px; }
</style>
