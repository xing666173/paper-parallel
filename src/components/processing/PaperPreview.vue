<script setup lang="ts">
defineProps<{ sourceUrl?: string; translatedParagraphs?: readonly string[] }>();
</script>

<template>
  <section class="preview-card" aria-labelledby="paper-preview-title">
    <div class="panel-heading">
      <div><h2 id="paper-preview-title">论文预览</h2><p>英文原页与已通过校验的中文内容</p></div>
      <span class="preview-live"><i /> 实时更新</span>
    </div>
    <div class="paper-preview-grid">
      <article class="paper-pane">
        <header><strong>英文原文</strong><span>原始 PDF</span></header>
        <object v-if="sourceUrl" :data="sourceUrl" type="application/pdf" aria-label="英文 PDF 预览" />
        <div v-else class="paper-skeleton source-paper" aria-label="英文论文页面占位">
          <strong>Original paper</strong><i v-for="n in 12" :key="n" />
        </div>
      </article>
      <article class="paper-pane">
        <header><strong>中文译文</strong><span>已校验内容</span></header>
        <div class="paper-skeleton translated-paper">
          <template v-if="translatedParagraphs?.length">
            <p v-for="(paragraph, index) in translatedParagraphs" :key="index">{{ paragraph }}</p>
          </template>
          <template v-else>
            <strong>中文页面正在形成</strong><i v-for="n in 12" :key="n" />
          </template>
        </div>
      </article>
    </div>
    <p class="asset-note">图、表、公式与代码始终复用原论文资产，不由 AI 重绘。</p>
  </section>
</template>
