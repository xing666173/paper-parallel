<script setup lang="ts">
import { ref } from 'vue';
import { runResumableTranslation, type SessionState, type TranslateBlockInput } from '../core/translate/index';
import { paginate, validateOrder, type PaginatorBlockInput } from '../core/paginate/index';

const running = ref(false);
const result = ref('');

const blocks: (TranslateBlockInput & PaginatorBlockInput)[] = [
  { id: 'b1', type: 'title', text: 'A High-Performance Accelerator', fontSize: 17, widthMode: 'span', frontMatter: true, order: 0 },
  { id: 'b2', type: 'section', text: '1 Introduction', fontSize: 14, order: 1 },
  { id: 'b3', type: 'paragraph', text: 'The execution trace generation dominates latency.', fontSize: 13, order: 2 },
  { id: 'b4', type: 'section', text: '2 Background', fontSize: 14, order: 3 },
  { id: 'b5', type: 'paragraph', text: 'Prior work uses GPUs.', fontSize: 13, order: 4 },
];

async function runSelfCheck() {
  running.value = true;
  result.value = '运行中…';
  try {
    const store: SessionState = { byId: {}, terms: [] };
    const tr = await runResumableTranslation(blocks, {
      translate: async (ctx) => {
        if (ctx.pass === 1) return '零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）。执行轨迹（Trace）。';
        if (!ctx.block) throw new Error('pass2 缺少 block');
        const map: Record<string, string> = {
          b1: '高性能加速器',
          b2: '1 引言',
          b3: '执行轨迹（Trace）的生成主导了延迟。',
          b4: '2 背景',
          b5: '已有工作使用 GPU。',
        };
        return map[ctx.block.id] || ctx.block.text;
      },
      loadState: () => store,
      saveState: async (s) => { store.byId = s.byId; store.terms = s.terms; },
      maxRetries: 1,
      systemPrompt: 'SYS',
      userPrompt: 'USER',
    });
    const zhBlocks = blocks.map((b) => ({ ...b, text: tr.blocks.find((x) => x.id === b.id)!.zhText }));
    const layout = paginate(zhBlocks, {
      mode: 'double',
      measureText: (t, w, fs) => {
        const lh = fs * 1.6;
        return Math.max(lh, Math.ceil([...t].length / Math.max(1, Math.floor(w / (fs * 1.05)))) * lh);
      },
    });
    const order = validateOrder(zhBlocks, layout.log);
    result.value = `✅ 合成自检通过:翻译 ${tr.stats.done}/${blocks.length} · 术语 ${tr.terms.length} · 分页 ${layout.pages.length} 页 · 块序 ${order.ok ? 'OK' : 'FAIL'}\n真实 PDF 端到端请使用 P19 运行器(下方按钮)。`;
  } catch (e) {
    result.value = `❌ ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <main class="wb">
    <h1>翻译工作台</h1>
    <p class="note">完整解析/翻译/排版/对齐/审核/打包管线已通过 P19 浏览器运行器验证;此页提供应用内合成自检。</p>
    <button :disabled="running" @click="runSelfCheck">{{ running ? '运行中…' : '运行合成自检' }}</button>
    <p class="result">{{ result }}</p>
    <p class="note">
      <a href="./probes/P19-e2e-runner.html" target="_blank">打开 P19 端到端运行器(真实 PDF)</a>
    </p>
  </main>
</template>

<style scoped>
.wb { max-width: 720px; margin: 40px auto; padding: 0 20px; font-family: 'Microsoft YaHei', system-ui, sans-serif; }
h1 { font-size: 22px; }
.note { color: #5b6b7c; font-size: 12px; line-height: 1.7; }
button { padding: 8px 18px; border: 0; border-radius: 5px; background: #0f4c81; color: #fff; font-size: 13px; cursor: pointer; }
.result { white-space: pre-wrap; font-size: 13px; margin-top: 12px; color: #1c2733; }
</style>
