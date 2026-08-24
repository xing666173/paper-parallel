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
    await vi.advanceTimersByTimeAsync(2_000);
    expect(wrapper.text()).toContain('3 秒');
  });
});
