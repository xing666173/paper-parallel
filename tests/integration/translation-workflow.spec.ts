import { describe, expect, it } from 'vitest';
import { canEnterReader, type CompletionSummary } from '../../src/core/task/completion';

const completeSummary: CompletionSummary = {
  requiredBlocks: 100,
  validatedBlocks: 100,
  failedBlocks: 0,
  protectedContentPass: true,
  pdfCompiled: true,
  assetsPass: true,
  alignmentBuilt: true,
  persisted: true,
};

describe('phase-one completion gate', () => {
  it('requires every mandatory translation and output check', () => {
    const fields: (keyof CompletionSummary)[] = [
      'protectedContentPass', 'pdfCompiled', 'assetsPass', 'alignmentBuilt', 'persisted',
    ];
    for (const field of fields) {
      expect(canEnterReader({ ...completeSummary, [field]: false })).toBe(false);
    }
    expect(canEnterReader({ ...completeSummary, validatedBlocks: 99 })).toBe(false);
    expect(canEnterReader({ ...completeSummary, validatedBlocks: 101 })).toBe(false);
    expect(canEnterReader({ ...completeSummary, failedBlocks: 1 })).toBe(false);
  });

  it('passes only a complete, validated and persisted result', () => {
    expect(canEnterReader(completeSummary)).toBe(true);
  });
});
