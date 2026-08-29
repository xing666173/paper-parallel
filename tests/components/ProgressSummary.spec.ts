// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProgressSummary from '../../src/components/processing/ProgressSummary.vue';
import { createTaskSnapshot, reduceTaskEvent } from '../../src/core/task/stateMachine';

describe('processing progress heartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('updates elapsed time every second while a task is running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const task = reduceTaskEvent(createTaskSnapshot('p1', 1_000), {
      type: 'START_TRANSLATION', total: 10, at: 1_000,
    });
    const wrapper = mount(ProgressSummary, {
      props: { task, aiLogEntries: [], estimatedRemainingMs: null, lastResponseAt: null },
    });

    expect(wrapper.text()).toContain('1 秒');
    expect(wrapper.text()).toContain('预计剩余时间');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(wrapper.text()).toContain('3 秒');
  });

  it('offers recovery for a failed task with validated work preserved', () => {
    const task = {
      ...reduceTaskEvent(createTaskSnapshot('p1', 1_000), {
        type: 'START_TRANSLATION', total: 10, at: 1_000,
      }),
      status: 'failed' as const,
      progress: { completed: 7, total: 10, retries: 1, failed: 1 },
      error: 'one block failed',
    };
    const wrapper = mount(ProgressSummary, {
      props: { task, aiLogEntries: [], estimatedRemainingMs: null, lastResponseAt: null },
    });

    expect(wrapper.get('button').text()).toContain('继续未完成任务');
    expect(wrapper.text()).toContain('7 / 10');
  });

  it('keeps overall progress below completion after translation and advances during final review', async () => {
    const translated = {
      ...createTaskSnapshot('p1', 1_000),
      stage: 'translating' as const,
      status: 'running' as const,
      progress: { completed: 10, total: 10, retries: 0, failed: 0 },
      startedAt: 1_000,
      updatedAt: 2_000,
    };
    const wrapper = mount(ProgressSummary, {
      props: { task: translated, aiLogEntries: [], estimatedRemainingMs: null, lastResponseAt: null },
    });

    expect(wrapper.text()).toContain('50%');
    expect(wrapper.text()).toContain('翻译文本块 10 / 10');

    await wrapper.setProps({
      task: { ...translated, stage: 'validating' as const },
      aiLogEntries: [{
        at: 3_000, type: 'vision-review-page', page: 12, totalPages: 24,
        message: 'Vision Exp 成品质检：第 12/24 页已完成，发现 0 个可见问题',
      }],
    });
    expect(wrapper.text()).toContain('93%');
    expect(wrapper.text()).toContain('视觉质检第 12 / 24 页');
    expect(wrapper.text()).not.toContain('100%');
  });
});
