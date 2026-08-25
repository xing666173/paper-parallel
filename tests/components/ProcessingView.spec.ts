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

  it('stops live indicators when layout analysis fails before any AI request', async () => {
    const store = useTaskStore();
    store.current = {
      ...runningTask(),
      stage: 'analyzing-layout',
      status: 'running',
      progress: { completed: 0, total: 0, retries: 0, failed: 0 },
    };
    const { wrapper } = await mountView();
    await flushPromises();

    store.current = {
      ...store.current,
      status: 'failed',
      updatedAt: 5_000,
      error: '无法可靠确定图 blk-54 的不可变区域',
    };
    await flushPromises();

    expect(wrapper.text()).toContain('无法估算');
    expect(wrapper.text()).toContain('未进入 AI 翻译');
    expect(wrapper.text()).toContain('中文预览生成失败');
    expect(wrapper.text()).toContain('更新已停止');
    expect(wrapper.text()).not.toContain('等待首次响应');
    expect(wrapper.text()).not.toContain('中文页面正在形成');
    expect(wrapper.text()).not.toContain('实时更新');
  });

  it('recovers an orphaned stopping task after a page reload', async () => {
    const store = useTaskStore();
    store.current = {
      ...runningTask(),
      status: 'stopping',
      updatedAt: 4_000,
    };

    const { wrapper } = await mountView();
    await flushPromises();

    expect(store.current).toMatchObject({
      status: 'stopped',
      progress: { completed: 7, total: 20 },
    });
    expect(wrapper.get('button').text()).toBe('继续处理');
    expect(wrapper.text()).toContain('已安全停止');
    expect(wrapper.text()).not.toContain('正在停止…');
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
