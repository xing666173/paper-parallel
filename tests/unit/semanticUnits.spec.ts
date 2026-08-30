import { describe, expect, it } from 'vitest';
import {
  buildBlockAndAssetAlignmentUnits,
  buildSemanticGroups,
} from '../../src/core/align/semanticUnits';

describe('stable semantic alignment units', () => {
  it.each(['figure', 'table', 'formula', 'code', 'page-furniture'] as const)('creates one asset unit for %s', (kind) => {
    const units = buildBlockAndAssetAlignmentUnits([
      { id: `${kind}-1`, kind, assetId: `${kind}-1`, order: 10 },
    ]);

    expect(units).toEqual([
      expect.objectContaining({ id: `${kind}-1`, kind: 'asset', relation: 'asset' }),
    ]);
  });

  it('uses assetId as the authoritative signal even for a synthetic unit kind', () => {
    const [unit] = buildBlockAndAssetAlignmentUnits([
      { id: 'algorithm-body', kind: 'code', assetId: 'algorithm-body-crop', order: 10 },
    ]);

    expect(unit).toMatchObject({
      id: 'algorithm-body-crop', kind: 'asset', relation: 'asset',
      sourceUnitIds: ['algorithm-body'], targetUnitIds: ['algorithm-body'],
    });
  });

  it('represents merge and split mappings without forcing one-to-one sentences', () => {
    const source = {
      blockId: 'sec-1-p-3',
      mode: 'sentence-candidates' as const,
      sentences: [
        { id: 'sec-1-p-3-s-1', text: 'First result.' },
        { id: 'sec-1-p-3-s-2', text: 'Second result!' },
        { id: 'sec-1-p-3-s-3', text: 'Third result.' },
      ],
    };

    const groups = buildSemanticGroups(source, [
      {
        sourceSentenceIds: ['sec-1-p-3-s-1', 'sec-1-p-3-s-2'],
        targetSegments: ['前两个结果合并说明。'],
      },
      {
        sourceSentenceIds: ['sec-1-p-3-s-3'],
        targetSegments: ['第三个结果。', '补充说明。'],
      },
    ]);

    expect(groups[0]).toMatchObject({
      id: 'sec-1-p-3-g-1',
      relation: 'n:1',
      sourceUnitIds: ['sec-1-p-3-s-1', 'sec-1-p-3-s-2'],
      targetUnitIds: ['sec-1-p-3-g-1-t-1'],
    });
    expect(groups[1]).toMatchObject({
      id: 'sec-1-p-3-g-2',
      relation: '1:n',
      sourceUnitIds: ['sec-1-p-3-s-3'],
      targetUnitIds: ['sec-1-p-3-g-2-t-1', 'sec-1-p-3-g-2-t-2'],
    });
  });

  it('classifies a many-to-many continuous relation without splitting it again', () => {
    const groups = buildSemanticGroups({
      blockId: 'p-many',
      mode: 'sentence-candidates',
      sentences: [
        { id: 'p-many-s-1', text: 'One.' },
        { id: 'p-many-s-2', text: 'Two.' },
      ],
    }, [{
      sourceSentenceIds: ['p-many-s-1', 'p-many-s-2'],
      targetSegments: ['一。', '二。'],
    }]);

    expect(groups[0]).toMatchObject({ relation: 'n:m' });
  });

  it('keeps an ambiguous source block as an explicit paragraph fallback', () => {
    const groups = buildSemanticGroups(
      {
        blockId: 'eq-lead',
        mode: 'paragraph-fallback',
        sentences: [{ id: 'eq-lead', text: 'where x_i: y_i; z_i' }],
      },
      [{ sourceSentenceIds: ['eq-lead'], targetSegments: ['其中 x_i：y_i；z_i。'] }],
    );

    expect(groups).toEqual([
      expect.objectContaining({
        id: 'eq-lead',
        kind: 'block',
        relation: 'paragraph-fallback',
        fallbackReason: 'sentence-boundary-ambiguous',
      }),
    ]);
  });

  it('rejects mappings that are not continuous or repeat a source candidate', () => {
    const source = {
      blockId: 'p-invalid',
      mode: 'sentence-candidates' as const,
      sentences: [
        { id: 'p-invalid-s-1', text: 'One.' },
        { id: 'p-invalid-s-2', text: 'Two.' },
        { id: 'p-invalid-s-3', text: 'Three.' },
      ],
    };

    expect(() => buildSemanticGroups(source, [{
      sourceSentenceIds: ['p-invalid-s-1', 'p-invalid-s-3'],
      targetSegments: ['不连续。'],
    }])).toThrow('连续');
  });
});
