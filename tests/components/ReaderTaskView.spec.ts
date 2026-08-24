// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReaderTaskView from '../../src/views/ReaderTaskView.vue';
import { createProjectRepository } from '../../src/core/project/repository';
import { createTaskSnapshot } from '../../src/core/task/stateMachine';
import { useTaskStore } from '../../src/stores/task';

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for cache clear');
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
}

describe('phase-one reader route', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('is honest about the gate and keeps recovery actions available', async () => {
    const store = useTaskStore();
    store.current = createTaskSnapshot('reader-p1', 1);
    const repository = createProjectRepository();
    await repository.putTranslation({
      key: 'reader-p1:b1', projectId: 'reader-p1', blockId: 'b1',
      translation: '缓存译文', alignmentGroups: [], validatedAt: 1,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'upload', component: { template: '<div />' } },
        { path: '/task/:projectId/process', name: 'process', component: { template: '<div />' } },
        { path: '/task/:projectId/read', name: 'reader', component: ReaderTaskView },
      ],
    });
    await router.push('/task/reader-p1/read');
    await router.isReady();
    const wrapper = mount(defineComponent({ template: '<RouterView />' }), {
      global: { plugins: [router] },
    });

    expect(wrapper.text()).toContain('返回翻译任务');
    expect(wrapper.text()).toContain('重新选择文件');
    expect(wrapper.text()).toContain('清除翻译缓存');
    expect(wrapper.text()).toContain('排版与阅读器将在下一实施阶段接入');

    await wrapper.get('[data-action="clear-cache"]').trigger('click');
    await waitUntil(async () => (await repository.findTranslation('reader-p1:b1')) === undefined);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
