<script setup lang="ts">
defineProps<{
  enPage: number; enPageCount: number; zhPage: number; zhPageCount: number;
  enZoom: number; zhZoom: number; syncEnabled: boolean; highlightsEnabled: boolean;
}>();
const emit = defineEmits<{
  return: []; choose: []; clear: []; 'download-chinese': []; 'download-package': [];
  'page-step': [side: 'en' | 'zh', delta: number];
  'zoom-step': [side: 'en' | 'zh', delta: number];
  'fit-width': [side: 'en' | 'zh'];
  'update:syncEnabled': [enabled: boolean]; 'update:highlightsEnabled': [enabled: boolean];
}>();
</script>

<template>
  <header class="reader-toolbar">
    <div class="task-actions">
      <button type="button" @click="emit('return')">返回翻译任务</button>
      <button type="button" @click="emit('choose')">重新选择文件</button>
      <button class="danger-action" data-action="clear-cache" type="button" @click="emit('clear')">清除翻译缓存</button>
    </div>
    <div class="document-controls">
      <div class="side-controls" aria-label="英文 PDF 控制">
        <strong>英文 {{ enPage + 1 }} / {{ enPageCount }}</strong>
        <button type="button" :disabled="enPage <= 0" @click="emit('page-step', 'en', -1)">上一页</button>
        <button type="button" :disabled="enPage + 1 >= enPageCount" @click="emit('page-step', 'en', 1)">下一页</button>
        <button type="button" @click="emit('zoom-step', 'en', -0.1)">−</button><span>{{ Math.round(enZoom * 100) }}%</span>
        <button type="button" @click="emit('zoom-step', 'en', 0.1)">+</button>
        <button type="button" @click="emit('fit-width', 'en')">适合宽度</button>
      </div>
      <div class="side-controls" aria-label="中文 PDF 控制">
        <strong>中文 {{ zhPage + 1 }} / {{ zhPageCount }}</strong>
        <button type="button" :disabled="zhPage <= 0" @click="emit('page-step', 'zh', -1)">上一页</button>
        <button type="button" :disabled="zhPage + 1 >= zhPageCount" @click="emit('page-step', 'zh', 1)">下一页</button>
        <button type="button" @click="emit('zoom-step', 'zh', -0.1)">−</button><span>{{ Math.round(zhZoom * 100) }}%</span>
        <button type="button" @click="emit('zoom-step', 'zh', 0.1)">+</button>
        <button type="button" @click="emit('fit-width', 'zh')">适合宽度</button>
      </div>
    </div>
    <div class="reader-options">
      <label><input :checked="syncEnabled" type="checkbox" @change="emit('update:syncEnabled', ($event.target as HTMLInputElement).checked)"> 同步滚动</label>
      <label><input :checked="highlightsEnabled" type="checkbox" @change="emit('update:highlightsEnabled', ($event.target as HTMLInputElement).checked)"> 对应高亮</label>
      <button type="button" @click="emit('download-chinese')">下载中文 PDF</button>
      <button type="button" @click="emit('download-package')">下载项目包</button>
    </div>
  </header>
</template>

<style scoped>
.reader-toolbar { display: grid; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #dbe3ec; background: #fff; }
.task-actions,.reader-options,.side-controls,.document-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.document-controls { justify-content: space-between; }.reader-options { justify-content: flex-end; }
button { min-height: 32px; padding: 0 10px; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; color: #334155; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .45; }.danger-action { color: #b42318; border-color: #f2b8b5; }
@media (max-width: 1000px) { .document-controls { align-items: flex-start; flex-direction: column; }.reader-options { justify-content: flex-start; } }
</style>
