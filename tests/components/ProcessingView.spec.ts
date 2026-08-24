// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it } from 'vitest';
import ProcessingView from '../../src/views/ProcessingView.vue';
import { createTaskSnapshot, reduceTaskEvent } from '../../src/core/task/stateMachine';
import { useTaskStore } from '../../src/stores/task';

function runningTask() {
  return reduceTaskEvent(
    reduceTaskEvent(createTaskSnapshot('p1', 1_000), {
      type: 'START_TRANSLATION', total: 20, at: 2_000,
    }),
    { type: 'BLOCKS_VALIDATED', count: 7, at: 3_000 },
  );
}

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'upload', component: { template: '<div />' } },
      { path: '/task/:projectId/process', name: 'process', component: ProcessingView },
      { path: '/task/:projectId/read', name: 'reader', component: { template: '<div />' } },
    ],
  });
  await router.push('/task/p1/process');
  await router.isReady();
  const wrapper = mount(defineComponent({ template: '<RouterView />' }), {
    global: { plugins: [router] },
  });
  return { wrapper, router };
}

describe('processing dashboard', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('keeps progress visible and shows a bounded safe AI log panel', async () => {
    const store = useTaskStore();
    store.current = runningTask();
    store.throughputSamples = [
      { tokens: 100, elapsedMs: 1_000 },
      { tokens: 120, elapsedMs: 1_200 },
    ];
    store.lastResponseAt = 3_500;
    store.recordAiEvent({
      type: 'batch-started', at: 3_100, batchId: 'batch-2',
      blockIds: ['p-8', 'p-9'], modelId: 'deepseek-v4-flash',
    });

    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('总体进度');
    expect(wrapper.text()).toContain('7 / 20');
    expect(wrapper.text()).toContain('预计剩余');
    expect(wrapper.text()).toContain('AI 日志');
    expect(wrapper.text()).toContain('安全停止');
    expect(wrapper.text()).toContain('仅显示任务事件，不显示思维过程');
    expect(wrapper.text()).toContain('开始批次 batch-2');
    expect(wrapper.findAll('[data-stage]')).toHaveLength(8);
  });

  it('does not label a failed quality gate as complete', async () => {
    const store = useTaskStore();
    store.current = {
      ...runningTask(),
      stage: 'validating',
      status: 'failed',
      error: '2 个受保护标记不一致',
    };

    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.text()).not.toContain('处理完成');
    expect(wrapper.text()).toContain('2 个受保护标记不一致');
  });

  it('does not bounce a manual return when the prior completion summary is already present', async () => {
    const store = useTaskStore();
    store.current = {
      ...runningTask(), stage: 'completed', status: 'completed',
      progress: { completed: 20, total: 20, retries: 0, failed: 0 },
    };
    store.completionSummary = {
      requiredBlocks: 20, validatedBlocks: 20, failedBlocks: 0,
      protectedContentPass: true, pdfCompiled: true, assetsPass: true,
      alignmentBuilt: true, persisted: true,
    };

    const { router } = await mountView();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('process');
  });

  it('enters the reader when the current processing run produces a passing summary', async () => {
    const store = useTaskStore();
    store.current = {
      ...runningTask(), stage: 'completed', status: 'completed',
      progress: { completed: 20, total: 20, retries: 0, failed: 0 },
    };
    const { router } = await mountView();

    store.completionSummary = {
      requiredBlocks: 20, validatedBlocks: 20, failedBlocks: 0,
      protectedContentPass: true, pdfCompiled: true, assetsPass: true,
      alignmentBuilt: true, persisted: true,
    };
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('reader');
  });
});
