// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import ReaderTaskView from '../../src/views/ReaderTaskView.vue';
import type { ProjectRepository } from '../../src/core/project/repository';

describe('completed dual-PDF reader route', () => {
  it('shows independent counts and every task action', async () => {
    const repository = readerRepository();
    const { wrapper } = await mountReader(repository);

    expect(wrapper.text()).toContain('英文 1 / 8');
    expect(wrapper.text()).toContain('中文 1 / 11');
    expect(wrapper.text()).toContain('返回翻译任务');
    expect(wrapper.text()).toContain('重新选择文件');
    expect(wrapper.text()).toContain('清除翻译缓存');
    expect(wrapper.text()).toContain('下载中文 PDF');
    expect(wrapper.text()).toContain('下载项目包');
    expect(wrapper.find('.blk').exists()).toBe(false);
  });

  it('requires confirmation before clearing only the current project cache', async () => {
    const repository = readerRepository();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { wrapper } = await mountReader(repository);

    await wrapper.get('[data-action="clear-cache"]').trigger('click');
    expect(repository.clearProjectDerivedData).not.toHaveBeenCalled();
  });

  it('shows the automatic navigation notice once and removes auto query state', async () => {
    const repository = readerRepository();
    const { wrapper, router } = await mountReader(repository, true);
    expect(wrapper.text()).toContain('翻译排版完成，已自动进入对照阅读');
    expect(router.currentRoute.value.query.auto).toBeUndefined();
  });
});

async function mountReader(repository: ProjectRepository, auto = false) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'upload', component: { template: '<div />' } },
      { path: '/task/:projectId/process', name: 'process', component: { template: '<div />' } },
      { path: '/task/:projectId/read', name: 'reader', component: ReaderTaskView },
    ],
  });
  await router.push(`/task/p1/read${auto ? '?auto=1' : ''}`);
  await router.isReady();
  const wrapper = mount(ReaderTaskView, {
    props: { repository, projectIdOverride: 'p1', initialPageCounts: { en: 8, zh: 11 } },
    global: {
      plugins: [router, createPinia()],
      stubs: { PdfPane: { template: '<div class="pdf-pane-stub" />' } },
    },
  });
  await flushPromises();
  return { wrapper, router };
}

function readerRepository(): ProjectRepository {
  const artifacts = new Map([
    ['p1:english-pdf', { key: 'p1:english-pdf', projectId: 'p1', kind: 'english-pdf', blob: new Blob(['%PDF-en']), updatedAt: 1 }],
    ['p1:chinese-pdf', { key: 'p1:chinese-pdf', projectId: 'p1', kind: 'chinese-pdf', blob: new Blob(['%PDF-zh']), updatedAt: 1 }],
  ]);
  return {
    saveTask: vi.fn(),
    loadTask: vi.fn(async () => undefined),
    putTranslation: vi.fn(),
    findTranslation: vi.fn(),
    clearProjectTranslation: vi.fn(),
    putArtifact: vi.fn(),
    findArtifact: vi.fn(async (key: string) => artifacts.get(key)),
    saveAlignmentManifest: vi.fn(),
    loadAlignmentManifest: vi.fn(async () => ({
      schemaVersion: 1, projectId: 'p1', createdAt: 1, units: [],
      stats: { total: 0, aligned: 0, lowConfidence: 0, unmatched: 0, coverage: 1 },
    })),
    clearProjectDerivedData: vi.fn(),
    listProjectTranslations: vi.fn(async () => []),
    listProjectArtifacts: vi.fn(async () => [...artifacts.values()]),
    saveAiLog: vi.fn(async () => undefined),
    loadAiLog: vi.fn(async () => []),
    clearAiLog: vi.fn(async () => undefined),
  } as ProjectRepository;
}
