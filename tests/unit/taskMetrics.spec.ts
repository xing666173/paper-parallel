import { describe, expect, it } from 'vitest';
import { estimateRemainingMs } from '../../src/core/task/metrics';

describe('task ETA', () => {
  it('returns null until two valid throughput samples exist', () => {
    expect(estimateRemainingMs([], 1000)).toBeNull();
    expect(estimateRemainingMs([{ tokens: 100, elapsedMs: 2000 }], 1000)).toBeNull();
    expect(estimateRemainingMs([
      { tokens: 0, elapsedMs: 100 },
      { tokens: 100, elapsedMs: 0 },
    ], 1000)).toBeNull();
  });

  it('uses the median of at most the eight most recent valid samples', () => {
    const olderOutlier = { tokens: 1, elapsedMs: 100_000 };
    const recent = Array.from({ length: 8 }, (_, index) => ({
      tokens: 100 + index,
      elapsedMs: (100 + index) * 20,
    }));

    expect(estimateRemainingMs([olderOutlier, ...recent], 300)).toBe(6000);
  });
});
