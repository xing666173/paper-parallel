<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ReaderView from '../components/reader/ReaderView.vue';
import { createProjectRepository, type ProjectRepository } from '../core/project/repository';
import type { AlignmentManifest } from '../core/align/manifest';
import { useTaskStore } from '../stores/task';

const props = withDefaults(defineProps<{
  repository?: ProjectRepository;
  projectIdOverride?: string;
  initialPageCounts?: { en: number; zh: number };
}>(), {
  repository: undefined,
  projectIdOverride: undefined,
  initialPageCounts: () => ({ en: 0, zh: 0 }),
});
const route = useRoute();
const router = useRouter();
const store = useTaskStore();
const repository = props.repository ?? createProjectRepository();
const projectId = props.projectIdOverride ?? String(route.params.projectId);
const loading = ref(true);
const loadError = ref('');
const actionError = ref('');
const autoNotice = ref(false);
const englishPdf = ref<Blob>();
const chinesePdf = ref<Blob>();
const manifest = ref<AlignmentManifest>();

onMounted(async () => {
  try {
    const [english, chinese, alignment] = await Promise.all([
      repository.findArtifact(`${projectId}:english-pdf`),
      repository.findArtifact(`${projectId}:chinese-pdf`),
      repository.loadAlignmentManifest(projectId),
    ]);
    if (!english?.blob) throw new Error('英文原文 PDF 不存在');
    if (!chinese?.blob) throw new Error('中文排版 PDF 不存在');
    if (!alignment) throw new Error('对齐清单不存在');
    englishPdf.value = english.blob;
    chinesePdf.value = chinese.blob;
    manifest.value = alignment;
    if (route.query.auto === '1') {
      autoNotice.value = true;
      const query = { ...route.query };
      delete query.auto;
      await router.replace({ query });
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
});

async function clearCache() {
  if (!window.confirm(`确定清除当前论文“${projectId}”的翻译缓存吗？英文原始 PDF 会保留。`)) return;
  await repository.clearProjectDerivedData(projectId);
  if (store.current?.projectId === projectId) store.current = await repository.loadTask(projectId) ?? null;
  await router.push({ name: 'upload', query: { cleared: projectId } });
}

async function downloadPackage() {
  actionError.value = '';
  const artifact = await repository.findArtifact(`${projectId}:project-package`);
  if (!artifact) {
    actionError.value = '项目包尚未生成，请返回翻译任务检查完成状态。';
    return;
  }
  const url = URL.createObjectURL(artifact.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${projectId}.paper-parallel.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <main class="reader-task-page">
    <p v-if="autoNotice" class="reader-notice" role="status">翻译排版完成，已自动进入对照阅读</p>
    <div v-if="loading" class="reader-state">正在加载本地 PDF 与对齐清单…</div>
    <section v-else-if="loadError || !englishPdf || !chinesePdf || !manifest" class="reader-state" role="alert">
      <h1>无法打开对照阅读</h1><p>{{ loadError }}</p>
      <button type="button" @click="router.push({ name: 'process', params: { projectId } })">返回翻译任务</button>
    </section>
    <template v-else>
      <p v-if="actionError" class="reader-action-error" role="alert">{{ actionError }}</p>
      <ReaderView
        :english-pdf="englishPdf" :chinese-pdf="chinesePdf" :manifest="manifest"
        :initial-page-counts="initialPageCounts" :chinese-filename="`${projectId}-zh.pdf`"
        @return="router.push({ name: 'process', params: { projectId } })"
        @choose="router.push({ name: 'upload' })" @clear="clearCache"
        @download-package="downloadPackage" @error="actionError = $event"
      />
    </template>
  </main>
</template>

<style scoped>
.reader-task-page { min-height: calc(100vh - 70px); }
.reader-notice { margin: 0; padding: 9px 18px; color: #166534; background: #dcfce7; border-bottom: 1px solid #86efac; }
.reader-state { max-width: 720px; margin: 80px auto; padding: 28px; border: 1px solid #dbe3ec; border-radius: 14px; background: #fff; }
.reader-action-error { margin: 0; padding: 8px 16px; color: #b42318; background: #fff1f0; }
</style>
