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
      props: { task, estimatedRemainingMs: null, lastResponseAt: null },
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
      props: { task, estimatedRemainingMs: null, lastResponseAt: null },
    });

    expect(wrapper.get('button').text()).toContain('继续未完成任务');
    expect(wrapper.text()).toContain('7 / 10');
  });
});
