import { describe, expect, it } from 'vitest';
import { buildLayoutRegions } from '../../src/core/layout/regions';

describe('layout regions', () => {
  it('preserves ordered full-width and two-column regions', () => {
    const regions = buildLayoutRegions({
      pageWidth: 612,
      blocks: [
        { id: 'title', pageIndex: 0, order: 0, col: 'full', rect: { x: 72, y: 60, w: 468, h: 40 } },
        { id: 'abstract', pageIndex: 0, order: 1, col: 'full', rect: { x: 72, y: 120, w: 468, h: 80 } },
        { id: 'left-1', pageIndex: 0, order: 2, col: 'left', rect: { x: 72, y: 230, w: 220, h: 90 } },
        { id: 'right-1', pageIndex: 0, order: 3, col: 'right', rect: { x: 320, y: 230, w: 220, h: 90 } },
        { id: 'wide-figure', pageIndex: 1, order: 4, col: 'full', rect: { x: 72, y: 80, w: 468, h: 180 } },
      ],
    });
    expect(regions.map((region) => region.mode)).toEqual(['full-width', 'double', 'full-width']);
    expect(regions.flatMap((region) => region.orderedUnitIds)).toEqual([
      'title', 'abstract', 'left-1', 'right-1', 'wide-figure',
    ]);
  });

  it('distinguishes a true single-column page from a full-width mixed region', () => {
    const regions = buildLayoutRegions({
      pageWidth: 612,
      pageModes: { 0: 'single' },
      blocks: [
        { id: 'p1', pageIndex: 0, order: 0, col: 'full', rect: { x: 72, y: 80, w: 468, h: 90 } },
        { id: 'p2', pageIndex: 0, order: 1, col: 'full', rect: { x: 72, y: 190, w: 468, h: 90 } },
      ],
    });
    expect(regions).toHaveLength(1);
    expect(regions[0]?.mode).toBe('single');
  });

  it('keeps consecutive source pages separate even when their layout modes match', () => {
    const regions = buildLayoutRegions({
      pageWidth: 612,
      blocks: [
        { id: 'p1-left', pageIndex: 0, order: 0, col: 'left', rect: { x: 50, y: 80, w: 250, h: 600 } },
        { id: 'p2-left', pageIndex: 1, order: 1, col: 'left', rect: { x: 50, y: 80, w: 250, h: 600 } },
      ],
    });

    expect(regions).toHaveLength(2);
    expect(regions.map((region) => region.sourcePage)).toEqual([0, 1]);
    expect(regions.map((region) => region.orderedUnitIds)).toEqual([['p1-left'], ['p2-left']]);
  });
});
