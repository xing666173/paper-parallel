import { describe, expect, it } from 'vitest';
import { buildSingleBlockRepairPlan } from '../../src/core/translate/repair';
import type { TranslationBlockRequest } from '../../src/core/translate/protocol';

describe('translation: validation repair plan', () => {
  it('splits a long failed block and merges it back with coarse continuous alignment', () => {
    const source = Array.from({ length: 18 }, (_, index) => (
      `Sentence ${index + 1} preserves value ${100 + index} and explains the architecture in detail. `
    )).join('');
    const block: TranslationBlockRequest = {
      blockId: 'blk-long', kind: 'paragraph', source,
      alignmentMode: 'sentence-candidates',
      sourceSentences: [
        { id: 'blk-long-s-1', text: source.slice(0, 600) },
        { id: 'blk-long-s-2', text: source.slice(600) },
      ],
      protectedTokens: [],
    };
    const plan = buildSingleBlockRepairPlan(block)!;

    expect(plan.blocks.length).toBeGreaterThan(1);
    expect(plan.blocks.map((item) => item.source).join('')).toBe(source);
    expect(plan.blocks.length).toBeGreaterThan(3);
    expect(plan.blocks.every((item) => item.source.length <= 340)).toBe(true);
    const response = {
      blocks: plan.blocks.map((item, index) => ({
        blockId: item.blockId,
        translation: `译文${index + 1}。`,
        alignmentGroups: [{
          sourceSentenceIds: [item.sourceSentences[0]!.id],
          targetSegments: [`译文${index + 1}。`],
        }],
        newTerms: [], warnings: [],
      })),
    };
    const merged = plan.merge(response).blocks[0]!;

    expect(merged.blockId).toBe(block.blockId);
    expect(merged.alignmentGroups).toEqual([{
      sourceSentenceIds: ['blk-long-s-1', 'blk-long-s-2'],
      targetSegments: response.blocks.map((item) => item.translation),
    }]);
  });

  it('does not split an already small repair block', () => {
    const block: TranslationBlockRequest = {
      blockId: 'small', kind: 'paragraph', source: 'A short sentence with 12 items.',
      alignmentMode: 'paragraph-fallback',
      sourceSentences: [{ id: 'small', text: 'A short sentence with 12 items.' }],
      protectedTokens: ['12'],
    };
    expect(buildSingleBlockRepairPlan(block)).toBeUndefined();
  });
});
