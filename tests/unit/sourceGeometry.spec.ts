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

  it('uses the preserved original block id for a split translation unit', () => {
    const text = 'First result. Second result.';
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'p1', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 10, y: 20, w: 150, h: 20 }, order: 0,
      splitAllowed: true, widthMode: 'column', text,
      characterRects: [...text].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 0,
        rect: { x: 10 + sourceIndex * 5, y: 20, w: 5, h: 10 },
      })),
    }];
    const unit = alignmentUnit({
      id: 'p1-part-1-g-1', parentId: 'p1-part-1', sourceBlockId: 'p1',
      kind: 'semantic-group', relation: '1:1', sourceText: 'Second result.',
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);
    expect(resolved.source[0].rects[0].x).toBeGreaterThan(10);
    expect(resolved.status).toBe('aligned');
  });

  it('relocates a restored sentence to the original PDF block that owns its glyphs', () => {
    const restored = 'rapidly evolving into the dominant bottleneck.';
    const metadata = `arXiv:1234.5678 [cs.AR] ${restored}`;
    const doc = emptyDoc();
    doc.blocks = [
      {
        id: 'body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 300, y: 200, w: 240, h: 200 }, order: 1,
        splitAllowed: true, widthMode: 'column', text: 'Before. After.',
        characterRects: [...'Before. After.'].map((ch, sourceIndex) => ({
          ch, sourceIndex, pageIndex: 0, rect: { x: 300 + sourceIndex * 4, y: 200, w: 4, h: 10 },
        })),
      },
      {
        id: 'metadata', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 30, y: 300, w: 520, h: 20 }, order: 2,
        splitAllowed: true, widthMode: 'span', text: metadata,
        characterRects: [...metadata].map((ch, sourceIndex) => ({
          ch, sourceIndex, pageIndex: 0, rect: { x: 30 + sourceIndex * 4, y: 300, w: 4, h: 10 },
        })),
      },
    ];
    const unit = alignmentUnit({
      id: 'body-g-2', parentId: 'body', sourceBlockId: 'body',
      kind: 'semantic-group', relation: '1:1', sourceText: restored,
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);
    expect(resolved).toMatchObject({
      status: 'aligned', confidence: 0.95,
      fallbackReason: 'source-sentence-relocated-to-origin-block',
      source: [{ page: 0 }],
    });
    expect(resolved.source[0].rects[0].y).toBe(300);
  });

  it('combines geometry when one sentence is split between body and metadata blocks', () => {
    const prefix = 'According to the law, this front-end is ';
    const suffix = 'rapidly evolving into the dominant bottleneck.';
    const body = `Earlier sentence. ${prefix}`;
    const metadata = `arXiv:1234.5678 [cs.AR] ${suffix}`;
    const doc = emptyDoc();
    doc.blocks = [
      {
        id: 'body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 300, y: 200, w: 240, h: 60 }, order: 1,
        splitAllowed: true, widthMode: 'column', text: body,
        characterRects: [...body].map((ch, sourceIndex) => ({
          ch, sourceIndex, pageIndex: 0, rect: { x: 300 + sourceIndex * 3, y: 200, w: 3, h: 10 },
        })),
      },
      {
        id: 'metadata', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 30, y: 240, w: 520, h: 20 }, order: 2,
        splitAllowed: true, widthMode: 'span', text: metadata,
        characterRects: [...metadata].map((ch, sourceIndex) => ({
          ch, sourceIndex, pageIndex: 0, rect: { x: 30 + sourceIndex * 3, y: 240, w: 3, h: 10 },
        })),
      },
    ];
    const unit = alignmentUnit({
      id: 'body-g-2', parentId: 'body', sourceBlockId: 'body',
      kind: 'semantic-group', relation: '1:1', sourceText: `${prefix}${suffix}`,
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);
    expect(resolved).toMatchObject({
      status: 'aligned', confidence: 0.95,
      fallbackReason: 'source-sentence-split-across-origin-blocks',
    });
    expect(resolved.source).toHaveLength(2);
    expect(resolved.source.map((set) => set.rects[0].y)).toEqual([200, 240]);
  });

  it('tolerates a small diagram-label insertion inside an otherwise matching sentence', () => {
    const source = 'The process begins with 1 the interpretive execution of the guest program.';
    const target = 'The process begins with the interpretive execution of the guest program.';
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'body', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 20, y: 30, w: 400, h: 20 }, order: 0,
      splitAllowed: true, widthMode: 'column', text: source,
      characterRects: [...source].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 0, rect: { x: 20 + sourceIndex * 4, y: 30, w: 4, h: 10 },
      })),
    }];
    const unit = alignmentUnit({
      id: 'body-g-1', parentId: 'body', sourceBlockId: 'body',
      kind: 'semantic-group', relation: '1:1', sourceText: target,
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);
    expect(resolved).toMatchObject({
      status: 'aligned',
      fallbackReason: 'source-sentence-fuzzy-token-match',
    });
    expect(resolved.confidence).toBeGreaterThan(0.9);
    expect(resolved.source[0].rects[0].w).toBeLessThan(doc.blocks[0].rect.w);
  });

  it('refuses to highlight a whole paragraph for an unresolved short sentence', () => {
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'p1', docId: 'en', type: 'paragraph', pageIndex: 2,
      rect: { x: 20, y: 30, w: 200, h: 80 }, order: 0,
      splitAllowed: true, widthMode: 'column', text: 'First result. Second result.',
    }];
    const unit = alignmentUnit({
      id: 'p1-g-2', parentId: 'p1', sourceBlockId: 'p1',
      kind: 'semantic-group', relation: '1:1', sourceText: 'Second result.',
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);
    expect(resolved).toMatchObject({
      status: 'unmatched', confidence: 0,
      fallbackReason: 'source-sentence-range-unresolved',
      source: [],
    });
  });

  it('allows block geometry only when a semantic group covers nearly the complete block', () => {
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'p1', docId: 'en', type: 'paragraph', pageIndex: 2,
      rect: { x: 20, y: 30, w: 200, h: 80 }, order: 0,
      splitAllowed: true, widthMode: 'column', text: 'Nearly the complete source paragraph.',
    }];
    const unit = alignmentUnit({
      id: 'p1-g-1', parentId: 'p1', sourceBlockId: 'p1',
      kind: 'semantic-group', relation: '1:1', sourceText: 'Nearly the complete source paragraph',
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);
    expect(resolved).toMatchObject({
      status: 'low-confidence', confidence: 0.75,
      fallbackReason: 'source-sentence-fell-back-to-block',
      source: [{ page: 2, rects: [doc.blocks[0].rect] }],
    });
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
