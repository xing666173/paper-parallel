import { describe, expect, it } from 'vitest';
import { resolveSourceGeometry, resolveTextRangeRects } from '../../src/core/align/sourceGeometry';
import type { AlignmentUnit, Doc } from '../../src/types/models';
import type { ImmutableAsset } from '../../src/core/assets/types';

describe('source PDF geometry', () => {
  it('groups sentence-group character boxes into visual-line rectangles', () => {
    const resolved = resolveTextRangeRects({
      page: 0,
      start: 0,
      end: 6,
      charRects: [
        { ch: 'a', x: 10, y: 20, w: 5, h: 10 },
        { ch: 'b', x: 15, y: 20, w: 5, h: 10 },
        { ch: 'c', x: 20, y: 20, w: 5, h: 10 },
        { ch: 'd', x: 10, y: 32, w: 5, h: 10 },
        { ch: 'e', x: 15, y: 32, w: 5, h: 10 },
        { ch: 'f', x: 20, y: 32, w: 5, h: 10 },
      ],
    });

    expect(resolved).toEqual([{ page: 0, rects: [
      { x: 10, y: 20, w: 15, h: 10 },
      { x: 10, y: 32, w: 15, h: 10 },
    ] }]);
  });

  it('keeps cross-page character fragments on their real pages', () => {
    const resolved = resolveTextRangeRects({
      start: 0,
      end: 4,
      charRects: [
        { ch: 'a', sourceIndex: 0, pageIndex: 2, x: 10, y: 700, w: 5, h: 10 },
        { ch: 'b', sourceIndex: 1, pageIndex: 2, x: 15, y: 700, w: 5, h: 10 },
        { ch: 'c', sourceIndex: 2, pageIndex: 3, x: 10, y: 40, w: 5, h: 10 },
        { ch: 'd', sourceIndex: 3, pageIndex: 3, x: 15, y: 40, w: 5, h: 10 },
      ],
    });

    expect(resolved.map((set) => set.page)).toEqual([2, 3]);
  });

  it('uses the immutable asset source rectangle without text matching', () => {
    const unit = alignmentUnit({
      id: 'fig-1',
      kind: 'asset',
      relation: 'asset',
      sourceUnitIds: ['fig-unit'],
    });
    const asset: ImmutableAsset = {
      id: 'fig-1',
      kind: 'figure',
      sourcePage: 4,
      sourceRect: { x: 80, y: 120, w: 300, h: 160 },
      mimeType: 'image/png',
      blob: new Blob(['figure']),
      sha256: 'hash',
      widthMode: 'column',
    };

    const [resolved] = resolveSourceGeometry([unit], emptyDoc(), [asset]);
    expect(resolved.source).toEqual([{ page: 4, rects: [asset.sourceRect] }]);
    expect(resolved.status).toBe('aligned');
  });

  it('resolves a sentence group from indexed block character geometry', () => {
    const text = 'First result. Second result.';
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'p1', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 10, y: 20, w: 150, h: 20 }, order: 0,
      splitAllowed: true, widthMode: 'column', text,
      characterRects: [...text].filter((ch) => ch !== ' ').map((ch, index) => ({
        ch,
        sourceIndex: index < 12 ? index : index + 1,
        pageIndex: 0,
        rect: { x: 10 + index * 5, y: 20, w: 5, h: 10 },
      })),
    }];
    const unit = alignmentUnit({
      id: 'p1-g-1', parentId: 'p1', kind: 'semantic-group', relation: '1:1',
      sourceUnitIds: ['p1-s-2'], sourceText: 'Second result.',
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);
    expect(resolved.source[0].rects[0].x).toBeGreaterThan(10);
    expect(resolved.status).toBe('aligned');
  });

  it('marks missing geometry unmatched instead of discarding the unit', () => {
    const unit = alignmentUnit({ id: 'missing', sourceUnitIds: ['missing'] });
    const result = resolveSourceGeometry([unit], emptyDoc(), []);
    expect(result).toEqual([expect.objectContaining({ id: 'missing', status: 'unmatched', confidence: 0 })]);
  });
});

function alignmentUnit(overrides: Partial<AlignmentUnit>): AlignmentUnit {
  return {
    id: 'u1', kind: 'block', relation: 'block',
    sourceUnitIds: [], targetUnitIds: [], source: [], target: [],
    confidence: 0, status: 'unmatched', ...overrides,
  };
}

function emptyDoc(): Doc {
  return {
    id: 'en', role: 'en', pageCount: 0, pages: [], blocks: [],
    layoutRegions: [], semanticUnits: [], layoutMode: 'single',
    meta: { paperWidth: 612, paperHeight: 792 },
  };
}
