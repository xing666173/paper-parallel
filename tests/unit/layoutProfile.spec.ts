import { describe, expect, it } from 'vitest';
import { createTaskSnapshot } from '../../src/core/task/stateMachine';
import {
  CURRENT_LAYOUT_PROFILE,
  resetTaskForSingleColumnLayout,
  usesCurrentSingleColumnLayout,
} from '../../src/core/layout/profile';

describe('single-column layout profile', () => {
  it('keeps missing profile fields identifiable as a legacy task', () => {
    const legacy = {
      ...createTaskSnapshot('legacy', 1),
      settings: {
        modelId: 'deepseek-v4-flash', thinkingMode: 'disabled' as const,
        sourceFileName: 'paper.pdf', sourceFileHash: 'hash',
      },
    };
    expect(usesCurrentSingleColumnLayout(legacy)).toBe(false);
  });

  it('resets an existing task without changing its source or translation identity', () => {
    const task = {
      ...createTaskSnapshot('p1', 1),
      stage: 'completed' as const, status: 'completed' as const, startedAt: 2,
      settings: {
        modelId: 'deepseek-v4-flash', thinkingMode: 'enabled' as const,
        sourceFileName: 'paper.pdf', sourceFileHash: 'hash',
      },
    };
    const reset = resetTaskForSingleColumnLayout(task, 10);
    expect(reset).toMatchObject({
      projectId: 'p1', stage: 'idle', status: 'idle', updatedAt: 10,
      settings: {
        sourceFileHash: 'hash', targetLayoutPolicy: 'single-column',
        layoutProfileVersion: CURRENT_LAYOUT_PROFILE,
      },
    });
    expect(reset.startedAt).toBeUndefined();
    expect(usesCurrentSingleColumnLayout(reset)).toBe(true);
  });
});
