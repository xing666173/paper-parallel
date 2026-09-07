// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { expect, it, vi } from 'vitest';
import ProcessingView from '../../src/views/ProcessingView.vue';
import { createProjectRepository } from '../../src/core/project/repository';
import { createTaskSnapshot, reduceTaskEvent } from '../../src/core/task/stateMachine';
import { useTaskStore } from '../../src/stores/task';

it('restores an unowned running task as stopped with its validated progress and a resume action', async () => {
  setActivePinia(createPinia());
  const repository = createProjectRepository();
  const snapshot = reduceTaskEvent(createTaskSnapshot('reload-running'), { type: 'START_TRANSLATION', total: 20, at: 2_000 });
  await repository.saveTask({ ...snapshot, progress: { completed: 7, total: 20, retries: 2, failed: 0 } });
  const store = useTaskStore();
  const start = vi.spyOn(store, 'start');
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/task/:projectId/process', component: ProcessingView },
    ],
  });
  await router.push('/task/reload-running/process');
  await router.isReady();
  const wrapper = mount(defineComponent({ template: '<RouterView />' }), { global: { plugins: [router] } });
  for (let round = 0; round < 12; round += 1) await flushPromises();
  expect(store.current).toMatchObject({ status: 'stopped', progress: { completed: 7, retries: 2 } });
  expect(store.abortController).toBeNull();
  expect(start).not.toHaveBeenCalled();
  expect(wrapper.text()).toContain('继续处理');
  expect(wrapper.text()).not.toContain('运行中');
  expect(await repository.loadTask('reload-running')).toMatchObject({ status: 'stopped', progress: { completed: 7 } });
  wrapper.unmount();
});
