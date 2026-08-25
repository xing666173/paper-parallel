import { describe, expect, it } from 'vitest';
import {
  buildTranslationRequestsFromDoc,
  normalizeDeepSeekTranslationResponse,
  parseDeepSeekTranslationJson,
  prepareImmutableStructure,
} from '../../src/core/pipeline/preparation';
import type { Doc } from '../../src/types/models';

describe('production pipeline preparation', () => {
  it('normalizes both snake_case and camelCase DeepSeek JSON without changing IDs', () => {
    const response = normalizeDeepSeekTranslationResponse({ blocks: [{
      block_id: 'p1', translation: '译文。',
      alignment_groups: [{ source_sentence_ids: ['p1-s-1'], target_segments: ['译文。'] }],
      new_terms: [{ source: 'trace', target: '执行轨迹' }], warnings: [],
    }] });
    expect(response.blocks[0]).toEqual({
      blockId: 'p1', translation: '译文。',
      alignmentGroups: [{ sourceSentenceIds: ['p1-s-1'], targetSegments: ['译文。'] }],
      newTerms: [{ source: 'trace', target: '执行轨迹' }], warnings: [],
    });
  });

  it('safely normalizes singleton nested fields while preserving strict downstream validation', () => {
    const response = normalizeDeepSeekTranslationResponse({ blocks: {
      block_id: 'p1', translation: '译文。',
      alignment_groups: { source_sentence_ids: 'p1-s-1', target_segments: '译文。' },
      new_terms: { source: 'trace', target: '执行轨迹' }, warnings: 'normalized singleton',
    } });

    expect(response.blocks).toEqual([{
      blockId: 'p1', translation: '译文。',
      alignmentGroups: [{ sourceSentenceIds: ['p1-s-1'], targetSegments: ['译文。'] }],
      newTerms: [{ source: 'trace', target: '执行轨迹', abbreviation: undefined }],
      warnings: ['normalized singleton'],
    }]);
  });

  it('reports the exact JSON field path without including response content', () => {
    expect(() => normalizeDeepSeekTranslationResponse({ blocks: [{
      block_id: 'secret-block', translation: 'private translation', alignment_groups: 42,
    }] })).toThrowError(expect.objectContaining({
      name: 'DeepSeekProtocolError',
      message: 'DeepSeek JSON blocks[0].alignment_groups 必须为数组或对象',
    }));
  });

  it('classifies malformed fenced JSON as a protocol error without echoing its content', () => {
    expect(() => parseDeepSeekTranslationJson('```json\n{"blocks":[private-content\n```'))
      .toThrowError(expect.objectContaining({
        name: 'DeepSeekProtocolError',
        message: 'DeepSeek 返回的 JSON 无法解析',
      }));
  });

  it('creates stable candidates for text and never sends immutable assets for translation', () => {
    const doc = fixtureDoc();
    const requests = buildTranslationRequestsFromDoc(doc);
    expect(requests.map((request) => request.blockId)).toEqual(['title', 'p1', 'fig-caption']);
    expect(requests.find((request) => request.blockId === 'p1')?.sourceSentences.map((sentence) => sentence.id))
      .toEqual(['p1-s-1', 'p1-s-2']);
    expect(requests.some((request) => request.blockId === 'eq1')).toBe(false);
  });

  it('crops formulas exactly and inserts a figure asset before its caption from the visual gap', () => {
    const prepared = prepareImmutableStructure(fixtureDoc());
    expect(prepared.assetRegions).toContainEqual(expect.objectContaining({
      id: 'eq1', kind: 'formula', rect: { x: 330, y: 500, w: 200, h: 30 },
    }));
    expect(prepared.assetRegions).toContainEqual(expect.objectContaining({
      id: 'fig-caption-asset', kind: 'figure', rect: { x: 50, y: 146, w: 230, h: 208 },
    }));
    const order = prepared.regions[0].orderedUnitIds;
    expect(order.indexOf('fig-caption-asset')).toBe(order.indexOf('fig-caption') - 1);
  });

  it('uses reconciled Vision assets instead of guessing from caption gaps and excludes visual labels from translation', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'figure-label', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 70, y: 260, w: 180, h: 20 }, order: 1.5,
      text: 'Execution Trace Generation', splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'figure-label', kind: 'paragraph', sourceText: 'Execution Trace Generation',
      protectedTokens: [], layoutRegionId: 'r1', order: 1.5,
    });
    doc.layoutRegions[0].orderedUnitIds.splice(2, 0, 'figure-label');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-p1-figure-1', kind: 'figure', pageIndex: 0,
      rect: { x: 55, y: 170, w: 220, h: 180 }, widthMode: 'column',
      captionUnitId: 'fig-caption',
    }] });

    expect(prepared.assetRegions.filter((asset) => asset.kind === 'figure')).toEqual([
      expect.objectContaining({ id: 'vision-p1-figure-1', rect: { x: 55, y: 170, w: 220, h: 180 } }),
    ]);
    expect(prepared.units.some((unit) => unit.id === 'figure-label')).toBe(false);
    expect(prepared.regions[0].orderedUnitIds).not.toContain('figure-label');
    expect(prepared.regions[0].orderedUnitIds.indexOf('vision-p1-figure-1'))
      .toBe(prepared.regions[0].orderedUnitIds.indexOf('fig-caption') - 1);
  });

  it('places a captionless Vision formula through its covered semantic unit in a cross-page region', () => {
    const doc = fixtureDoc();
    doc.pageCount = 2;
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    doc.blocks.push({
      id: 'page-2-formula', docId: 'en', type: 'equation', pageIndex: 1,
      rect: { x: 330, y: 120, w: 200, h: 30 }, order: 4,
      text: 'z = x + y', splitAllowed: false, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'page-2-formula', kind: 'formula', sourceText: 'z = x + y',
      protectedTokens: [], assetId: 'page-2-formula', layoutRegionId: 'r1', order: 4,
    });
    doc.layoutRegions[0].orderedUnitIds.push('page-2-formula');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-p2-formula-1', kind: 'formula', pageIndex: 1,
      rect: { x: 325, y: 300, w: 210, h: 40 }, widthMode: 'column',
    }] });

    expect(prepared.regions[0].orderedUnitIds).toContain('vision-p2-formula-1');
    expect(prepared.units.find((unit) => unit.id === 'vision-p2-formula-1')?.layoutRegionId).toBe('r1');
  });

  it('uses the repeated page header as the top boundary for side-by-side figures at the page top', () => {
    const doc = fixtureDoc();
    const runningHeader = 'ZK-Tracer: A High-Performance Heterogeneous Accelerator for Zero-Knowledge VM Trace Generation';
    doc.pageCount = 2;
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    doc.blocks.push(
      { id: 'header-1', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 54, y: 66, w: 294, h: 8 }, order: 4, text: runningHeader, splitAllowed: true, widthMode: 'column' },
      { id: 'header-2', docId: 'en', type: 'paragraph', pageIndex: 1, rect: { x: 54, y: 66, w: 294, h: 8 }, order: 5, text: runningHeader, splitAllowed: true, widthMode: 'column' },
      { id: 'paired-caption', docId: 'en', type: 'caption', pageIndex: 1, rect: { x: 71, y: 207, w: 487, h: 9 }, order: 6, text: 'Figure 3: Profiling Figure 4: Workload Analysis', splitAllowed: false, widthMode: 'span' },
    );
    doc.semanticUnits.push(
      { id: 'header-1', kind: 'paragraph', sourceText: runningHeader, protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'header-2', kind: 'paragraph', sourceText: runningHeader, protectedTokens: [], layoutRegionId: 'page-top', order: 5 },
      { id: 'paired-caption', kind: 'caption', sourceText: 'Figure 3: Profiling Figure 4: Workload Analysis', protectedTokens: [], layoutRegionId: 'page-top', order: 6 },
    );
    doc.layoutRegions.push({
      id: 'page-top', mode: 'full-width', sourcePage: 1,
      bounds: { x: 71, y: 207, w: 487, h: 400 }, orderedUnitIds: ['header-2', 'paired-caption'],
    });
    doc.layoutRegions[0].orderedUnitIds.push('header-1');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.assetRegions).toContainEqual(expect.objectContaining({
      id: 'paired-caption-asset', kind: 'figure', pageIndex: 1,
      rect: { x: 71, y: 80, w: 487, h: 121 },
    }));
  });

  it('uses extracted plot labels to bound a page-top figure without swallowing the page edge', () => {
    const doc = fixtureDoc();
    doc.pageCount = 2;
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    doc.blocks.push(
      {
        id: 'plot-labels', docId: 'en', type: 'paragraph', pageIndex: 1,
        rect: { x: 62, y: 96, w: 420, h: 88 }, order: 5,
        text: 'Main Trace Generation\n1.0\n0.8\n0.6\n0.4\nProportion\n0.2\n0.0\nJson RSA',
        splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'top-figure-caption', docId: 'en', type: 'caption', pageIndex: 1,
        rect: { x: 71, y: 207, w: 487, h: 9 }, order: 6,
        text: 'Figure 3: Profiling Figure 4: Workload Analysis',
        splitAllowed: false, widthMode: 'span',
      },
    );
    doc.semanticUnits.push(
      { id: 'plot-labels', kind: 'paragraph', sourceText: 'Main Trace Generation\n1.0\n0.8', protectedTokens: [], layoutRegionId: 'page-top', order: 5 },
      { id: 'top-figure-caption', kind: 'caption', sourceText: 'Figure 3: Profiling Figure 4: Workload Analysis', protectedTokens: [], layoutRegionId: 'page-top', order: 6 },
    );
    doc.layoutRegions.push({
      id: 'page-top', mode: 'full-width', sourcePage: 1,
      bounds: { x: 62, y: 96, w: 496, h: 120 }, orderedUnitIds: ['plot-labels', 'top-figure-caption'],
    });

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.assetRegions).toContainEqual(expect.objectContaining({
      id: 'top-figure-caption-asset', kind: 'figure', pageIndex: 1,
      rect: { x: 62, y: 90, w: 496, h: 111 },
    }));
    expect(prepared.units.some((unit) => unit.id === 'plot-labels')).toBe(false);
  });

  it('uses conservative page content margins for a pure-vector full-width figure fallback', () => {
    const doc = fixtureDoc();
    doc.pageCount = 2;
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    doc.blocks.push({
      id: 'vector-caption', docId: 'en', type: 'caption', pageIndex: 1,
      rect: { x: 235, y: 249, w: 143, h: 9 }, order: 5,
      text: 'Figure 5: Architecture', splitAllowed: false, widthMode: 'span',
    });
    doc.semanticUnits.push({
      id: 'vector-caption', kind: 'caption', sourceText: 'Figure 5: Architecture',
      protectedTokens: [], layoutRegionId: 'vector-region', order: 5,
    });
    doc.layoutRegions.push({
      id: 'vector-region', mode: 'full-width', sourcePage: 1,
      bounds: { x: 235, y: 249, w: 143, h: 9 }, orderedUnitIds: ['vector-caption'],
    });

    const prepared = prepareImmutableStructure(doc);
    const asset = prepared.assetRegions.find((candidate) => candidate.id === 'vector-caption-asset');

    expect(asset?.rect.x).toBeCloseTo(48.96);
    expect(asset?.rect.w).toBeCloseTo(514.08);
    expect(asset?.rect.y).toBeCloseTo(79.2);
    expect(asset?.rect.y).toBeGreaterThan(0);
  });

  it('preserves a captioned table as one full-column asset and excludes its body from translation', () => {
    const doc = fixtureDoc();
    doc.blocks.push(
      { id: 'table-caption', docId: 'en', type: 'caption', pageIndex: 0, rect: { x: 330, y: 570, w: 200, h: 18 }, order: 4, text: 'Figure 9: Analysis\nTable 1: Results', splitAllowed: false, widthMode: 'column' },
      { id: 'table-body', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 330, y: 596, w: 200, h: 62 }, order: 5, text: 'Method Throughput Baseline 1.0 Ours 2.4', splitAllowed: true, widthMode: 'column' },
      { id: 'after-table', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 330, y: 690, w: 200, h: 28 }, order: 6, text: 'The results confirm the trend.', splitAllowed: true, widthMode: 'column' },
    );
    doc.semanticUnits.push(
      { id: 'table-caption', kind: 'caption', sourceText: 'Figure 9: Analysis\nTable 1: Results', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'table-body', kind: 'paragraph', sourceText: 'Method Throughput Baseline 1.0 Ours 2.4', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
      { id: 'after-table', kind: 'paragraph', sourceText: 'The results confirm the trend.', protectedTokens: [], layoutRegionId: 'r1', order: 6 },
    );
    doc.layoutRegions[0].orderedUnitIds.push('table-caption', 'table-body', 'after-table');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.assetRegions).toContainEqual(expect.objectContaining({
      id: 'table-caption-asset', kind: 'table', rect: { x: 330, y: 594, w: 200, h: 70 },
    }));
    expect(prepared.units.some((unit) => unit.id === 'table-body')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'after-table')).toBe(true);
    expect(prepared.regions[0].orderedUnitIds).toEqual(expect.arrayContaining([
      'table-caption', 'table-caption-asset', 'after-table',
    ]));
    expect(prepared.regions[0].orderedUnitIds).not.toContain('table-body');
  });

  it('drops source page numbers so the target PDF can paginate and number itself naturally', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'page-number', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 302, y: 765, w: 8, h: 10 }, order: 4, text: '1',
      splitAllowed: true, widthMode: 'span',
    });
    doc.semanticUnits.push({
      id: 'page-number', kind: 'paragraph', sourceText: '1', protectedTokens: [],
      layoutRegionId: 'r1', order: 4,
    });
    doc.layoutRegions[0].orderedUnitIds.push('page-number');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.some((unit) => unit.id === 'page-number')).toBe(false);
    expect(prepared.regions[0].orderedUnitIds).not.toContain('page-number');
    expect(prepared.assetRegions.some((asset) => asset.id === 'page-number')).toBe(false);
  });
});

