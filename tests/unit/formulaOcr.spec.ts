import { describe, expect, it } from 'vitest';
import { parseCachedFormulaOcrResult, parseFormulaOcrResult } from '../../src/core/vision/formulaOcr';

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

  it('turns a corrupt or obsolete cache record into a cache miss', () => {
    expect(parseCachedFormulaOcrResult('{broken')).toBeUndefined();
    expect(parseCachedFormulaOcrResult('{"latex":"x","confidence":0.9}')).toBeUndefined();
    expect(parseCachedFormulaOcrResult('{"latex":"x+y","confidence":0.9}'))
      .toEqual({ latex: 'x+y', confidence: 0.9 });
  });
});
