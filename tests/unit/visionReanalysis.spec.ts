import { describe, expect, it } from 'vitest';
import { expandVisionReanalysisPages } from '../../src/core/vision/reanalysis';
import type { CrossPageAssetGroup } from '../../src/core/vision/crossPageRelations';

function group(id: string, pages: number[]): CrossPageAssetGroup {
  return {
    id, status: 'validated', kind: 'table',
    members: pages.map((pageIndex, index) => ({
      pageIndex, regionId: `${id}-${pageIndex}`,
      role: index === 0 ? 'head' : index === pages.length - 1 ? 'tail' : 'continuation',
    })),
    strongEvidence: 'continued-label', weakEvidence: [], provenance: ['test'],
  };
}

describe('failed Vision page reanalysis scope', () => {
  it('expands a failed page across all members and chained legacy groups', () => {
    expect(expandVisionReanalysisPages([1], [group('a', [0, 1]), group('b', [1, 2])]))
      .toEqual([0, 1, 2]);
  });

  it('drops invalid page indices and keeps unrelated groups untouched', () => {
    expect(expandVisionReanalysisPages([-1, 4], [group('a', [0, 1])])).toEqual([4]);
  });
});
