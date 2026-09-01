import { describe, expect, it } from 'vitest';
import { preserveSourceLayoutRunHistory, type SourceLayoutQualityReport } from '../../src/core/quality/report';

function report(index: number): SourceLayoutQualityReport {
  return {
    schemaVersion: 2, runStartedAt: index, completedAt: index + 1, pass: false,
    pagePlans: [], initialAnalysisCalls: 2, initialPromptTokens: 10, initialCompletionTokens: 3,
    correctionCallsUsed: 1, maxCorrectionCalls: 2, promptTokens: 20, completionTokens: 5,
    correctionAttempts: [{
      pageIndex: 3, round: 1, basePlanVersion: `p-${index}`,
      errorFingerprints: ['caption-overlap'], outcome: 'request-failed',
      networkAttempts: 1, promptTokens: 10, completionTokens: 2,
    }],
    unresolvedIssues: [{
      pageIndex: 3, code: 'source-plan.caption-overlap', reason: 'overlap', fingerprint: 'p3-overlap',
    }],
    crossPageAssetGroups: [],
  };
}

describe('source layout diagnostic history', () => {
  it('preserves failed correction evidence across a new page-analysis run', () => {
    const previous = report(10);
    const history = preserveSourceLayoutRunHistory(previous, 99);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      runStartedAt: 10, pass: false, correctionCallsUsed: 1,
      correctionAttempts: [{ outcome: 'request-failed' }],
      unresolvedIssues: [{ pageIndex: 3 }],
    });
    history[0]!.correctionAttempts[0]!.errorFingerprints.push('mutated');
    expect(previous.correctionAttempts[0]!.errorFingerprints).toEqual(['caption-overlap']);
  });

  it('keeps only the bounded most recent history', () => {
    const previous = report(10);
    previous.runHistory = Array.from({ length: 8 }, (_, index) => ({
      ...preserveSourceLayoutRunHistory(report(index), index)[0]!,
    }));
    const history = preserveSourceLayoutRunHistory(previous, 99, 8);
    expect(history).toHaveLength(8);
    expect(history.at(-1)?.runStartedAt).toBe(10);
    expect(history[0]?.runStartedAt).toBe(1);
  });
});