function fixtureDoc(): Doc {
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  return {
    id: 'en', role: 'en', pageCount: 1,
    pages: [{ pageIndex: 0, width: 612, height: 792, columns: [] }],
    blocks: [
      { id: 'title', docId: 'en', type: 'title', pageIndex: 0, rect: rect(60, 50, 490, 30), order: 0, text: 'Paper', splitAllowed: true, widthMode: 'span' },
      { id: 'p1', docId: 'en', type: 'paragraph', pageIndex: 0, rect: rect(50, 100, 230, 40), order: 1, text: 'First result. Second result.', splitAllowed: true, widthMode: 'column' },
      { id: 'fig-caption', docId: 'en', type: 'caption', pageIndex: 0, rect: rect(50, 360, 230, 20), order: 2, text: 'Figure 1: Workflow', splitAllowed: false, widthMode: 'column' },
      { id: 'eq1', docId: 'en', type: 'equation', pageIndex: 0, rect: rect(330, 500, 200, 30), order: 3, text: 'x = y + 1', splitAllowed: false, widthMode: 'column' },
    ],
    layoutRegions: [{ id: 'r1', mode: 'double', sourcePage: 0, bounds: rect(50, 50, 480, 500), orderedUnitIds: ['title', 'p1', 'fig-caption', 'eq1'] }],
    semanticUnits: [
      { id: 'title', kind: 'title', sourceText: 'Paper', protectedTokens: [], layoutRegionId: 'r1', order: 0 },
      { id: 'p1', kind: 'paragraph', sourceText: 'First result. Second result.', protectedTokens: [], layoutRegionId: 'r1', order: 1 },
      { id: 'fig-caption', kind: 'caption', sourceText: 'Figure 1: Workflow', protectedTokens: [], layoutRegionId: 'r1', order: 2 },
      { id: 'eq1', kind: 'formula', sourceText: 'x = y + 1', protectedTokens: [], assetId: 'eq1', layoutRegionId: 'r1', order: 3 },
    ],
    layoutMode: 'mixed', meta: { paperWidth: 612, paperHeight: 792, title: 'Paper' },
  };
}
