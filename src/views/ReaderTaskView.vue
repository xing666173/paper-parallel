<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ReaderView from '../components/reader/ReaderView.vue';
import { createProjectRepository, type ProjectRepository } from '../core/project/repository';
import type { AlignmentManifest } from '../core/align/manifest';
import { useTaskStore } from '../stores/task';
import { buildProjectPackage } from '../core/project/package';
import type { TaskSnapshot } from '../types/models';
import type { QualityReport } from '../core/quality/report';
import { resetTaskForSingleColumnLayout, usesCurrentSingleColumnLayout } from '../core/layout/profile';

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
const task = ref<TaskSnapshot>();
const qualityReport = ref<QualityReport>();
const currentSingleColumn = computed(() => usesCurrentSingleColumnLayout(task.value));

onMounted(async () => {
  try {
    const [english, chinese, alignment, loadedTask, reportArtifact] = await Promise.all([
      repository.findArtifact(`${projectId}:english-pdf`),
      repository.findArtifact(`${projectId}:chinese-pdf`),
      repository.loadAlignmentManifest(projectId),
      repository.loadTask(projectId),
      repository.findArtifact(`${projectId}:quality-report`),
    ]);
    if (!english?.blob) throw new Error('英文原文 PDF 不存在');
    if (!chinese?.blob) throw new Error('中文排版 PDF 不存在');
    if (!alignment) throw new Error('对齐清单不存在');
    englishPdf.value = english.blob;
    chinesePdf.value = chinese.blob;
    manifest.value = alignment;
    task.value = loadedTask;
    qualityReport.value = reportArtifact
      ? JSON.parse(await reportArtifact.blob.text()) as QualityReport
      : undefined;
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

function hasApiKey(): boolean {
  return Boolean(
    sessionStorage.getItem('paper-parallel.deepseek-key-session')?.trim()
    || localStorage.getItem('paper-parallel.deepseek-key')?.trim(),
  );
}

async function reflowWithCurrentLayout() {
  actionError.value = '';
  if (!task.value) {
    actionError.value = '该历史结果缺少任务设置，请重新选择英文 PDF。';
    return;
  }
  if (!hasApiKey()) {
    actionError.value = '按新版重新排版仍需 DeepSeek 逐页质检，请先返回上传页验证 API Key。';
    return;
  }
  try {
    await repository.clearProjectLayoutOutputs(projectId);
    const reset = resetTaskForSingleColumnLayout(task.value);
    await repository.saveTask(reset);
    store.current = reset;
    await router.push({ name: 'process', params: { projectId } });
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '新版重新排版启动失败';
  }
}

async function downloadPackage() {
  actionError.value = '';
  try {
    let artifact = await repository.findArtifact(`${projectId}:project-package`);
    if (!artifact) {
      const blob = await buildProjectPackage(projectId, repository);
      artifact = {
        key: `${projectId}:project-package`, projectId, kind: 'project-package',
        blob, updatedAt: Date.now(),
      };
      await repository.putArtifact(artifact);
    }
    const url = URL.createObjectURL(artifact.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${projectId}.paper-parallel.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '项目包生成失败';
  }
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
      <p v-if="qualityReport" class="reader-quality-summary">
        {{ qualityReport.pass ? '逐页质检通过' : '逐页质检未通过' }} ·
        {{ qualityReport.attempts.at(-1)?.reviewedPages ?? 0 }} 页 ·
        {{ Math.max(0, qualityReport.attempts.length - 1) }} 轮自动修复
      </p>
      <ReaderView
        :english-pdf="englishPdf" :chinese-pdf="chinesePdf" :manifest="manifest"
        :initial-page-counts="initialPageCounts" :chinese-filename="`${projectId}-zh.pdf`"
        :layout-label="currentSingleColumn ? '中文单栏版' : '旧版排版'"
        :show-reflow="!currentSingleColumn"
        @return="router.push({ name: 'process', params: { projectId } })"
        @choose="router.push({ name: 'upload' })" @clear="clearCache"
        @reflow="reflowWithCurrentLayout"
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
.reader-quality-summary { margin: 0; padding: 8px 16px; color: #245b91; background: #eef6ff; border-bottom: 1px solid #cfe0f5; font-size: 12px; }
</style>
