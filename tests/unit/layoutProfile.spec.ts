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
      error: '旧错误',
      pauseReason: 'vision-correction-budget-exhausted' as const,
      visionAttempt: {
        phase: 'correction-local-crop' as const, failedPages: [2], correctionCallsUsed: 2,
        maxCorrectionCalls: 2, validatedPages: 1, cachedPages: 0,
        totalPages: 3, correctionRound: 2 as const, remainingPageRounds: 0,
        promptTokens: 100, completionTokens: 20,
      },
      settings: {
        modelId: 'deepseek-v4-flash', thinkingMode: 'enabled' as const,
        sourceFileName: 'paper.pdf', sourceFileHash: 'hash',
        maxVisionCorrectionCalls: 2,
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
    expect(reset.error).toBeUndefined();
    expect(reset.pauseReason).toBeUndefined();
    expect(reset.visionAttempt).toBeUndefined();
    expect(reset.settings?.maxVisionCorrectionCalls).toBeUndefined();
    expect(usesCurrentSingleColumnLayout(reset)).toBe(true);
  });
});
