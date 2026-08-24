import { describe, expect, it } from 'vitest';
import { buildTranslationBatches, estimateConservativeTokens } from '../../src/core/translate/batcher';
import type { TranslationBlockRequest } from '../../src/core/translate/protocol';

function block(id: string, source: string): TranslationBlockRequest {
  return {
    blockId: id,
    kind: 'paragraph',
    source,
    alignmentMode: 'sentence-candidates',
    sourceSentences: [{ id: `${id}-s-1`, text: source }],
    protectedTokens: [],
  };
}

describe('translation batching', () => {
  it('keeps document order and never splits a block across batches', () => {
    const batches = buildTranslationBatches(
      [block('a', 'a'.repeat(100)), block('b', 'b'.repeat(100)), block('c', 'c'.repeat(100))],
      { maxInputTokens: 180, estimateTokens: (text) => Math.ceil(text.length / 4) },
    );

    expect(batches.flatMap((batch) => batch.blocks.map((item) => item.blockId))).toEqual(['a', 'b', 'c']);
    expect(batches.every((batch) => batch.blocks.length > 0)).toBe(true);
    expect(batches.every((batch) => batch.estimatedTokens <= 180)).toBe(true);
  });

  it('accounts for document context and glossary before accepting a block', () => {
    const withoutContext = buildTranslationBatches([block('a', 'short')], {
      maxInputTokens: 40,
      estimateTokens: (text) => Math.ceil(text.length / 10),
    });
    const withContext = buildTranslationBatches([block('a', 'short')], {
      maxInputTokens: 40,
      estimateTokens: (text) => Math.ceil(text.length / 10),
      documentContext: { abstract: 'x'.repeat(300) },
      glossary: [{ source: 'a', target: '甲' }],
    });

    expect(withoutContext[0]?.oversized).toBe(false);
    expect(withContext[0]?.oversized).toBe(true);
    expect(withContext[0]?.blocks.map((item) => item.blockId)).toEqual(['a']);
  });

  it('marks a single oversized block instead of splitting its text', () => {
    const source = 'long-source'.repeat(100);
    const batches = buildTranslationBatches([block('large', source)], {
      maxInputTokens: 20,
      estimateTokens: (text) => Math.ceil(text.length / 4),
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.oversized).toBe(true);
    expect(batches[0]?.blocks[0]?.source).toBe(source);
  });

  it('uses the conservative mixed-language estimator by default', () => {
    expect(estimateConservativeTokens('中文abc')).toBe(2);
  });
});
