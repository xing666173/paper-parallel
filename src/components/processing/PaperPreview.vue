<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';

export type PreviewState = 'empty' | 'building' | 'ready' | 'failed';
const props = withDefaults(defineProps<{
  sourceUrl?: string;
  previewUrl?: string;
  previewState?: PreviewState;
  translatedParagraphs?: readonly string[];
}>(), { previewState: 'empty' });

const validSourceUrl = computed(() => props.sourceUrl?.startsWith('blob:') === true);
const validPreviewUrl = computed(() => props.previewUrl?.startsWith('blob:') === true);
const updateLabel = computed(() => props.previewState === 'failed' ? '更新已停止' : '实时更新');

function revoke(url?: string): void {
  if (url?.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

watch(() => props.previewUrl, (_current, previous) => revoke(previous));
onBeforeUnmount(() => revoke(props.previewUrl));
</script>

<template>
  <section class="preview-card" aria-labelledby="paper-preview-title">
    <div class="panel-heading">
      <div><h2 id="paper-preview-title">论文预览</h2><p>英文原页与已通过校验的中文内容</p></div>
      <span class="preview-live" :class="{ stopped: previewState === 'failed' }"><i /> {{ updateLabel }}</span>
    </div>
    <div class="paper-preview-grid">
      <article class="paper-pane">
        <header><strong>英文原文</strong><span>原始 PDF</span></header>
        <object v-if="validSourceUrl" :data="sourceUrl" type="application/pdf" aria-label="英文 PDF 预览" />
        <div v-else class="paper-skeleton source-paper" aria-label="英文论文页面占位">
          <strong>Original paper</strong><i v-for="n in 12" :key="n" />
        </div>
      </article>
      <article class="paper-pane">
        <header><strong>中文译文</strong><span>已校验内容</span></header>
        <object
          v-if="previewState === 'ready' && validPreviewUrl"
          :data="previewUrl"
          type="image/svg+xml"
          aria-label="中文 Typst 编译预览"
        />
        <div v-else class="paper-skeleton translated-paper">
          <strong v-if="previewState === 'ready'">预览地址无效</strong>
          <strong v-else-if="previewState === 'building'">正在生成中文排版预览</strong>
          <strong v-else-if="previewState === 'failed'">中文预览生成失败</strong>
          <template v-else-if="translatedParagraphs?.length">
            <p v-for="(paragraph, index) in translatedParagraphs" :key="index">{{ paragraph }}</p>
          </template>
          <template v-else-if="previewState === 'empty'">
            <strong>中文页面正在形成</strong><i v-for="n in 12" :key="n" />
          </template>
        </div>
      </article>
    </div>
    <p class="asset-note">图、表、公式与代码始终复用原论文资产，不由 AI 重绘。</p>
  </section>
</template>
