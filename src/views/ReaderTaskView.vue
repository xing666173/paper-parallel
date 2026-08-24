<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { createProjectRepository } from '../core/project/repository';
import { useTaskStore } from '../stores/task';

const route = useRoute();
const store = useTaskStore();
const repository = createProjectRepository();
const projectId = String(route.params.projectId);
const cacheCleared = ref(false);

onMounted(async () => {
  if (store.current?.projectId !== projectId) {
    store.current = await repository.loadTask(projectId) ?? null;
  }
});

async function clearCache(): Promise<void> {
  if (!window.confirm('确定清除当前论文的翻译缓存吗？原始 PDF 不会被删除。')) return;
  if (store.current?.projectId === projectId) await store.clearTranslationCache();
  else await repository.clearProjectTranslation(projectId);
  cacheCleared.value = true;
}
</script>

<template>
  <main class="reader-gate-page">
    <section class="reader-gate-card">
      <p class="eyebrow">BILINGUAL READER</p>
      <h1>对照阅读</h1>
      <p class="reader-gate-message">排版与阅读器将在下一实施阶段接入</p>
      <p>当前页面不会用文本卡片冒充中文 PDF。只有中文 PDF、不可变资产和对齐映射全部通过检查后，才会开放左右对照阅读。</p>
      <div class="reader-actions">
        <RouterLink class="button primary action-link" :to="{ name: 'process', params: { projectId } }">返回翻译任务</RouterLink>
        <RouterLink class="button secondary action-link" to="/">重新选择文件</RouterLink>
        <button class="button danger" data-action="clear-cache" type="button" @click="clearCache">清除翻译缓存</button>
      </div>
      <p v-if="cacheCleared" class="cache-cleared" role="status">当前论文的翻译缓存已清除，原始 PDF 已保留。</p>
    </section>
  </main>
</template>
