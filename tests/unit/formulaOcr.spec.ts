import { describe, expect, it } from 'vitest';
import { parseFormulaOcrResult } from '../../src/core/vision/formulaOcr';

describe('formula OCR protocol', () => {
  it('normalizes a fenced exact LaTeX result', () => {
    expect(parseFormulaOcrResult('```json\n{"latex":"$Q = \\\\sum_{i=1}^{n} P_i$","confidence":90}\n```'))
      .toEqual({ latex: 'Q = \\sum_{i=1}^{n} P_i', confidence: 0.9 });
  });

  it('rejects unsafe TeX commands and invalid confidence', () => {
    expect(() => parseFormulaOcrResult({
      latex: '\\input{secret}', confidence: 0.9,
    })).toThrow(/不安全/);
    expect(() => parseFormulaOcrResult({
      latex: 'Q = P', confidence: 'certain',
    })).toThrow(/置信度/);
  });
});
