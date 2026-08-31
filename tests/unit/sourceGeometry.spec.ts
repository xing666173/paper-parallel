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

  it('crops a paragraph fallback to its split text inside a larger PDF block', () => {
    const prefix = 'Unrelated material from the beginning of the source column.';
    const paragraph = 'This process requires one addition; trace_on starts capture and trace_off stops it.';
    const suffix = 'Unrelated material from the end of the source column.';
    const text = `${prefix}\n${paragraph}\n${suffix}`;
    const paragraphStart = text.indexOf(paragraph);
    const paragraphEnd = paragraphStart + paragraph.length;
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'aggregate', docId: 'en', type: 'paragraph', pageIndex: 3,
      rect: { x: 40, y: 100, w: 240, h: 500 }, order: 0,
      splitAllowed: true, widthMode: 'column', text,
      characterRects: [...text].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 3,
        rect: {
          x: 40 + (sourceIndex % 60) * 3,
          y: sourceIndex >= paragraphStart && sourceIndex < paragraphEnd ? 400 : 100,
          w: 3,
          h: 10,
        },
      })),
    }];
    const unit = alignmentUnit({
      id: 'aggregate-part-2', parentId: 'aggregate-part-2', sourceBlockId: 'aggregate',
      kind: 'block', relation: 'paragraph-fallback', sourceText: paragraph,
      fallbackReason: 'sentence-boundary-ambiguous',
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);
    expect(resolved).toMatchObject({
      status: 'aligned', confidence: 1,
      fallbackReason: 'sentence-boundary-ambiguous',
      source: [{ page: 3 }],
    });
    expect(resolved.source[0].rects.every((rect) => rect.y === 400)).toBe(true);
    expect(resolved.source[0].rects).not.toContainEqual(doc.blocks[0].rect);
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

  it('maps variables after detached PDF subscripts are reattached for translation', () => {
    const source = [
      'W asted , T otal , and perCore are the amounts of',
      'res', 'res', 'res',
      'wasted, total, and per core hardware resources, respectively.',
    ].join('\n');
    const target = 'Wasted_res , Total_res , and perCore_res are the amounts of wasted, total, and per core hardware resources, respectively.';
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'detached-subscripts', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 20, y: 30, w: 400, h: 50 }, order: 0,
      splitAllowed: true, widthMode: 'column', text: source,
      characterRects: [...source].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 0,
        rect: { x: 20 + (sourceIndex % 55) * 4, y: 30 + Math.floor(sourceIndex / 55) * 12, w: 4, h: 10 },
      })),
    }];
    const unit = alignmentUnit({
      id: 'detached-subscripts-g-1', parentId: 'detached-subscripts', sourceBlockId: 'detached-subscripts',
      kind: 'semantic-group', relation: '1:1', sourceText: target,
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);

    expect(resolved.source).not.toEqual([]);
    expect(resolved.status).not.toBe('unmatched');
  });

  it('maps one translated sentence across masked page furniture in the same PDF block', () => {
    const prefix = 'However, the DSPs of the VP1502';
    const furniture = 'MSMAC: Accelerating Multi-Scalar Multiplication for Zero-Knowledge Proof';
    const suffix = 'The total analysis of Steps 1 and 2 is complete.';
    const text = `${prefix}\n${furniture}\n${suffix}`;
    const furnitureStart = text.indexOf(furniture);
    const suffixStart = text.indexOf(suffix);
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'mixed', docId: 'en', type: 'paragraph', pageIndex: 3,
      rect: { x: 20, y: 100, w: 240, h: 220 }, order: 0,
      splitAllowed: true, widthMode: 'column', text,
      characterRects: [...text].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 3,
        rect: {
          x: 20 + (sourceIndex % 60) * 3,
          y: sourceIndex < furnitureStart ? 100 : sourceIndex < suffixStart ? 200 : 300,
          w: 3,
          h: 10,
        },
      })),
    }];
    const unit = alignmentUnit({
      id: 'mixed-g-2', parentId: 'mixed', sourceBlockId: 'mixed',
      kind: 'semantic-group', relation: '1:1',
      sourceText: `${prefix} The total lysis of Steps 1 and 2 is complete.`,
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);

    expect(resolved).toMatchObject({
      status: 'aligned', confidence: 0.92,
      fallbackReason: 'source-sentence-matched-across-masked-ranges',
    });
    expect(resolved.source.flatMap((set) => set.rects).map((rect) => rect.y))
      .toEqual(expect.arrayContaining([100, 300]));
    expect(resolved.source.flatMap((set) => set.rects).some((rect) => rect.y === 200)).toBe(false);
  });

  it('maps a short sentence across a frozen numeric formula without including the formula', () => {
    const source = 'This requires i = 1, 1024 - 15 = 1009 PADD operations.';
    const formulaStart = source.indexOf('1024');
    const formulaEnd = source.indexOf('PADD');
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'formula-gap', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 20, y: 100, w: 240, h: 50 }, order: 0,
      splitAllowed: true, widthMode: 'column', text: source,
      characterRects: [...source].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 0,
        rect: {
          x: 20 + sourceIndex * 4,
          y: sourceIndex >= formulaStart && sourceIndex < formulaEnd ? 130 : 100,
          w: 4, h: 10,
        },
      })),
    }];
    const unit = alignmentUnit({
      id: 'formula-gap-g-1', parentId: 'formula-gap', sourceBlockId: 'formula-gap',
      kind: 'semantic-group', relation: '1:1', sourceText: 'This requires PADD operations.',
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);

    expect(resolved).toMatchObject({
      status: 'aligned', confidence: 0.92,
      fallbackReason: 'source-sentence-matched-across-masked-ranges',
    });
    expect(resolved.source.flatMap((set) => set.rects).every((rect) => rect.y === 100)).toBe(true);
  });

  it('maps a compact formula across a stacked upper-bound fragment', () => {
    const source = '∑\n2 s − 1\nl =1 l\ni =1 i i';
    const upperBoundStart = source.indexOf('2');
    const lowerBoundStart = source.indexOf('l =1');
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'stacked-formula', docId: 'en', type: 'paragraph', pageIndex: 10,
      rect: { x: 300, y: 420, w: 190, h: 35 }, order: 0,
      splitAllowed: true, widthMode: 'column', text: source,
      characterRects: [...source].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 10,
        rect: {
          x: 300 + sourceIndex * 4,
          y: sourceIndex < upperBoundStart
            ? 420
            : sourceIndex < lowerBoundStart
              ? 410
              : 430,
          w: 4, h: 10,
        },
      })),
    }];
    const unit = alignmentUnit({
      id: 'stacked-formula-g-1', parentId: 'stacked-formula', sourceBlockId: 'stacked-formula',
      kind: 'semantic-group', relation: '1:1', sourceText: '∑ l =1 l',
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);

    expect(resolved).toMatchObject({
      status: 'aligned', confidence: 0.9,
      fallbackReason: 'source-formula-matched-across-stacked-ranges',
    });
    expect(resolved.source.flatMap((set) => set.rects).some((rect) => rect.y === 410)).toBe(false);
    expect(resolved.source.flatMap((set) => set.rects).map((rect) => rect.y))
      .toEqual(expect.arrayContaining([420, 430]));
  });

  it('does not use compact formula matching across ordinary prose', () => {
    const source = '∑ important prose l =1 l';
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'formula-prose-gap', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 20, y: 100, w: 200, h: 40 }, order: 0,
      splitAllowed: true, widthMode: 'column', text: source,
      characterRects: [...source].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 0,
        rect: { x: 20 + sourceIndex * 4, y: 100, w: 4, h: 10 },
      })),
    }];
    const unit = alignmentUnit({
      id: 'formula-prose-gap-g-1', parentId: 'formula-prose-gap', sourceBlockId: 'formula-prose-gap',
      kind: 'semantic-group', relation: '1:1', sourceText: '∑ l =1 l',
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);

    expect(resolved).toMatchObject({ status: 'unmatched' });
    expect(resolved.source).toEqual([]);
  });

  it('maps a sentence across a long publisher permission footer removed from translation', () => {
    const prefix = 'Moreover, with increasing demand, the degree of';
    const publisher = [
      'Permission to make digital or hard copies of all or part of this work for personal use is granted.',
      'Copyrights for components of this work owned by others must be honored.',
      'Copyright held by the owner/author(s). Publication rights licensed to ACM.',
      'ACM ISBN 979-8-4007-0601-1/24/06.',
      'https://doi.org/10.1145/3649329.3658259',
    ].join(' ');
    const suffix = 'MSM has grown larger.';
    const text = `${prefix}\n${publisher}\n${suffix}`;
    const publisherStart = text.indexOf(publisher);
    const suffixStart = text.indexOf(suffix);
    const doc = emptyDoc();
    doc.blocks = [{
      id: 'publisher-mixed', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 20, y: 100, w: 240, h: 220 }, order: 0,
      splitAllowed: true, widthMode: 'column', text,
      characterRects: [...text].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 0,
        rect: {
          x: 20 + (sourceIndex % 60) * 3,
          y: sourceIndex < publisherStart ? 100 : sourceIndex < suffixStart ? 200 : 300,
          w: 3, h: 10,
        },
      })),
    }];
    const unit = alignmentUnit({
      id: 'publisher-mixed-g-1', parentId: 'publisher-mixed', sourceBlockId: 'publisher-mixed',
      kind: 'semantic-group', relation: '1:1', sourceText: `${prefix} ${suffix}`,
    });

    const [resolved] = resolveSourceGeometry([unit], doc, []);

    expect(resolved).toMatchObject({
      status: 'aligned', confidence: 0.92,
      fallbackReason: 'source-sentence-matched-across-masked-ranges',
    });
    expect(resolved.source.flatMap((set) => set.rects).map((rect) => rect.y))
      .toEqual(expect.arrayContaining([100, 300]));
    expect(resolved.source.flatMap((set) => set.rects).some((rect) => rect.y === 200)).toBe(false);
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
