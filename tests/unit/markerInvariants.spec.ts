import { describe, expect, it } from 'vitest';
import {
  validateGlobalMarkers,
  validateTranslationBlockMarkers,
} from '../../src/core/pipeline/markerInvariants';

describe('translation marker invariants', () => {
  it('derives concrete markers only after a validated response', () => {
    const result = validateTranslationBlockMarkers({
      request: {
        blockId: 'p1', kind: 'paragraph', source: 'One. Two.', alignmentMode: 'sentence-candidates',
        sourceSentences: [{ id: 's1', text: 'One.' }, { id: 's2', text: 'Two.' }], protectedTokens: [],
      },
      response: {
        blockId: 'p1', translation: '一。二。', newTerms: [], warnings: [],
        alignmentGroups: [
          { sourceSentenceIds: ['s1'], targetSegments: ['一。'] },
          { sourceSentenceIds: ['s2'], targetSegments: ['二。'] },
        ],
      },
    });
    expect(result.issues).toEqual([]);
    expect(result.markerIds).toEqual(['p1-g-1-t-1', 'p1-g-2-t-1']);
  });

  it('detects cross-block and emitted marker collisions before Typst persistence', () => {
    const block = validateTranslationBlockMarkers({
      request: {
        blockId: 'p1', kind: 'paragraph', source: 'One.', alignmentMode: 'paragraph-fallback',
        sourceSentences: [{ id: 's1', text: 'One.' }], protectedTokens: [],
      },
      response: {
        blockId: 'p1', translation: '一。', newTerms: [], warnings: [],
        alignmentGroups: [{ sourceSentenceIds: ['s1'], targetSegments: ['一。'] }],
      },
      committedMarkerIds: new Set(['p1-t-1']),
    });
    expect(block.issues[0]?.code).toBe('local-structural.cross-block-marker-collision');
    expect(validateGlobalMarkers({
      requiredMarkerIds: ['a', 'b'], emittedMarkerIds: ['a', 'a'],
    }).map((item) => item.code)).toEqual(expect.arrayContaining([
      'local-structural.duplicate-target-marker',
      'local-structural.marker-set-mismatch',
    ]));
  });
});
