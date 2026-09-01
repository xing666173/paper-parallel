import { describe, expect, it } from 'vitest';
import {
  authorBiographyStart,
  buildTranslationRequestsFromDoc,
  normalizeDeepSeekTranslationResponse,
  parseHeadingParts,
  parseDeepSeekTranslationJson,
  prepareImmutableStructure,
} from '../../src/core/pipeline/preparation';
import type { Doc } from '../../src/types/models';

describe('production pipeline preparation', () => {
  it('splits merged section and subsection headings before translation', () => {
    expect(parseHeadingParts('2 Motivation and Related Work 2.1 ZKP Bottleneck Shift')).toEqual([
      { number: '2', level: 1, text: 'Motivation and Related Work' },
      { number: '2.1', level: 2, text: 'ZKP Bottleneck Shift' },
    ]);
    expect(parseHeadingParts('III. EVALUATION')).toEqual([
      { number: 'III', level: 1, text: 'EVALUATION' },
    ]);
    expect(parseHeadingParts('A. Experimental Setup')).toEqual([
      { number: 'A', level: 2, text: 'Experimental Setup' },
    ]);
    expect(parseHeadingParts('V. OVERALL SYSTEM')).toEqual([
      { number: 'V', level: 1, text: 'OVERALL SYSTEM' },
    ]);
    expect(parseHeadingParts('V. Related Work and Motivation')).toEqual([
      { number: 'V', level: 1, text: 'Related Work and Motivation' },
    ]);
    expect(parseHeadingParts('I. Introduction')).toEqual([
      { number: 'I', level: 1, text: 'Introduction' },
    ]);
    expect(parseHeadingParts('X. Future Work')).toEqual([
      { number: 'X', level: 1, text: 'Future Work' },
    ]);
    expect(parseHeadingParts('C. Evaluating zk-SNARK Workloads')).toEqual([
      { number: 'C', level: 2, text: 'Evaluating zk-SNARK Workloads' },
    ]);
    expect(parseHeadingParts('V. Related Work A. Prior Accelerators')).toEqual([
      { number: 'V', level: 1, text: 'Related Work' },
      { number: 'A', level: 2, text: 'Prior Accelerators' },
    ]);
  });

  it('recognizes degree and role-led author biographies after a bibliography', () => {
    expect(authorBiographyStart('Patrick Dai is the founder of Semisand Chip Design.')).toBe(0);
    expect(authorBiographyStart('Yinlong Li is the senior FPGA engineer in the hardware R&D center.')).toBe(0);
    expect(authorBiographyStart('Shiyong Wu is the chief researcher in the hardware R&D center.')).toBe(0);
    expect(authorBiographyStart('Fan Yang (Member, IEEE) received the B.S. degree in 2003.')).toBe(0);
    expect(authorBiographyStart('[12] Patrick Dai is cited in this bibliography entry.')).toBeUndefined();
    expect(authorBiographyStart('This system is the proposed accelerator.')).toBeUndefined();
  });

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

  it('protects a leading paper product name and complete title acronyms', () => {
    const doc = fixtureDoc();
    const source = 'Falic: An FPGA-Based Multi-Scalar Multiplication (MSM) Accelerator';
    doc.semanticUnits.find((unit) => unit.id === 'title')!.sourceText = source;

    const request = buildTranslationRequestsFromDoc(doc).find((candidate) => candidate.blockId === 'title');

    expect(request?.protectedTokens).toEqual(['Falic', 'FPGA', 'MSM']);
    expect(request?.protectedTokens).not.toContain('FPGA-');
  });

  it('merges a late-emitted centered title continuation by first-page geometry', () => {
    const doc = fixtureDoc();
    const title = doc.blocks.find((block) => block.id === 'title')!;
    title.rect = { x: 100, y: 50, w: 410, h: 30 };
    title.text = 'A Faster Parallel Multi-Scalar Multiplication';
    doc.semanticUnits.find((unit) => unit.id === 'title')!.sourceText = title.text;
    doc.blocks.push({
      id: 'title-tail', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 205, y: 84, w: 200, h: 16 }, order: 9,
      text: 'Algorithm on GPUs', splitAllowed: false, widthMode: 'span',
    });
    doc.semanticUnits.push({
      id: 'title-tail', kind: 'paragraph', sourceText: 'Algorithm on GPUs',
      protectedTokens: [], layoutRegionId: 'r1', order: 9,
    });
    doc.layoutRegions[0].orderedUnitIds.push('title-tail');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'title')?.sourceText)
      .toBe('A Faster Parallel Multi-Scalar Multiplication\nAlgorithm on GPUs');
    expect(prepared.units.some((unit) => unit.id === 'title-tail')).toBe(false);
  });

  it('demotes a later-page parser title to a numbered section heading', () => {
    const doc = fixtureDoc();
    doc.pageCount = 2;
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    doc.blocks.push({
      id: 'later-title', docId: 'en', type: 'title', pageIndex: 1,
      rect: { x: 104, y: 676, w: 336, h: 14 }, order: 4,
      text: '4 An Efficient GPU Implementation of zkSNARK', splitAllowed: false, widthMode: 'span',
    });
    doc.semanticUnits.push({
      id: 'later-title', kind: 'title', sourceText: '4 An Efficient GPU Implementation of zkSNARK',
      protectedTokens: [], layoutRegionId: 'later-region', order: 4,
    });
    doc.layoutRegions.push({
      id: 'later-region', mode: 'single', sourcePage: 1,
      bounds: { x: 104, y: 676, w: 336, h: 14 }, orderedUnitIds: ['later-title'],
    });

    const prepared = prepareImmutableStructure(doc);
    expect(prepared.units.find((unit) => unit.id === 'later-title')).toMatchObject({
      kind: 'heading', headingNumber: '4', headingLevel: 1,
      sourceText: 'An Efficient GPU Implementation of zkSNARK',
    });
  });

  it('strips front-matter labels and rejoins a geometrically adjacent URL path', () => {
    const doc = fixtureDoc();
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.text = 'Abstract. Results are available in https://github.com/';
    paragraph.rect = { x: 50, y: 100, w: 360, h: 40 };
    const paragraphUnit = doc.semanticUnits.find((unit) => unit.id === 'p1')!;
    paragraphUnit.kind = 'abstract';
    paragraphUnit.sourceText = paragraph.text;
    doc.blocks.push({
      id: 'url-tail', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 50, y: 142, w: 90, h: 10 }, order: 8,
      text: 'org/project .', splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'url-tail', kind: 'paragraph', sourceText: 'org/project .',
      protectedTokens: [], layoutRegionId: 'r1', order: 8,
    });
    doc.layoutRegions[0].orderedUnitIds.push('url-tail');

    const prepared = prepareImmutableStructure(doc);
    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('Results are available in https://github.com/org/project.');
    expect(prepared.units.some((unit) => unit.id === 'url-tail')).toBe(false);
  });

  it('splits a mixed first-page title, author and affiliation block into stable front matter order', () => {
    const doc = fixtureDoc();
    const title = doc.blocks.find((block) => block.id === 'title')!;
    title.text = 'cuZK: A Faster Parallel Multi-Scalar Multiplication';
    doc.semanticUnits.find((unit) => unit.id === 'title')!.sourceText = title.text;
    doc.blocks.push({
      id: 'mixed-front-matter', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 150, y: 82, w: 312, h: 45 }, order: 0.5,
      text: 'Algorithm on GPUs\nAlice Smith and Bob Jones\nDepartment of Computing, Example University',
      splitAllowed: true, widthMode: 'span',
    });
    doc.semanticUnits.push({
      id: 'mixed-front-matter', kind: 'paragraph',
      sourceText: 'Algorithm on GPUs\nAlice Smith and Bob Jones\nDepartment of Computing, Example University',
      protectedTokens: [], layoutRegionId: 'r1', order: 0.5,
    });
    doc.layoutRegions[0].orderedUnitIds.splice(1, 0, 'mixed-front-matter');

    const prepared = prepareImmutableStructure(doc);
    const order = prepared.regions[0].orderedUnitIds;

    expect(prepared.units.find((unit) => unit.id === 'title')?.sourceText)
      .toBe('cuZK: A Faster Parallel Multi-Scalar Multiplication\nAlgorithm on GPUs');
    expect(prepared.units).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'author', sourceText: 'Alice Smith and Bob Jones' }),
      expect.objectContaining({ kind: 'affiliation', sourceText: 'Department of Computing, Example University' }),
    ]));
    expect(order.findIndex((id) => prepared.units.find((unit) => unit.id === id)?.kind === 'author'))
      .toBeLessThan(order.indexOf('p1'));
    expect(order.findIndex((id) => prepared.units.find((unit) => unit.id === id)?.kind === 'affiliation'))
      .toBeLessThan(order.indexOf('p1'));
  });

  it('moves a late-emitted heading before the first paragraph physically below it', () => {
    const doc = fixtureDoc();
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.rect = { x: 50, y: 140, w: 230, h: 40 };
    doc.blocks.push({
      id: 'late-heading', docId: 'en', type: 'section', pageIndex: 0,
      rect: { x: 50, y: 115, w: 150, h: 14 }, order: 9,
      text: '2.4 Sparse Matrix', splitAllowed: false, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'late-heading', parentId: 'late-heading', kind: 'heading',
      sourceText: '2.4 Sparse Matrix', protectedTokens: [],
      layoutRegionId: 'late-region', order: 9,
    });
    doc.layoutRegions.push({
      id: 'late-region', mode: 'double', sourcePage: 0,
      bounds: { x: 50, y: 115, w: 150, h: 14 }, orderedUnitIds: ['late-heading'],
    });

    const prepared = prepareImmutableStructure(doc);
    const region = prepared.regions.find((candidate) => candidate.id === 'r1')!;

    expect(region.orderedUnitIds.indexOf('late-heading')).toBeLessThan(region.orderedUnitIds.indexOf('p1'));
    expect(prepared.units.find((unit) => unit.id === 'late-heading')?.layoutRegionId).toBe('r1');
  });

  it('moves a column heading before an aligned span paragraph below it', () => {
    const doc = fixtureDoc();
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.rect = { x: 50, y: 140, w: 500, h: 40 };
    paragraph.widthMode = 'span';
    doc.blocks.push({
      id: 'late-span-heading', docId: 'en', type: 'section', pageIndex: 0,
      rect: { x: 51, y: 115, w: 150, h: 14 }, order: 9,
      text: '1 Introduction', splitAllowed: false, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'late-span-heading', parentId: 'late-span-heading', kind: 'heading',
      sourceText: '1 Introduction', protectedTokens: [],
      layoutRegionId: 'late-span-region', order: 9,
    });
    doc.layoutRegions.push({
      id: 'late-span-region', mode: 'double', sourcePage: 0,
      bounds: { x: 51, y: 115, w: 150, h: 14 }, orderedUnitIds: ['late-span-heading'],
    });

    const prepared = prepareImmutableStructure(doc);
    const region = prepared.regions.find((candidate) => candidate.id === 'r1')!;

    expect(region.orderedUnitIds.indexOf('late-span-heading')).toBeLessThan(region.orderedUnitIds.indexOf('p1'));
    expect(prepared.units.find((unit) => unit.id === 'late-span-heading')?.layoutRegionId).toBe('r1');
  });

  it('never removes a short section heading as a nested PDF text fragment', () => {
    const doc = fixtureDoc();
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.rect = { x: 50, y: 100, w: 500, h: 100 };
    doc.blocks.push({
      id: 'overlapping-heading', docId: 'en', type: 'section', pageIndex: 0,
      rect: { x: 60, y: 120, w: 80, h: 12 }, order: 9,
      text: 'Methods', splitAllowed: false, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'overlapping-heading', parentId: 'overlapping-heading', kind: 'heading',
      sourceText: 'Methods', protectedTokens: [], layoutRegionId: 'r1', order: 9,
    });
    doc.layoutRegions[0].orderedUnitIds.push('overlapping-heading');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'overlapping-heading')?.sourceText)
      .toBe('Methods');
  });

  it('splits oversized translatable units at natural boundaries before batching', () => {
    const doc = fixtureDoc();
    const longSource = Array.from(
      { length: 80 },
      (_, index) => `Sentence ${index + 1} preserves value ${index + 100} while explaining the implementation in complete technical prose.`,
    ).join(' ');
    doc.blocks.find((block) => block.id === 'p1')!.text = longSource;
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = longSource;

    const prepared = prepareImmutableStructure(doc);
    const parts = prepared.units.filter((unit) => unit.parentId === 'p1');

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((unit) => unit.sourceBlockId === 'p1')).toBe(true);
    expect(parts.every((unit) => (unit.sourceText?.length ?? 0) <= 1_800)).toBe(true);
    expect(parts.map((unit) => unit.sourceText).join(' ').replace(/\s+/g, ' ').trim())
      .toBe(longSource.replace(/\s+/g, ' ').trim());
    expect(prepared.units.some((unit) => unit.id === 'p1')).toBe(false);
    expect(prepared.regions[0].orderedUnitIds).toEqual(expect.arrayContaining(parts.map((unit) => unit.id)));
  });

  it('does not split an oversized paragraph at a visual PDF line wrap inside a sentence', () => {
    const doc = fixtureDoc();
    const completeSentences = Array.from(
      { length: 12 },
      (_, index) => `Complete sentence ${index + 1} ${'describes the implementation '.repeat(3)}without ambiguity.`,
    ).join('\n');
    const finalSentence = `For the GPU implementations, our scheme has a\n${'substantial measured speedup over the baseline '.repeat(8)}without duplicating the continuation.`;
    const source = `${completeSentences}\n${finalSentence}`;
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.text = source;
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);
    const parts = prepared.units.filter((unit) => unit.parentId === 'p1');

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.sourceText).toMatch(/[.]$/);
    expect(parts[1]!.sourceText).toMatch(/^For the GPU implementations/);
  });

  it('rejoins a lowercase prose continuation across a captioned figure and drops visual punctuation residue', () => {
    const doc = fixtureDoc();
    doc.pageCount = 2;
    doc.pages = [
      { pageIndex: 0, width: 612, height: 792, columns: [] },
      { pageIndex: 1, width: 612, height: 792, columns: [] },
    ];
    const prefix = 'The accelerator selects the correct input elements for every butterfly operation. If we naively';
    const continuation = 'scale up the bitwidth beyond 256, the area and energy overheads increase significantly.';
    const remainder = 'Furthermore, the required computation resources also scale in a super-linear fashion.';
    doc.blocks = [
      {
        id: 'before-figure', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 314, y: 620, w: 238, h: 80 }, order: 10,
        fragments: [
          { pageIndex: 0, rect: { x: 314, y: 620, w: 238, h: 80 } },
          { pageIndex: 1, rect: { x: 58, y: 80, w: 238, h: 120 } },
        ],
        text: `${prefix}\n… … … …`, splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'figure-caption', docId: 'en', type: 'caption', pageIndex: 1,
        rect: { x: 58, y: 214, w: 238, h: 10 }, order: 11,
        text: 'Figure 4: Recursive transform', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'after-figure', docId: 'en', type: 'paragraph', pageIndex: 1,
        rect: { x: 58, y: 245, w: 238, h: 70 }, order: 12,
        text: `${continuation} ${remainder}`, splitAllowed: true, widthMode: 'column',
      },
    ];
    doc.semanticUnits = [
      {
        id: 'before-figure', kind: 'paragraph', sourceText: `${prefix}\n… … … …`,
        protectedTokens: [], layoutRegionId: 'page-one', order: 10,
      },
      {
        id: 'figure-caption', kind: 'caption', sourceText: 'Figure 4: Recursive transform',
        protectedTokens: [], layoutRegionId: 'page-two', order: 11,
      },
      {
        id: 'after-figure', kind: 'paragraph', sourceText: `${continuation} ${remainder}`,
        protectedTokens: [], layoutRegionId: 'page-two', order: 12,
      },
    ];
    doc.layoutRegions = [
      {
        id: 'page-one', mode: 'double', sourcePage: 0,
        bounds: { x: 314, y: 620, w: 238, h: 80 }, orderedUnitIds: ['before-figure'],
      },
      {
        id: 'page-two', mode: 'double', sourcePage: 1,
        bounds: { x: 58, y: 80, w: 238, h: 235 },
        orderedUnitIds: ['figure-caption', 'after-figure'],
      },
    ];

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'figure-asset', kind: 'figure', pageIndex: 1,
      rect: { x: 58, y: 80, w: 238, h: 128 }, widthMode: 'column',
      captionUnitId: 'figure-caption',
    }] });

    expect(prepared.units.find((unit) => unit.id === 'before-figure')?.sourceText)
      .toBe(`${prefix}\n${continuation}`);
    expect(prepared.units.find((unit) => unit.id === 'after-figure')?.sourceText)
      .toBe(remainder);
    expect(prepared.regions.find((region) => region.id === 'page-two')?.orderedUnitIds)
      .toEqual(['figure-asset', 'figure-caption', 'after-figure']);
  });

  it('joins a wrapped table caption before repairing a one-word prose continuation across the table', () => {
    const doc = fixtureDoc();
    doc.pageCount = 2;
    doc.pages = [
      { pageIndex: 0, width: 612, height: 792, columns: [] },
      { pageIndex: 1, width: 612, height: 792, columns: [] },
    ];
    const prefix = 'The transfer time drops by an order of magnitude. This';
    const continuation = 'is because all required points overlap with device computation.';
    const remainder = 'Fourth, the multi-device implementation adds little overhead.';
    doc.blocks = [
      {
        id: 'before-table', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 104, y: 680, w: 388, h: 50 }, order: 10,
        text: prefix, splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'table-caption', docId: 'en', type: 'caption', pageIndex: 1,
        rect: { x: 104, y: 100, w: 388, h: 10 }, order: 11,
        text: 'Table 6: Execution time across', splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'table-caption-tail', docId: 'en', type: 'paragraph', pageIndex: 1,
        rect: { x: 104, y: 112, w: 180, h: 10 }, order: 12,
        text: 'various constraint scales (S).', splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'after-table', docId: 'en', type: 'paragraph', pageIndex: 1,
        rect: { x: 104, y: 260, w: 388, h: 60 }, order: 13,
        text: `${continuation} ${remainder}`, splitAllowed: true, widthMode: 'span',
      },
    ];
    doc.semanticUnits = [
      { id: 'before-table', kind: 'paragraph', sourceText: prefix, protectedTokens: [], layoutRegionId: 'page-one', order: 10 },
      { id: 'table-caption', kind: 'caption', sourceText: 'Table 6: Execution time across', protectedTokens: [], layoutRegionId: 'page-two', order: 11 },
      { id: 'table-caption-tail', kind: 'paragraph', sourceText: 'various constraint scales (S).', protectedTokens: [], layoutRegionId: 'page-two', order: 12 },
      { id: 'after-table', kind: 'paragraph', sourceText: `${continuation} ${remainder}`, protectedTokens: [], layoutRegionId: 'page-two', order: 13 },
    ];
    doc.layoutRegions = [
      { id: 'page-one', mode: 'full-width', sourcePage: 0, bounds: { x: 104, y: 680, w: 388, h: 50 }, orderedUnitIds: ['before-table'] },
      { id: 'page-two', mode: 'full-width', sourcePage: 1, bounds: { x: 104, y: 100, w: 388, h: 220 }, orderedUnitIds: ['table-caption', 'table-caption-tail', 'after-table'] },
    ];

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'table-asset', kind: 'table', pageIndex: 1,
      // The crop begins through the continuation's baseline. Recovery must
      // happen before asset masking and move the crop below this text line.
      rect: { x: 100, y: 116, w: 396, h: 124 }, widthMode: 'span',
      captionUnitId: 'table-caption',
    }] });

    expect(prepared.units.find((unit) => unit.id === 'table-caption')?.sourceText)
      .toBe('Table 6: Execution time across various constraint scales (S).');
    expect(prepared.units.some((unit) => unit.id === 'table-caption-tail')).toBe(false);
    expect(prepared.units.find((unit) => unit.id === 'before-table')?.sourceText)
      .toBe(`${prefix}\n${continuation}`);
    expect(prepared.units.find((unit) => unit.id === 'after-table')?.sourceText).toBe(remainder);
    expect(prepared.assetRegions.find((asset) => asset.id === 'table-asset')?.rect.y)
      .toBeGreaterThanOrEqual(124);
  });

  it('keeps bibliography entries verbatim instead of sending them through translation', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'ref-1', docId: 'en', type: 'reference', pageIndex: 0,
      rect: { x: 50, y: 700, w: 230, h: 30 }, order: 4,
      text: '[1] A. Author. Paper title. 2024.', splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'ref-1', kind: 'reference', sourceText: '[1] A. Author. Paper title. 2024.',
      protectedTokens: [], layoutRegionId: 'r1', order: 4,
    });

    expect(buildTranslationRequestsFromDoc(doc).some((request) => request.blockId === 'ref-1')).toBe(false);
  });

  it('treats bibliography continuation paragraphs as references too', () => {
    const doc = fixtureDoc();
    doc.semanticUnits.push(
      { id: 'refs', parentId: 'refs', kind: 'heading', sourceText: 'References', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'ref-head', parentId: 'refs', kind: 'reference', sourceText: '[1] A. Author.', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
      { id: 'ref-cont', parentId: 'refs', kind: 'paragraph', sourceText: 'Paper title. 2024.', protectedTokens: [], layoutRegionId: 'r1', order: 6 },
    );
    doc.layoutRegions[0].orderedUnitIds.push('refs', 'ref-head', 'ref-cont');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'ref-cont')?.kind).toBe('reference');
    const requests = buildTranslationRequestsFromDoc({ ...doc, semanticUnits: prepared.units });
    expect(requests.some((request) => request.blockId === 'ref-cont')).toBe(false);
    expect(prepared.units.find((unit) => unit.id === 'refs')?.kind).toBe('heading');
    expect(requests.find((request) => request.blockId === 'refs')?.kind).toBe('heading');
  });

  it('rebuilds split bibliography label and body columns in physical reading order', () => {
    const doc = fixtureDoc();
    const characterRows = (lines: string[], x: number, ys: number[]) => {
      let sourceIndex = 0;
      return lines.flatMap((line, rowIndex) => {
        const row = [...line].flatMap((ch, charIndex) => ch.trim() ? [{
          ch,
          sourceIndex: sourceIndex + charIndex,
          pageIndex: 0,
          rect: { x: x + charIndex * 5, y: ys[rowIndex]!, w: 4.5, h: 8 },
        }] : []);
        sourceIndex += line.length + 1;
        return row;
      });
    };
    const bodyLines = [
      'A. Author. A paral-',
      'lel paper.',
      'B. Writer. Second title.',
      '[Online]. Available: https://github.com/',
      'org/repo , Accessed: 2024-12-',
      '09.',
    ];
    doc.blocks.push(
      {
        id: 'reference-body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 100, y: 630, w: 380, h: 60 }, order: 4,
        text: bodyLines.join('\n'), characterRects: characterRows(bodyLines, 100, [630, 642, 660, 672, 684, 696]),
        splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'references-heading', docId: 'en', type: 'section', pageIndex: 0,
        rect: { x: 50, y: 600, w: 90, h: 14 }, order: 6,
        text: 'References', splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'reference-labels', docId: 'en', type: 'reference', pageIndex: 0,
        rect: { x: 50, y: 630, w: 45, h: 40 }, order: 7,
        text: '[A1]\n[B2]', characterRects: characterRows(['[A1]', '[B2]'], 50, [630, 660]),
        splitAllowed: true, widthMode: 'column',
      },
    );
    doc.layoutRegions.push(
      {
        id: 'reference-body-region', mode: 'double', sourcePage: 0,
        bounds: { x: 100, y: 630, w: 380, h: 60 }, orderedUnitIds: ['reference-body'],
      },
      {
        id: 'reference-heading-region', mode: 'double', sourcePage: 0,
        bounds: { x: 50, y: 600, w: 430, h: 100 },
        orderedUnitIds: ['references-heading', 'reference-labels'],
      },
    );
    doc.semanticUnits.push(
      {
        id: 'reference-body', kind: 'paragraph', sourceText: bodyLines.join('\n'),
        protectedTokens: [], layoutRegionId: 'reference-body-region', order: 4,
      },
      {
        id: 'references-heading', parentId: 'references-heading', kind: 'heading', sourceText: 'References',
        protectedTokens: [], layoutRegionId: 'reference-heading-region', order: 6,
      },
      {
        id: 'reference-labels', parentId: 'references-heading', kind: 'reference', sourceText: '[A1]\n[B2]',
        protectedTokens: [], layoutRegionId: 'reference-heading-region', order: 7,
      },
    );

    const prepared = prepareImmutableStructure(doc);
    const references = prepared.units.filter((unit) => unit.parentId === 'references-heading' && unit.kind === 'reference');

    expect(references.map((unit) => unit.sourceText)).toEqual([
      '[A1] A. Author. A parallel paper.',
      '[B2] B. Writer. Second title. [Online]. Available: https://github.com/org/repo , Accessed: 2024-12-09.',
    ]);
    expect(prepared.units.some((unit) => unit.id === 'reference-body')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'reference-labels')).toBe(false);
    expect(prepared.regions.find((region) => region.id === 'reference-heading-region')?.orderedUnitIds)
      .toEqual(['references-heading', ...references.map((unit) => unit.id)]);
  });

  it('splits plus-style reference labels and drops repeated running headers and page numbers', () => {
    const doc = fixtureDoc();
    doc.pageCount = 3;
    doc.pages.push(
      { pageIndex: 1, width: 612, height: 792, columns: [] },
      { pageIndex: 2, width: 612, height: 792, columns: [] },
    );
    const characters = (text: string, x: number, y: number, pageIndex: number) => [...text].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex, rect: { x: x + sourceIndex * 4, y, w: 3.8, h: 8 },
    }));
    const references = [
      { id: 'plus-ref-a', text: '[A + 20] First reference.', pageIndex: 0, x: 50, y: 530 },
      { id: 'plus-ref-b', text: '[B + 21] Second reference.', pageIndex: 0, x: 50, y: 560 },
      { id: 'plus-ref-c', text: '[C + 22] Third reference.', pageIndex: 0, x: 330, y: 530 },
      { id: 'plus-ref-d', text: '[D + 23] Fourth reference.', pageIndex: 0, x: 330, y: 560 },
      { id: 'plus-ref-e', text: '[E + 24] Fifth reference.', pageIndex: 1, x: 50, y: 90 },
      { id: 'plus-ref-f', text: '[F + 25] Sixth reference.', pageIndex: 1, x: 330, y: 90 },
      { id: 'plus-ref-g', text: '[G + 26] Seventh reference.', pageIndex: 2, x: 50, y: 90 },
      { id: 'plus-ref-h', text: '[H + 27] Eighth reference.', pageIndex: 2, x: 330, y: 90 },
    ];
    const furniture = [
      { id: 'running-24', text: '24 cuZK', pageIndex: 1, x: 104 },
      { id: 'running-author', text: 'T. Example et al.', pageIndex: 1, x: 470 },
      { id: 'running-26', text: '26 cuZK', pageIndex: 2, x: 104 },
    ];
    doc.blocks.push({
      id: 'plus-references', docId: 'en', type: 'section', pageIndex: 0,
      rect: { x: 50, y: 500, w: 100, h: 14 }, order: 4,
      text: 'References', splitAllowed: false, widthMode: 'span',
    }, ...references.map((reference, index) => ({
      id: reference.id, docId: 'en' as const, type: 'reference' as const,
      pageIndex: reference.pageIndex,
      rect: { x: reference.x, y: reference.y, w: 230, h: 10 }, order: 5 + index,
      text: reference.text,
      characterRects: characters(reference.text, reference.x, reference.y, reference.pageIndex),
      splitAllowed: true, widthMode: 'column' as const,
    })), ...furniture.map((item, index) => ({
      id: item.id, docId: 'en' as const, type: 'paragraph' as const,
      pageIndex: item.pageIndex,
      rect: { x: item.x, y: 66, w: 40, h: 10 }, order: 20 + index,
      text: item.text, characterRects: characters(item.text, item.x, 66, item.pageIndex),
      splitAllowed: false, widthMode: 'column' as const,
    })));
    doc.layoutRegions.push({
      id: 'plus-reference-region', mode: 'double', sourcePage: 0,
      bounds: { x: 50, y: 500, w: 510, h: 220 },
      orderedUnitIds: ['plus-references', ...references.map((reference) => reference.id), ...furniture.map((item) => item.id)],
    });
    doc.semanticUnits.push({
      id: 'plus-references', parentId: 'plus-references', kind: 'heading', sourceText: 'References',
      protectedTokens: [], layoutRegionId: 'plus-reference-region', order: 4,
    }, ...references.map((reference, index) => ({
      id: reference.id, parentId: 'plus-references', kind: 'reference' as const,
      sourceText: reference.text, protectedTokens: [], layoutRegionId: 'plus-reference-region', order: 5 + index,
    })), ...furniture.map((item, index) => ({
      id: item.id, kind: 'page-furniture' as const, sourceText: item.text,
      protectedTokens: [], layoutRegionId: 'plus-reference-region', order: 20 + index,
    })));

    const prepared = prepareImmutableStructure(doc);
    const rebuilt = prepared.units.filter((unit) => unit.parentId === 'plus-references' && unit.kind === 'reference');
    expect(rebuilt.map((unit) => unit.sourceText)).toEqual(references.map((reference) => reference.text));
    expect(rebuilt.some((unit) => /(?:^|\s)(?:24|26|cuZK|T\. Example et al\.)(?:\s|$)/.test(unit.sourceText!))).toBe(false);
  });

  it('reads independent bibliography columns top-to-bottom instead of interleaving equal-height rows', () => {
    const doc = fixtureDoc();
    const characters = (text: string, x: number, y: number) => [...text].map((ch, index) => ({
      ch,
      sourceIndex: index,
      pageIndex: 0,
      rect: { x: x + index * 5, y, w: 4.5, h: 8 },
    }));
    const references = [
      { id: 'left-ref-1', text: '[1] First left-column reference.', x: 50, y: 630, order: 5 },
      { id: 'left-ref-2', text: '[2] Second left-column reference.', x: 50, y: 660, order: 6 },
      { id: 'right-ref-3', text: '[3] First right-column reference.', x: 330, y: 100, order: 7 },
      { id: 'right-ref-4', text: '[4] Second right-column reference.', x: 330, y: 130, order: 8 },
    ];
    doc.blocks.push({
      id: 'two-column-references', docId: 'en', type: 'section', pageIndex: 0,
      rect: { x: 50, y: 600, w: 90, h: 14 }, order: 4,
      text: 'References', splitAllowed: true, widthMode: 'column',
    }, {
      id: 'right-table-above-references', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 330, y: 40, w: 230, h: 25 }, order: 4.5,
      text: '421.6MB/s 1.34GB/s 578.0MB/s',
      characterRects: characters('421.6MB/s 1.34GB/s 578.0MB/s', 330, 40),
      splitAllowed: true, widthMode: 'column',
    }, ...references.map((reference) => ({
      id: reference.id,
      docId: 'en' as const,
      type: 'reference' as const,
      pageIndex: 0,
      rect: { x: reference.x, y: reference.y, w: 230, h: 12 },
      order: reference.order,
      text: reference.text,
      characterRects: characters(reference.text, reference.x, reference.y),
      splitAllowed: true,
      widthMode: 'column' as const,
    })));
    doc.layoutRegions.push({
      id: 'two-column-reference-region', mode: 'double', sourcePage: 0,
      bounds: { x: 50, y: 80, w: 510, h: 610 },
      orderedUnitIds: [
        'right-table-above-references', 'two-column-references',
        ...references.map((reference) => reference.id),
      ],
    });
    doc.semanticUnits.push({
      id: 'two-column-references', parentId: 'two-column-references', kind: 'heading',
      sourceText: 'References', protectedTokens: [], layoutRegionId: 'two-column-reference-region', order: 4,
    }, {
      id: 'right-table-above-references', kind: 'paragraph',
      sourceText: '421.6MB/s 1.34GB/s 578.0MB/s', protectedTokens: [],
      layoutRegionId: 'two-column-reference-region', order: 4.5,
    }, ...references.map((reference) => ({
      id: reference.id,
      parentId: 'two-column-references',
      kind: 'reference' as const,
      sourceText: reference.text,
      protectedTokens: [],
      layoutRegionId: 'two-column-reference-region',
      order: reference.order,
    })));

    const prepared = prepareImmutableStructure(doc);
    const rebuilt = prepared.units.filter((unit) => (
      unit.parentId === 'two-column-references' && unit.kind === 'reference'
    ));

    expect(rebuilt.map((unit) => unit.sourceText)).toEqual(references.map((reference) => reference.text));
    expect(prepared.units.some((unit) => unit.id === 'right-table-above-references')).toBe(true);
  });

  it('restores a terminal table float emitted after the bibliography in extraction order', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((block) => block.id !== 'fig-caption');
    doc.semanticUnits = doc.semanticUnits.filter((unit) => unit.id !== 'fig-caption');
    doc.layoutRegions[0]!.orderedUnitIds = doc.layoutRegions[0]!.orderedUnitIds
      .filter((unitId) => unitId !== 'fig-caption');
    const characters = (text: string, x: number, y: number) => [...text].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: { x: x + sourceIndex * 4, y, w: 3.8, h: 8 },
    }));
    const description = 'R ESULTS FOR SEVERAL WORKLOADS ( LATENCIES IN SECONDS ).';
    const numericBody = [
      'Size Baseline Accelerator Speedup',
      '2^16 10.0 2.0 5.0',
      '2^17 20.0 4.0 5.0',
    ].join('\n');
    doc.blocks.push(
      {
        id: 'terminal-references', docId: 'en', type: 'section', pageIndex: 0,
        rect: { x: 50, y: 288, w: 90, h: 12 }, order: 4,
        text: 'References', splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'terminal-reference-1', docId: 'en', type: 'reference', pageIndex: 0,
        rect: { x: 50, y: 306, w: 230, h: 10 }, order: 5,
        text: '[1] First reference.', characterRects: characters('[1] First reference.', 50, 306),
        splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'terminal-reference-2', docId: 'en', type: 'reference', pageIndex: 0,
        rect: { x: 50, y: 324, w: 230, h: 10 }, order: 6,
        text: '[2] Second reference.', characterRects: characters('[2] Second reference.', 50, 324),
        splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'terminal-table-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 286, y: 190, w: 40, h: 8 }, order: 7,
        text: 'TABLE VI', splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'terminal-table-description', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 170, y: 200, w: 272, h: 10 }, order: 8,
        text: description, splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'terminal-table-header', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 70, y: 214, w: 472, h: 10 }, order: 9,
        text: 'Circuit Baseline Accelerator Speedup', splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'terminal-table-body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 70, y: 230, w: 472, h: 35 }, order: 10,
        text: numericBody, splitAllowed: true, widthMode: 'span',
      },
    );
    doc.semanticUnits.push(
      {
        id: 'terminal-references', parentId: 'terminal-references', kind: 'heading',
        sourceText: 'References', protectedTokens: [], layoutRegionId: 'r1', order: 4,
      },
      {
        id: 'terminal-reference-1', parentId: 'terminal-references', kind: 'reference',
        sourceText: '[1] First reference.', protectedTokens: [], layoutRegionId: 'r1', order: 5,
      },
      {
        id: 'terminal-reference-2', parentId: 'terminal-references', kind: 'reference',
        sourceText: '[2] Second reference.', protectedTokens: [], layoutRegionId: 'r1', order: 6,
      },
      {
        id: 'terminal-table-caption', parentId: 'terminal-references', kind: 'caption',
        sourceText: 'TABLE VI', protectedTokens: [], layoutRegionId: 'r1', order: 7,
      },
      {
        id: 'terminal-table-description', parentId: 'terminal-references', kind: 'paragraph',
        sourceText: description, protectedTokens: [], layoutRegionId: 'r1', order: 8,
      },
      {
        id: 'terminal-table-header', kind: 'paragraph', sourceText: 'Circuit Baseline Accelerator Speedup',
        protectedTokens: [], layoutRegionId: 'r1', order: 9,
      },
      {
        id: 'terminal-table-body', kind: 'paragraph', sourceText: numericBody,
        protectedTokens: [], layoutRegionId: 'r1', order: 10,
      },
    );
    doc.layoutRegions[0]!.orderedUnitIds.push(
      'terminal-references', 'terminal-reference-1', 'terminal-reference-2',
      'terminal-table-caption', 'terminal-table-description',
      'terminal-table-header', 'terminal-table-body',
    );

    const prepared = prepareImmutableStructure(doc);
    const table = prepared.assetRegions.find((asset) => asset.id === 'terminal-table-caption-asset');
    const region = prepared.regions.find((candidate) => candidate.id === 'r1')!;
    const references = prepared.units.filter((unit) => (
      unit.parentId === 'terminal-references' && unit.kind === 'reference'
    ));

    expect(table).toMatchObject({ kind: 'table', pageIndex: 0, widthMode: 'span' });
    expect(prepared.units.find((unit) => unit.id === 'terminal-table-caption')?.sourceText)
      .toBe('TABLE VI\nRESULTS FOR SEVERAL WORKLOADS ( LATENCIES IN SECONDS ).');
    expect(prepared.units.some((unit) => unit.id === 'terminal-table-description')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'terminal-table-header')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'terminal-table-body')).toBe(false);
    expect(references).toHaveLength(2);
    expect(region.orderedUnitIds.indexOf('terminal-table-caption-asset'))
      .toBe(region.orderedUnitIds.indexOf('terminal-table-caption') + 1);
    expect(region.orderedUnitIds.indexOf('terminal-table-caption-asset'))
      .toBeLessThan(region.orderedUnitIds.indexOf('terminal-references'));
  });

  it('does not absorb lower left-column body text into a right-column bibliography', () => {
    const doc = fixtureDoc();
    const characters = (text: string, x: number, y: number) => [...text].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: { x: x + sourceIndex * 3, y, w: 2.8, h: 8 },
    }));
    const leftBody = 'We also compare the accelerator with prior systems and report its speedup.';
    const referenceTexts = [
      '[1] First bibliography entry.',
      '[2] Second bibliography entry.',
    ];
    doc.blocks.push(
      {
        id: 'right-references', docId: 'en', type: 'section', pageIndex: 0,
        rect: { x: 330, y: 340, w: 90, h: 12 }, order: 4,
        text: 'References', splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'left-body-after-right-heading', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 390, w: 240, h: 20 }, order: 5,
        text: leftBody, characterRects: characters(leftBody, 50, 390),
        splitAllowed: true, widthMode: 'column',
      },
      ...referenceTexts.map((text, index) => ({
        id: `right-reference-${index + 1}`,
        docId: 'en' as const,
        type: 'reference' as const,
        pageIndex: 0,
        rect: { x: 330, y: 370 + index * 30, w: 230, h: 12 },
        order: 6 + index,
        text,
        characterRects: characters(text, 330, 370 + index * 30),
        splitAllowed: true,
        widthMode: 'column' as const,
      })),
    );
    doc.layoutRegions.push({
      id: 'mixed-ending', mode: 'double', sourcePage: 0,
      bounds: { x: 50, y: 340, w: 510, h: 100 },
      orderedUnitIds: [
        'left-body-after-right-heading', 'right-references',
        'right-reference-1', 'right-reference-2',
      ],
    });
    doc.semanticUnits.push(
      {
        id: 'right-references', parentId: 'right-references', kind: 'heading',
        sourceText: 'References', protectedTokens: [], layoutRegionId: 'mixed-ending', order: 4,
      },
      {
        id: 'left-body-after-right-heading', kind: 'paragraph', sourceText: leftBody,
        protectedTokens: [], layoutRegionId: 'mixed-ending', order: 5,
      },
      ...referenceTexts.map((sourceText, index) => ({
        id: `right-reference-${index + 1}`,
        parentId: 'right-references',
        kind: 'reference' as const,
        sourceText,
        protectedTokens: [],
        layoutRegionId: 'mixed-ending',
        order: 6 + index,
      })),
    );

    const prepared = prepareImmutableStructure(doc);
    const rebuilt = prepared.units.filter((unit) => (
      unit.parentId === 'right-references' && unit.kind === 'reference'
    ));

    expect(prepared.units.find((unit) => unit.id === 'left-body-after-right-heading')?.sourceText)
      .toBe(leftBody);
    expect(rebuilt.map((unit) => unit.sourceText)).toEqual(referenceTexts);
  });

  it('recovers a citation-leading body continuation that was misclassified as a reference', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'citation-continuation', docId: 'en', type: 'reference', pageIndex: 0,
      rect: { x: 330, y: 620, w: 220, h: 16 }, order: 4,
      text: '[34] as the basic building block. It is a fully pipelined design',
      splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'citation-continuation', kind: 'reference',
      sourceText: '[34] as the basic building block. It is a fully pipelined design',
      protectedTokens: ['[34]'], layoutRegionId: 'r1', order: 4,
    });
    doc.layoutRegions[0].orderedUnitIds.push('citation-continuation');

    const prepared = prepareImmutableStructure(doc);
    const recovered = prepared.units.find((unit) => unit.id === 'citation-continuation');

    expect(recovered?.kind).toBe('paragraph');
    expect(buildTranslationRequestsFromDoc({ ...doc, semanticUnits: prepared.units })
      .some((request) => request.blockId === 'citation-continuation')).toBe(true);
  });

  it('expands a formula crop to include an adjacent math-only continuation block', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'eq1-tail', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 400, y: 528, w: 80, h: 14 }, order: 3.1,
      text: 'k = 1', splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'eq1-tail', kind: 'paragraph', sourceText: 'k = 1', protectedTokens: [],
      layoutRegionId: 'r1', order: 3.1,
    });
    doc.layoutRegions[0].orderedUnitIds.push('eq1-tail');

    const prepared = prepareImmutableStructure(doc);
    expect(prepared.assetRegions.find((asset) => asset.id === 'eq1')?.rect)
      .toEqual({ x: 327, y: 498, w: 206, h: 46 });
    expect(prepared.units.some((unit) => unit.id === 'eq1-tail')).toBe(false);
  });

  it('does not expand a small formula fragment into a much taller aggregate text box', () => {
    const doc = fixtureDoc();
    const formula = doc.blocks.find((block) => block.id === 'eq1')!;
    formula.rect = { x: 366, y: 263, w: 14, h: 7 };
    formula.text = 'j = 1';
    doc.semanticUnits.find((unit) => unit.id === 'eq1')!.sourceText = formula.text;
    doc.blocks.push({
      id: 'formula-aggregate', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 285, y: 151, w: 207, h: 119 }, order: 2.9,
      text: 'u = 2 s − l\n2 ∑ s − 1\nB = l B = G\n(2)\nj = 1',
      splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'formula-aggregate', kind: 'paragraph',
      sourceText: 'u = 2 s − l\n2 ∑ s − 1\nB = l B = G\n(2)\nj = 1',
      protectedTokens: [], layoutRegionId: 'r1', order: 2.9,
    });
    doc.layoutRegions[0].orderedUnitIds.splice(3, 0, 'formula-aggregate');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.assetRegions.find((asset) => asset.id === 'eq1')?.rect)
      .toEqual({ x: 366, y: 263, w: 14, h: 7 });
  });

  it('falls back to translatable text when a parser formula crop would swallow prose', () => {
    const doc = fixtureDoc();
    const formula = doc.blocks.find((block) => block.id === 'eq1')!;
    formula.rect = { x: 210, y: 120, w: 40, h: 10 };
    formula.text = 'j = 1';
    doc.semanticUnits.find((unit) => unit.id === 'eq1')!.sourceText = formula.text;
    const prose = doc.blocks.find((block) => block.id === 'p1')!;
    prose.rect = { x: 50, y: 100, w: 230, h: 40 };
    prose.text = 'This ordinary paragraph contains a complete technical sentence with several natural language words.';
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = prose.text;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'eq1')?.kind).toBe('paragraph');
    expect(prepared.assetRegions.some((asset) => asset.id === 'eq1')).toBe(false);
  });

  it('removes an extracted math-only tail from prose immediately before an immutable formula', () => {
    const doc = fixtureDoc();
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = 'The values are defined below.\n𝑖 𝑗 1 ∑ 𝑖';
    doc.blocks.find((block) => block.id === 'p1')!.text = 'The values are defined below.\n𝑖 𝑗 1 ∑ 𝑖';
    doc.blocks.find((block) => block.id === 'p1')!.rect = { x: 330, y: 450, w: 230, h: 45 };

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText).toBe('The values are defined below.');
  });

  it('does not merge a formula tail from the opposite column into an immutable formula', () => {
    const doc = fixtureDoc();
    const oppositeColumn = doc.blocks.find((block) => block.id === 'p1')!;
    oppositeColumn.text = 'The values are defined below.\n𝑖 𝑗\n∑ 𝑖\n1';
    oppositeColumn.rect = { x: 50, y: 450, w: 230, h: 45 };
    oppositeColumn.characterRects = [
      ...[...'The values are defined below.'].map((ch, index) => ({
        ch, sourceIndex: index, pageIndex: 0,
        rect: { x: 50 + index * 4, y: 450, w: 3.8, h: 8 },
      })),
      { ch: '𝑖', sourceIndex: 30, pageIndex: 0, rect: { x: 110, y: 474, w: 5, h: 8 } },
      { ch: '𝑗', sourceIndex: 32, pageIndex: 0, rect: { x: 130, y: 474, w: 5, h: 8 } },
      { ch: '∑', sourceIndex: 34, pageIndex: 0, rect: { x: 94, y: 486, w: 8, h: 12 } },
      { ch: '𝑖', sourceIndex: 36, pageIndex: 0, rect: { x: 110, y: 487, w: 5, h: 8 } },
      { ch: '1', sourceIndex: 38, pageIndex: 0, rect: { x: 96, y: 490, w: 4, h: 7 } },
    ];
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = oppositeColumn.text;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe(oppositeColumn.text);
    expect(prepared.assetRegions.find((asset) => asset.id === 'eq1')?.rect)
      .toEqual({ x: 330, y: 500, w: 200, h: 30 });
  });

  it('translates a sentence with inline math instead of freezing the whole line as a formula image', () => {
    const doc = fixtureDoc();
    const formula = doc.blocks.find((block) => block.id === 'eq1')!;
    formula.text = 'Specifically, it calculates a serial of new points T = 2 G.';
    formula.rect = { x: 50, y: 500, w: 480, h: 12 };
    formula.widthMode = 'span';
    doc.semanticUnits.find((unit) => unit.id === 'eq1')!.sourceText = formula.text;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'eq1')).toMatchObject({
      kind: 'paragraph',
      sourceText: formula.text,
    });
    expect(prepared.assetRegions.some((asset) => asset.id === 'eq1')).toBe(false);
  });

  it('splits prose around a parser-confirmed inline formula and preserves the formula as pixels', () => {
    const doc = fixtureDoc();
    const source = 'The multi-scalar multiplication is defined as Q = n k P, where each P is a point on a predetermined curve.';
    const formula = doc.blocks.find((block) => block.id === 'eq1')!;
    formula.text = source;
    formula.rect = { x: 330, y: 500, w: 230, h: 12 };
    formula.characterRects = [...source].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 330 + index * 2.1, y: 500, w: 2, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'eq1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.regions[0].orderedUnitIds).toEqual(expect.arrayContaining([
      'eq1-inline-before', 'eq1-inline-formula', 'eq1-inline-after',
    ]));
    expect(prepared.units.find((unit) => unit.id === 'eq1-inline-before')?.sourceText)
      .toBe('The multi-scalar multiplication is defined as');
    expect(prepared.units.find((unit) => unit.id === 'eq1-inline-after')?.sourceText)
      .toBe('where each P is a point on a predetermined curve.');
    expect(prepared.units.find((unit) => unit.id === 'eq1-inline-formula')).toMatchObject({
      kind: 'formula', assetId: 'eq1-inline-formula', sourceText: undefined,
    });
    expect(prepared.assetRegions.find((asset) => asset.id === 'eq1-inline-formula'))
      .toMatchObject({
        kind: 'formula', pageIndex: 0,
        rect: { y: 500, h: 16 },
      });
  });

  it('preserves an inline formula that reaches the end of its PDF text block', () => {
    const doc = fixtureDoc();
    const source = 'Specifically, it calculates a serial of new points T = 2 G';
    const formula = doc.blocks.find((block) => block.id === 'eq1')!;
    formula.text = source;
    formula.rect = { x: 330, y: 500, w: 230, h: 12 };
    formula.widthMode = 'span';
    formula.characterRects = [...source].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 330 + index * 3, y: 500, w: 2.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'eq1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'eq1-inline-before')?.sourceText)
      .toBe('Specifically, it calculates a serial of new points');
    expect(prepared.units.find((unit) => unit.id === 'eq1-inline-formula')).toMatchObject({
      kind: 'formula', assetId: 'eq1-inline-formula', sourceText: undefined,
    });
    expect(prepared.units.some((unit) => unit.id === 'eq1-inline-after')).toBe(false);
  });

  it('keeps formulas on adjacent source baselines as separate inline assets', () => {
    const doc = fixtureDoc();
    const firstSource = 'The first calculation produces an intermediate output Q = n k P';
    const secondSource = 'Specifically, it calculates a serial of new values T = 2 G';
    const first = doc.blocks.find((block) => block.id === 'p1')!;
    const second = doc.blocks.find((block) => block.id === 'eq1')!;
    first.text = firstSource;
    first.rect = { x: 50, y: 380, w: 300, h: 10 };
    first.characterRects = [...firstSource].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: { x: 50 + sourceIndex * 4, y: 380, w: 3.8, h: 9 },
    }));
    second.text = secondSource;
    second.rect = { x: 50, y: 397, w: 300, h: 10 };
    second.characterRects = [...secondSource].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: { x: 50 + sourceIndex * 4, y: 397, w: 3.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = firstSource;
    doc.semanticUnits.find((unit) => unit.id === 'eq1')!.sourceText = secondSource;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.assetRegions.filter((asset) => /-inline-formula/.test(asset.id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'p1-inline-formula' }),
        expect.objectContaining({ id: 'eq1-inline-formula' }),
      ]));
  });

  it('merges an overlapping next-block formula fragment and removes detached subscript lines', () => {
    const doc = fixtureDoc();
    const prefix = 'The MSM computations are\n∑';
    const equationText = 'defined as Q = n k P, where each P is a point on a pre-';
    const continuationText = 'i i\ni\ndetermined EC and each i =1 k is a lambda-bit scalar.\ni i\nand the products are accumulated.';
    const equation = doc.blocks.find((block) => block.id === 'eq1')!;
    equation.text = equationText;
    equation.rect = { x: 330, y: 500, w: 230, h: 10 };
    equation.characterRects = [...equationText].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: { x: 330 + sourceIndex * 3, y: 500, w: 2.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'eq1')!.sourceText = equationText;
    doc.blocks.push(
      {
        id: 'formula-prefix', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 330, y: 480, w: 230, h: 18 }, order: 2.9,
        text: prefix, splitAllowed: true, widthMode: 'column',
        characterRects: [...prefix].map((ch, sourceIndex) => ({
          ch, sourceIndex, pageIndex: 0,
          rect: { x: 330 + sourceIndex * 4, y: sourceIndex < prefix.length - 1 ? 480 : 497, w: 3.8, h: 8 },
        })),
      },
      {
        id: 'formula-continuation', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 330, y: 506, w: 230, h: 36 }, order: 3.1,
        text: continuationText, splitAllowed: true, widthMode: 'column',
        characterRects: [...continuationText].map((ch, sourceIndex) => ({
          ch, sourceIndex, pageIndex: 0,
          rect: { x: 360 + (sourceIndex % 20) * 2, y: 506 + Math.floor(sourceIndex / 62) * 8, w: 1.8, h: 8 },
        })),
      },
    );
    doc.semanticUnits.push(
      { id: 'formula-prefix', kind: 'paragraph', sourceText: prefix, protectedTokens: [], layoutRegionId: 'r1', order: 2.9 },
      { id: 'formula-continuation', kind: 'paragraph', sourceText: continuationText, protectedTokens: [], layoutRegionId: 'r1', order: 3.1 },
    );
    doc.layoutRegions[0].orderedUnitIds.push('formula-prefix', 'formula-continuation');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.assetRegions.filter((asset) => asset.id.includes('-inline-formula'))).toHaveLength(1);
    expect(prepared.units.find((unit) => unit.id === 'formula-prefix')?.sourceText)
      .toBe('The MSM computations are');
    const continuation = prepared.units
      .filter((unit) => unit.id.startsWith('formula-continuation-inline-'))
      .map((unit) => unit.sourceText ?? '').join(' ');
    expect(continuation).not.toMatch(/(?:^|\s)i(?:\s+i)*(?:\s|$)/);
    expect(continuation).toContain('determined EC and each k');
    expect(continuation).toContain('is a lambda-bit scalar');
  });

  it('reclassifies stacked prose-free paragraph fragments as one immutable formula', () => {
    const doc = fixtureDoc();
    const firstText = '∑ 1';
    const secondText = '∑\n2 s − 1\nl =1 l\ni =1 i i';
    doc.blocks.push(
      {
        id: 'stacked-formula-a', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 250, y: 600, w: 18, h: 10 }, order: 1.5,
        text: firstText, splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'stacked-formula-b', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 268, y: 596, w: 180, h: 34 }, order: 1.6,
        text: secondText, splitAllowed: true, widthMode: 'span',
      },
    );
    doc.semanticUnits.push(
      { id: 'stacked-formula-a', kind: 'paragraph', sourceText: firstText, protectedTokens: [], layoutRegionId: 'r1', order: 1.5 },
      { id: 'stacked-formula-b', kind: 'paragraph', sourceText: secondText, protectedTokens: [], layoutRegionId: 'r1', order: 1.6 },
    );
    doc.layoutRegions[0].orderedUnitIds.splice(2, 0, 'stacked-formula-a', 'stacked-formula-b');

    const prepared = prepareImmutableStructure(doc);

    const formulaUnits = prepared.units.filter((unit) => unit.id.startsWith('stacked-formula'));
    expect(formulaUnits).toHaveLength(1);
    expect(formulaUnits[0]).toMatchObject({
      kind: 'formula', sourceText: undefined,
    });
    const formulaAssets = prepared.assetRegions.filter((asset) => asset.id.startsWith('stacked-formula'));
    expect(formulaAssets).toHaveLength(1);
    expect(formulaAssets[0]).toMatchObject({
      id: formulaUnits[0]!.assetId, kind: 'formula',
      rect: expect.objectContaining({ y: 594 }),
    });
  });

  it('drops an unsafe stacked formula duplicate embedded in a larger prose aggregate', () => {
    const doc = fixtureDoc();
    const firstText = '∑ 1';
    const secondText = '∑\n2 s − 1\nl =1 l\ni =1 i i';
    const prose = 'The result is a vector. Finally, we compute the weighted sum, which equals the result of the subtask.';
    doc.blocks.push(
      {
        id: 'formula-prose-owner', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 200, y: 580, w: 310, h: 80 }, order: 1.4,
        text: prose, splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'embedded-formula-a', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 250, y: 600, w: 18, h: 10 }, order: 1.5,
        text: firstText, splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'embedded-formula-b', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 268, y: 596, w: 180, h: 34 }, order: 1.6,
        text: secondText, splitAllowed: true, widthMode: 'span',
      },
    );
    doc.semanticUnits.push(
      { id: 'formula-prose-owner', kind: 'paragraph', sourceText: prose, protectedTokens: [], layoutRegionId: 'r1', order: 1.4 },
      { id: 'embedded-formula-a', kind: 'paragraph', sourceText: firstText, protectedTokens: [], layoutRegionId: 'r1', order: 1.5 },
      { id: 'embedded-formula-b', kind: 'paragraph', sourceText: secondText, protectedTokens: [], layoutRegionId: 'r1', order: 1.6 },
    );
    doc.layoutRegions[0].orderedUnitIds.splice(
      2, 0, 'formula-prose-owner', 'embedded-formula-a', 'embedded-formula-b',
    );

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'formula-prose-owner')?.sourceText).toBe(prose);
    expect(prepared.units.some((unit) => unit.id.startsWith('embedded-formula'))).toBe(false);
    expect(prepared.assetRegions.some((asset) => asset.id.startsWith('embedded-formula'))).toBe(false);
  });

  it('preserves multiple inline formulas found inside a paragraph block', () => {
    const doc = fixtureDoc();
    const source = 'The relation Q = n k P, where n is the scale. Another equation y 2 = x 3 + ax + b, and the point is valid.';
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.text = source;
    paragraph.rect = { x: 50, y: 380, w: 500, h: 30 };
    paragraph.widthMode = 'span';
    paragraph.characterRects = [...source].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 50 + index * 4, y: 380, w: 3.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.some((unit) => unit.id === 'p1')).toBe(false);
    expect(prepared.units.filter((unit) => unit.id.startsWith('p1-inline-formula')))
      .toHaveLength(2);
    expect(prepared.assetRegions.filter((asset) => asset.id.startsWith('p1-inline-formula')))
      .toHaveLength(2);
    expect(prepared.units.find((unit) => unit.id === 'p1-inline-between-1')?.sourceText)
      .toBe('where n is the scale. Another equation');
    expect(prepared.units.find((unit) => unit.id === 'p1-inline-after')?.sourceText)
      .toBe('and the point is valid.');
  });

  it('drops a later broad formula aggregate when tight inline crops already represent it', () => {
    const doc = fixtureDoc();
    const source = 'The relation Q = n k P, where n is the scale. Another equation y 2 = x 3 + ax + b, and the point is valid.';
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.text = source;
    paragraph.rect = { x: 50, y: 380, w: 500, h: 30 };
    paragraph.widthMode = 'span';
    paragraph.characterRects = [...source].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 50 + index * 4, y: 380, w: 3.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;
    doc.blocks.push({
      id: 'broad-formula-duplicate', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 95, y: 377, w: 300, h: 20 }, order: 1.1,
      text: '∑\n2 s − 1\nl =1 l\ni =1 i i', splitAllowed: true, widthMode: 'span',
      characterRects: [
        { ch: '∑', sourceIndex: 0, pageIndex: 0, rect: { x: 110, y: 373, w: 4, h: 5 } },
        { ch: 'j', sourceIndex: 2, pageIndex: 0, rect: { x: 310, y: 373, w: 4, h: 5 } },
      ],
    });
    doc.blocks.push({
      id: 'formula-cluster-companion', docId: 'en', type: 'equation', pageIndex: 0,
      rect: { x: 105, y: 398, w: 20, h: 9 }, order: 1.05,
      text: 'x = y', splitAllowed: false, widthMode: 'span',
      characterRects: [...'x = y'].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 0,
        rect: { x: 105 + sourceIndex * 4, y: 398, w: 3.8, h: 9 },
      })),
    });
    doc.semanticUnits.push({
      id: 'broad-formula-duplicate', kind: 'paragraph',
      sourceText: '∑\n2 s − 1\nl =1 l\ni =1 i i', protectedTokens: [],
      layoutRegionId: 'r1', order: 1.1,
    });
    doc.layoutRegions[0].orderedUnitIds.splice(2, 0, 'broad-formula-duplicate');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.assetRegions.filter((asset) => asset.id.startsWith('p1-inline-formula')))
      .toHaveLength(2);
    expect(prepared.assetRegions.find((asset) => asset.id === 'p1-inline-formula')!.rect.y)
      .toBeLessThanOrEqual(372.5);
    expect(prepared.assetRegions.find((asset) => asset.id === 'p1-inline-formula')!.preserveRects)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ x: 109.5 }),
      ]));
    expect(prepared.assetRegions.find((asset) => asset.id === 'p1-inline-formula'))
      .toMatchObject({ requiresLargeOperator: true, formulaHint: expect.any(String) });
    expect(prepared.units.some((unit) => unit.id === 'broad-formula-duplicate')).toBe(false);
    expect(prepared.assetRegions.some((asset) => asset.id === 'broad-formula-duplicate')).toBe(false);
  });

  it('uses the raw formula substring when cleaned prose no longer shares the full block offset', () => {
    const doc = fixtureDoc();
    const raw = 'The definition Q = n k P, where n is the scale.\nP\nA scalar product k P = P + P, where P is a point.';
    const cleaned = 'The definition Q = n k P, where n is the scale. A scalar product k P = P + P, where P is a point.';
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.text = raw;
    paragraph.rect = { x: 50, y: 380, w: 500, h: 30 };
    paragraph.widthMode = 'span';
    paragraph.characterRects = [...raw].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 50 + index * 4, y: 380, w: 3.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = cleaned;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.assetRegions.filter((asset) => asset.id.startsWith('p1-inline-formula')))
      .toHaveLength(2);
    expect(prepared.units.find((unit) => unit.id === 'p1-inline-between-1')?.sourceText)
      .toContain('A scalar product');
  });

  it('canonicalizes spaced PDF decimals after geometry extraction', () => {
    const doc = fixtureDoc();
    const source = 'The implementation provides 2 . 08 × speedup and reaches 2 . 94 × at best.';
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.text = source;
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);
    const unit = prepared.units.find((candidate) => candidate.id === 'p1');

    expect(unit?.sourceText).toBe('The implementation provides 2.08×speedup and reaches 2.94×at best.');
    expect(unit?.protectedTokens).toEqual(['2.08', '2.94']);
  });

  it('stops an inline formula crop before following sentence prose', () => {
    const doc = fixtureDoc();
    const source = 'It convinces verifiers that y = f ( x, w ) is correctly calculated with public input x.';
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.text = source;
    paragraph.rect = { x: 50, y: 380, w: 500, h: 12 };
    paragraph.widthMode = 'span';
    paragraph.characterRects = [...source].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 50 + index * 5, y: 380, w: 4.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1-inline-after')?.sourceText)
      .toBe('is correctly calculated with public input x.');
    const formula = prepared.assetRegions.find((asset) => asset.id === 'p1-inline-formula')!;
    expect(formula.rect.w).toBeLessThan(80);
  });

  it('stops an inline formula before a following modal verb', () => {
    const doc = fixtureDoc();
    const source = 'Only the input w that satisfies y = f ( x, w ) can make verifiers accept.';
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.text = source;
    paragraph.rect = { x: 50, y: 380, w: 500, h: 12 };
    paragraph.widthMode = 'span';
    paragraph.characterRects = [...source].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 50 + index * 5, y: 380, w: 4.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1-inline-after')?.sourceText)
      .toBe('can make verifiers accept.');
    expect(prepared.assetRegions.find((asset) => asset.id === 'p1-inline-formula')!.rect.w)
      .toBeLessThan(80);
  });

  it('stops an inline formula before prose that describes task decomposition', () => {
    const doc = fixtureDoc();
    const source = 'We convert the original task Q = n k P into several subtasks, where n is the scale.';
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.text = source;
    paragraph.rect = { x: 50, y: 380, w: 500, h: 12 };
    paragraph.widthMode = 'span';
    paragraph.characterRects = [...source].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 50 + index * 5, y: 380, w: 4.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1-inline-after')?.sourceText)
      .toBe('into several subtasks, where n is the scale.');
    expect(prepared.assetRegions.find((asset) => asset.id === 'p1-inline-formula')!.rect.w)
      .toBeLessThan(60);
  });

  it('separates consecutive formulas joined by explanatory prose', () => {
    const doc = fixtureDoc();
    const source = "It is defined as a' = NTT(a) with elements a' = sum(a), where a is a scalar.";
    const paragraph = doc.blocks.find((block) => block.id === 'p1')!;
    paragraph.text = source;
    paragraph.rect = { x: 50, y: 380, w: 500, h: 12 };
    paragraph.widthMode = 'span';
    paragraph.characterRects = [...source].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 50 + index * 5, y: 380, w: 4.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.assetRegions.filter((asset) => asset.id.startsWith('p1-inline-formula')))
      .toHaveLength(2);
    expect(prepared.units.find((unit) => unit.id === 'p1-inline-between-1')?.sourceText)
      .toBe('with elements');
    expect(prepared.units.find((unit) => unit.id === 'p1-inline-after')?.sourceText)
      .toBe('where a is a scalar.');
  });

  it('expands a formula crop upward across numeric-only extracted lines using character geometry', () => {
    const doc = fixtureDoc();
    const preceding = doc.blocks.find((block) => block.id === 'p1')!;
    preceding.text = 'The values are defined below.\n𝑖 𝑗\n∑ 𝑖\n1';
    preceding.rect = { x: 330, y: 450, w: 230, h: 45 };
    preceding.characterRects = [
      ...[...'The values are defined below.'].map((ch, index) => ({
        ch, sourceIndex: index, pageIndex: 0,
        rect: { x: 330 + index * 4, y: 450, w: 3.8, h: 8 },
      })),
      { ch: '𝑖', sourceIndex: 30, pageIndex: 0, rect: { x: 390, y: 474, w: 5, h: 8 } },
      { ch: '𝑗', sourceIndex: 32, pageIndex: 0, rect: { x: 410, y: 474, w: 5, h: 8 } },
      { ch: '∑', sourceIndex: 34, pageIndex: 0, rect: { x: 374, y: 486, w: 8, h: 12 } },
      { ch: '𝑖', sourceIndex: 36, pageIndex: 0, rect: { x: 390, y: 487, w: 5, h: 8 } },
      { ch: '1', sourceIndex: 38, pageIndex: 0, rect: { x: 376, y: 490, w: 4, h: 7 } },
    ];
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = preceding.text;
    doc.blocks.push({
      id: 'eq1-tail', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 405, y: 528, w: 80, h: 14 }, order: 3.1,
      text: 'k = 1', splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'eq1-tail', kind: 'paragraph', sourceText: 'k = 1', protectedTokens: [],
      layoutRegionId: 'r1', order: 3.1,
    });
    doc.layoutRegions[0].orderedUnitIds.push('eq1-tail');

    const prepared = prepareImmutableStructure(doc);
    const formula = prepared.assetRegions.find((asset) => asset.id === 'eq1')!;

    expect(formula.rect.y).toBeLessThanOrEqual(472);
    expect(formula.rect.y + formula.rect.h).toBeGreaterThanOrEqual(542);
    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('The values are defined below.');
  });

  it('widens a Vision table crop to include a numeric table-body block on the same rows', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'table-body', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 52, y: 420, w: 238, h: 60 }, order: 4,
      text: 'PPA Frequency 100MHz Area 0.020mm2 Power 0.140mW',
      splitAllowed: true, widthMode: 'column',
    }, {
      id: 'other-table-body', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 330, y: 420, w: 230, h: 90 }, order: 5,
      text: 'Benchmark CPU 5.6 ZK-Tracer 2.7 Speedup 2063',
      splitAllowed: true, widthMode: 'column',
    });
    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'table', kind: 'table', pageIndex: 0,
      rect: { x: 52, y: 415, w: 165, h: 75 }, widthMode: 'column',
    }] });

    expect(prepared.assetRegions.find((asset) => asset.id === 'table')?.rect)
      .toEqual({ x: 52, y: 415, w: 238, h: 67 });
  });

  it('clamps a coarse column-table crop before the neighbouring prose column', () => {
    const doc = fixtureDoc();
    const neighbouringText = 'The neighbouring prose contains several numbers such as 200 MHz and 1.71 GB per second.';
    doc.blocks.push(
      {
        id: 'left-table-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 55, y: 82, w: 237, h: 9 }, order: 4,
        text: 'Table 1: Resource and Power Consumption', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'right-neighbour-prose', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 318, y: 100, w: 242, h: 110 }, order: 5,
        text: neighbouringText,
        characterRects: [...neighbouringText].map((ch, sourceIndex) => ({
          ch, sourceIndex, pageIndex: 0,
          rect: { x: 318 + sourceIndex * 2.7, y: 100, w: 2.5, h: 8 },
        })),
        splitAllowed: true, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      {
        id: 'left-table-caption', kind: 'table-title', sourceText: 'Table 1: Resource and Power Consumption',
        protectedTokens: [], layoutRegionId: 'r1', order: 4,
      },
      {
        id: 'right-neighbour-prose', kind: 'paragraph',
        sourceText: neighbouringText,
        protectedTokens: [], layoutRegionId: 'r1', order: 5,
      },
    );
    doc.layoutRegions[0].orderedUnitIds.push('left-table-caption', 'right-neighbour-prose');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-left-table', kind: 'table', pageIndex: 0,
      rect: { x: 49, y: 95, w: 281, h: 117 }, widthMode: 'column',
      captionUnitId: 'left-table-caption',
    }] });
    const table = prepared.assetRegions.find((asset) => asset.id === 'vision-left-table')!;

    expect(table.rect.x + table.rect.w).toBeLessThan(300);
    expect(prepared.units.find((unit) => unit.id === 'right-neighbour-prose')?.sourceText)
      .toBe(neighbouringText);
  });

  it('clamps a Vision span figure to its explicit column caption', () => {
    const doc = fixtureDoc();
    const neighbouringText = 'The right column paragraph must remain translatable beside the left-column figure.';
    doc.blocks.push(
      {
        id: 'left-figure-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 62, y: 220, w: 220, h: 10 }, order: 4,
        text: 'Figure 9: Left-column architecture.', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'right-neighbour-prose', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 330, y: 105, w: 230, h: 90 }, order: 5,
        text: neighbouringText,
        characterRects: [...neighbouringText].map((ch, sourceIndex) => ({
          ch, sourceIndex, pageIndex: 0,
          rect: { x: 330 + sourceIndex * 3, y: 105, w: 2.8, h: 8 },
        })),
        splitAllowed: true, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      {
        id: 'left-figure-caption', kind: 'caption', sourceText: 'Figure 9: Left-column architecture.',
        protectedTokens: [], layoutRegionId: 'r1', order: 4,
      },
      {
        id: 'right-neighbour-prose', kind: 'paragraph', sourceText: neighbouringText,
        protectedTokens: [], layoutRegionId: 'r1', order: 5,
      },
    );
    doc.layoutRegions[0].orderedUnitIds.push('left-figure-caption', 'right-neighbour-prose');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-left-figure', kind: 'figure', pageIndex: 0,
      rect: { x: 30, y: 92, w: 552, h: 112 }, widthMode: 'span',
      captionUnitId: 'left-figure-caption',
    }] });
    const figure = prepared.assetRegions.find((asset) => asset.id === 'vision-left-figure')!;

    expect(figure.widthMode).toBe('column');
    expect(figure.rect.x + figure.rect.w).toBeLessThan(300);
    expect(prepared.units.find((unit) => unit.id === 'right-neighbour-prose')?.sourceText)
      .toBe(neighbouringText);
  });

  it('extends a shallow table header crop through an attached visual-label table body', () => {
    const doc = fixtureDoc();
    const tableText = [
      'Optional', 'Operations', 'Elliptic Curves',
      'Groth BLS12-381, MNT4753,', 'BLS12-377',
      'Groth', 'BLS12-381', 'Groth', 'MNT4753',
      'MSM', 'BLS12-377', 'MSM', 'BLS12-377',
    ].join('\n');
    doc.blocks.push({
      id: 'continued-table-body', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 330, y: 430, w: 230, h: 110 }, order: 5,
      text: tableText, splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'continued-table-body', kind: 'paragraph', sourceText: tableText,
      protectedTokens: [], layoutRegionId: 'r1', order: 5,
    });
    doc.layoutRegions[0].orderedUnitIds.push('continued-table-body');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'table', kind: 'table', pageIndex: 0,
      rect: { x: 52, y: 415, w: 508, h: 35 }, widthMode: 'span',
    }] });

    const table = prepared.assetRegions.find((asset) => asset.id === 'table')!;
    expect(table.rect.y + table.rect.h).toBeGreaterThanOrEqual(542);
    expect(prepared.units.some((unit) => unit.id === 'continued-table-body')).toBe(false);
  });

  it('extends a shallow verified table through the numeric block attached to its caption', () => {
    const doc = fixtureDoc();
    const bodyText = [
      'CONFIGURATIONS AND SUPPORTED CURVES',
      'Platforms Detailed Configurations Supported Curves',
      'ASIC UMC 28nm DDR4 2400MHz BN-128 BLS12-381',
      'CPU 80 cores 377GB MNT4753',
      '8GPUs Nvidia GTX 1080 TI BLS12-381',
    ].join('\n');
    doc.blocks.push(
      {
        id: 'attached-table-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 418, y: 70, w: 32, h: 8 }, order: 4,
        text: 'TABLE I', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'attached-table-body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 323, y: 82, w: 220, h: 96 }, order: 5,
        text: bodyText, splitAllowed: true, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      { id: 'attached-table-caption', kind: 'caption', sourceText: 'TABLE I', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'attached-table-body', kind: 'paragraph', sourceText: bodyText, protectedTokens: [], layoutRegionId: 'r1', order: 5 },
    );
    doc.layoutRegions[0].orderedUnitIds.push('attached-table-caption', 'attached-table-body');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-attached-table', kind: 'table', pageIndex: 0,
      rect: { x: 313, y: 91, w: 272, h: 34 }, widthMode: 'column',
      captionUnitId: 'attached-table-caption',
    }] });
    const table = prepared.assetRegions.find((asset) => asset.id === 'vision-attached-table')!;

    expect(table.rect.y).toBeLessThanOrEqual(82);
    expect(table.rect.y + table.rect.h).toBeGreaterThanOrEqual(180);
    expect(prepared.units.some((unit) => unit.id === 'attached-table-body')).toBe(false);
  });

  it('does not let another block inline-formula padding erase overlapping prose', () => {
    const doc = fixtureDoc();
    const formulaText = 'The equation is defined as Q = n k P, where n is fixed.';
    const formula = doc.blocks.find((block) => block.id === 'eq1')!;
    formula.text = formulaText;
    formula.rect = { x: 50, y: 500, w: 300, h: 10 };
    formula.characterRects = [...formulaText].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: { x: 50 + sourceIndex * 5, y: 500, w: 4.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'eq1')!.sourceText = formulaText;

    const proseText = 'task and these subtasks can be expressed by Formula (1).';
    const prose = doc.blocks.find((block) => block.id === 'p1')!;
    prose.text = proseText;
    prose.rect = { x: 100, y: 512, w: 300, h: 10 };
    prose.characterRects = [...proseText].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: { x: 100 + sourceIndex * 5, y: 512, w: 4.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = proseText;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText).toBe(proseText);
  });

  it('removes a trailing cluster of extracted chart labels from prose', () => {
    const doc = fixtureDoc();
    const source = [
      'The process reads all trace data back from DRAM.',
      'Main Trace Generation ModAdd MMAC',
      'ModReduce', 'ModExp ModInv', '1.0', '0.8', '0.6', '0.4',
      'Proportion', '0.2', '0.0', 'Json RSA', 'Tendermint',
    ].join('\n');
    const body = doc.blocks.find((block) => block.id === 'p1')!;
    body.text = source;
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('The process reads all trace data back from DRAM.');
  });

  it('clusters out-of-order formula glyph blocks into one immutable crop', () => {
    const doc = fixtureDoc();
    const formula = doc.blocks.find((block) => block.id === 'eq1')!;
    formula.text = 'M =';
    formula.rect = { x: 225, y: 205, w: 24, h: 10 };
    formula.characterRects = [
      { ch: 'M', sourceIndex: 0, pageIndex: 0, rect: { x: 225, y: 205, w: 9, h: 10 } },
      { ch: '=', sourceIndex: 2, pageIndex: 0, rect: { x: 240, y: 205, w: 7, h: 10 } },
    ];
    doc.semanticUnits.find((unit) => unit.id === 'eq1')!.sourceText = formula.text;
    const fragments = [
      {
        id: 'math-wide-left', rect: { x: 150, y: 110, w: 160, h: 120 }, text: '∑ l = 1',
        chars: [
          { ch: '∑', sourceIndex: 0, pageIndex: 0, rect: { x: 180, y: 198, w: 14, h: 28 } },
          { ch: '1', sourceIndex: 1, pageIndex: 0, rect: { x: 183, y: 221, w: 4, h: 6 } },
        ],
      },
      {
        id: 'math-wide-right', rect: { x: 285, y: 150, w: 200, h: 120 }, text: '∑ l B = G',
        chars: [
          { ch: '∑', sourceIndex: 0, pageIndex: 0, rect: { x: 270, y: 198, w: 14, h: 28 } },
          { ch: 'B', sourceIndex: 1, pageIndex: 0, rect: { x: 292, y: 205, w: 8, h: 10 } },
          { ch: 'G', sourceIndex: 2, pageIndex: 0, rect: { x: 330, y: 205, w: 8, h: 10 } },
        ],
      },
    ];
    for (const fragment of fragments) {
      doc.blocks.push({
        id: fragment.id, docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: fragment.rect, order: 20, text: fragment.text,
        characterRects: fragment.chars, splitAllowed: true, widthMode: 'column',
      });
      doc.semanticUnits.push({
        id: fragment.id, kind: 'paragraph', sourceText: fragment.text,
        protectedTokens: [], layoutRegionId: 'r1', order: 20,
      });
      doc.layoutRegions[0].orderedUnitIds.push(fragment.id);
    }

    const prepared = prepareImmutableStructure(doc);
    const asset = prepared.assetRegions.find((candidate) => candidate.id === 'eq1')!;

    expect(asset.rect.x).toBeLessThanOrEqual(177);
    expect(asset.rect.x + asset.rect.w).toBeGreaterThanOrEqual(338);
    expect(asset.rect.y).toBeLessThanOrEqual(196);
    expect(asset.rect.y + asset.rect.h).toBeGreaterThanOrEqual(227);
    expect(prepared.units.some((unit) => unit.id === 'math-wide-left')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'math-wide-right')).toBe(false);
  });

  it('combines stacked display formulas and removes only the formula prefix from following prose', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((block) => block.id !== 'fig-caption');
    doc.semanticUnits = doc.semanticUnits.filter((unit) => unit.id !== 'fig-caption');
    doc.layoutRegions[0].orderedUnitIds = doc.layoutRegions[0].orderedUnitIds
      .filter((unitId) => unitId !== 'fig-caption');
    const charactersForLines = (lines: Array<{ text: string; x: number; y: number }>) => {
      let sourceIndex = 0;
      return lines.flatMap((line) => {
        const characters = [...line.text].map((ch, index) => ({
          ch, sourceIndex: sourceIndex + index, pageIndex: 0,
          rect: { x: line.x + index * 4.5, y: line.y, w: 4.2, h: 8 },
        }));
        sourceIndex += line.text.length + 1;
        return characters;
      });
    };
    const leadLines = [
      { text: 'A reduced scalar set contains many elements.', x: 55, y: 150 },
      { text: '∑ N', x: 135, y: 180 },
    ];
    const leadText = leadLines.map((line) => line.text).join('\n');
    doc.blocks.push({
      id: 'formula-lead-prose', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 55, y: 150, w: 220, h: 38 }, order: 9.5,
      text: leadText, characterRects: charactersForLines(leadLines),
      splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'formula-lead-prose', kind: 'paragraph', sourceText: leadText,
      protectedTokens: [], layoutRegionId: 'r1', order: 9.5,
    });
    doc.layoutRegions[0].orderedUnitIds.push('formula-lead-prose');
    const first = doc.blocks.find((block) => block.id === 'eq1')!;
    first.text = 'S = a';
    first.rect = { x: 130, y: 180, w: 45, h: 8 };
    first.characterRects = charactersForLines([{ text: first.text, x: 130, y: 180 }]);
    first.widthMode = 'column';
    const firstUnit = doc.semanticUnits.find((unit) => unit.id === 'eq1')!;
    firstUnit.sourceText = first.text;
    firstUnit.order = 10;

    const longFormulaExplanation = [
      { text: 'Bucket classification groups the points into different buckets.', x: 55, y: 266 },
      ...Array.from({ length: 14 }, (_, index) => ({
        text: `Additional explanatory prose remains translatable after the formula crop ${index + 1}.`,
        x: 55,
        y: 278 + index * 10,
      })),
    ];
    const blocks = [
      {
        id: 'formula-six-parts', type: 'paragraph' as const, order: 11,
        lines: [
          { text: 'i = 1', x: 100, y: 180 },
          { text: '(6)', x: 270, y: 180 },
        ],
      },
      {
        id: 'formula-seven', type: 'equation' as const, order: 12,
        lines: [{ text: 'R = k S', x: 125, y: 207 }],
      },
      {
        id: 'formula-seven-eight-parts', type: 'paragraph' as const, order: 13,
        lines: [
          { text: 'k = 0   (7)', x: 92, y: 207 },
          { text: 'MSM (a, G) = R', x: 65, y: 237 },
        ],
      },
      {
        id: 'formula-eight-tail-and-prose', type: 'paragraph' as const, order: 14,
        lines: [
          { text: 'j = 0', x: 130, y: 247 },
          { text: '(8)', x: 270, y: 247 },
          ...longFormulaExplanation,
        ],
      },
    ];
    for (const candidate of blocks) {
      const text = candidate.lines.map((line) => line.text).join('\n');
      const left = Math.min(...candidate.lines.map((line) => line.x));
      const top = Math.min(...candidate.lines.map((line) => line.y));
      const right = Math.max(...candidate.lines.map((line) => line.x + line.text.length * 4.5));
      const bottom = Math.max(...candidate.lines.map((line) => line.y + 8));
      doc.blocks.push({
        id: candidate.id, docId: 'en', type: candidate.type, pageIndex: 0,
        rect: { x: left, y: top, w: right - left, h: bottom - top },
        order: candidate.order, text, characterRects: charactersForLines(candidate.lines),
        splitAllowed: true, widthMode: 'column',
      });
      doc.semanticUnits.push({
        id: candidate.id,
        kind: candidate.type === 'equation' ? 'formula' : 'paragraph',
        sourceText: text, protectedTokens: [], layoutRegionId: 'r1', order: candidate.order,
      });
      doc.layoutRegions[0].orderedUnitIds.push(candidate.id);
    }

    const prepared = prepareImmutableStructure(doc);
    const formula = prepared.assetRegions.find((asset) => asset.id === 'eq1')!;

    expect(formula.rect.y).toBeLessThanOrEqual(178);
    expect(formula.rect.y + formula.rect.h).toBeGreaterThanOrEqual(255);
    expect(formula.rect.y + formula.rect.h).toBeLessThan(266);
    expect(prepared.units.some((unit) => unit.id === 'formula-seven')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'formula-seven-eight-parts')).toBe(false);
    const followingProse = prepared.units.find((unit) => unit.sourceText?.includes('Bucket classification'))?.sourceText;
    expect(followingProse).toContain('Bucket classification groups the points into different buckets.');
    expect(followingProse).toContain('Additional explanatory prose remains translatable');
    expect(followingProse).not.toContain('(8)');
  });

  it('removes symbol-font diagram labels after prose while keeping the immutable figure pixels', () => {
    const doc = fixtureDoc();
    const source = [
      'The proof system remains secure and supports private computation.',
      'POLY',
      'MSM',
      '݊ܣ INTT M NTT',
      'ࡼ',
      'PMULT',
    ].join('\n');
    const body = doc.blocks.find((block) => block.id === 'p1')!;
    body.text = source;
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('The proof system remains secure and supports private computation.');
  });

  it('removes table rows from a mixed text block while preserving prose below the immutable table', () => {
    const doc = fixtureDoc();
    const tableText = 'CPU Baseline 100MHz\nArea 0.020mm²\nThe architecture reduces memory latency.';
    let sourceIndex = 0;
    const lines = [
      { text: 'CPU Baseline 100MHz', y: 200 },
      { text: 'Area 0.020mm²', y: 212 },
      { text: 'The architecture reduces memory latency.', y: 242 },
    ];
    doc.blocks.push({
      id: 'table-and-prose', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 330, y: 200, w: 220, h: 52 }, order: 4, text: tableText,
      splitAllowed: true, widthMode: 'column',
      characterRects: lines.flatMap((line) => {
        const chars = [...line.text].map((ch, index) => ({
          ch, sourceIndex: sourceIndex + index, pageIndex: 0,
          rect: { x: 332 + index * 4, y: line.y, w: 3.8, h: 8 },
        }));
        sourceIndex += line.text.length + 1;
        return chars;
      }),
    });
    doc.semanticUnits.push({
      id: 'table-and-prose', kind: 'paragraph', sourceText: tableText,
      protectedTokens: [], layoutRegionId: 'r1', order: 4,
    });
    doc.layoutRegions[0].orderedUnitIds.push('table-and-prose');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'table-1', kind: 'table', pageIndex: 0,
      rect: { x: 325, y: 194, w: 230, h: 32 }, widthMode: 'column',
    }] });

    expect(prepared.units.find((unit) => unit.id === 'table-and-prose')?.sourceText)
      .toBe('The architecture reduces memory latency.');
  });

  it('removes only formula characters when an immutable formula shares a PDF text line with prose', () => {
    const doc = fixtureDoc();
    const source = 'The relation is Q = x + y and the discussion continues.';
    const formulaStart = source.indexOf('Q = x + y');
    const body = doc.blocks.find((block) => block.id === 'p1')!;
    body.text = source;
    body.rect = { x: 50, y: 100, w: 440, h: 12 };
    body.characterRects = [...source].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 50 + index * 6, y: 100, w: 5.5, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'inline-formula', kind: 'formula', pageIndex: 0,
      rect: { x: 50 + formulaStart * 6 - 1, y: 98, w: 'Q = x + y'.length * 6 + 2, h: 14 },
      widthMode: 'column',
    }] });

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('The relation is and the discussion continues.');
    expect(prepared.units.some((unit) => unit.id === 'inline-formula')).toBe(true);
  });

  it('drops a tiny PDF math fragment nested inside a larger prose block', () => {
    const doc = fixtureDoc();
    const parent = doc.blocks.find((block) => block.id === 'p1')!;
    parent.text = 'The result uses i = 1 for this iteration.';
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = parent.text;
    doc.blocks.push({
      id: 'nested-index', docId: 'en', type: 'equation', pageIndex: 0,
      rect: { x: 110, y: 112, w: 18, h: 7 }, order: 1.1,
      text: 'i = 1', splitAllowed: false, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'nested-index', kind: 'formula', sourceText: 'i = 1', protectedTokens: [],
      assetId: 'nested-index', layoutRegionId: 'r1', order: 1.1,
    });
    doc.layoutRegions[0].orderedUnitIds.splice(2, 0, 'nested-index');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.some((unit) => unit.id === 'nested-index')).toBe(false);
    expect(prepared.assetRegions.some((asset) => asset.id === 'nested-index')).toBe(false);
  });

  it('keeps a short table caption even when its PDF box is nested in a table text aggregate', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'short-table-caption', docId: 'en', type: 'caption', pageIndex: 0,
      rect: { x: 70, y: 400, w: 45, h: 9 }, order: 4,
      text: 'TABLE IV', splitAllowed: false, widthMode: 'column',
    }, {
      id: 'table-text-aggregate', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 50, y: 390, w: 230, h: 120 }, order: 4.1,
      text: 'Benchmark Architecture Throughput Latency Area Power Frequency',
      splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'short-table-caption', kind: 'caption', sourceText: 'TABLE IV', protectedTokens: [],
      layoutRegionId: 'r1', order: 4,
    }, {
      id: 'table-text-aggregate', kind: 'paragraph',
      sourceText: 'Benchmark Architecture Throughput Latency Area Power Frequency',
      protectedTokens: [], layoutRegionId: 'r1', order: 4.1,
    });
    doc.layoutRegions[0].orderedUnitIds.push('short-table-caption', 'table-text-aggregate');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-table', kind: 'table', pageIndex: 0,
      rect: { x: 50, y: 412, w: 230, h: 80 }, widthMode: 'column',
      captionUnitId: 'short-table-caption',
    }] });

    expect(prepared.units.find((unit) => unit.id === 'short-table-caption')).toMatchObject({
      kind: 'caption', sourceText: 'TABLE IV',
    });
    expect(prepared.assetRegions.find((asset) => asset.id === 'vision-table')?.captionUnitId)
      .toBe('short-table-caption');
  });

  it('uses the raw block box when faulty character geometry hides a nested math fragment', () => {
    const doc = fixtureDoc();
    const parent = doc.blocks.find((block) => block.id === 'p1')!;
    parent.text = 'The result uses j = 1 inside this mathematical discussion.';
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = parent.text;
    doc.blocks.push({
      id: 'misplaced-index', docId: 'en', type: 'equation', pageIndex: 0,
      rect: { x: 110, y: 112, w: 18, h: 7 }, order: 1.1,
      text: 'j = 1', splitAllowed: false, widthMode: 'column',
      characterRects: [...'j = 1'].map((ch, index) => ({
        ch, sourceIndex: index, pageIndex: 0,
        rect: { x: 360 + index * 4, y: 260, w: 3.8, h: 7 },
      })),
    });
    doc.semanticUnits.push({
      id: 'misplaced-index', kind: 'formula', sourceText: 'j = 1', protectedTokens: [],
      assetId: 'misplaced-index', layoutRegionId: 'r1', order: 1.1,
    });
    doc.layoutRegions[0].orderedUnitIds.splice(2, 0, 'misplaced-index');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.some((unit) => unit.id === 'misplaced-index')).toBe(false);
  });

  it('drops a partially overlapping next-page math fragment in a cross-page prose block by physical geometry', () => {
    const doc = fixtureDoc();
    doc.pageCount = 2;
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    doc.layoutRegions.push({
      id: 'r2', mode: 'single', sourcePage: 1,
      bounds: { x: 50, y: 50, w: 512, h: 692 }, orderedUnitIds: [],
    });
    const source = 'The continuation page uses j = 1 in the summation.';
    const parent = doc.blocks.find((block) => block.id === 'p1')!;
    parent.text = source;
    parent.fragments = [
      { pageIndex: 0, rect: parent.rect },
      { pageIndex: 1, rect: { x: 50, y: 100, w: 280, h: 10 } },
    ];
    parent.characterRects = [...source].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 1,
      rect: { x: 50 + index * 5, y: 100, w: 4.8, h: 9 },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;
    const fragmentStart = source.indexOf('j = 1');
    doc.blocks.push({
      id: 'cross-page-index', docId: 'en', type: 'equation', pageIndex: 1,
      rect: { x: 50 + fragmentStart * 5, y: 98, w: 25, h: 13 }, order: 1.1,
      text: 'j = 1', splitAllowed: false, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'cross-page-index', kind: 'formula', sourceText: 'j = 1', protectedTokens: [],
      assetId: 'cross-page-index', layoutRegionId: 'r2', order: 1.1,
    });
    doc.layoutRegions[1]!.orderedUnitIds.push('cross-page-index');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.some((unit) => unit.id === 'cross-page-index')).toBe(false);
    expect(prepared.assetRegions.some((asset) => asset.id === 'cross-page-index')).toBe(false);
  });

  it('removes scattered math extraction lines around a real prose continuation', () => {
    const doc = fixtureDoc();
    const source = [
      'n', '1', 'n', '∑ n', 's',
      'm P . Specifically, as shown in Figure 6,',
      'i =1 i i',
    ].join('\n');
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    block.text = source;
    block.rect = { x: 50, y: 100, w: 230, h: 33 };
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('Specifically, as shown in Figure 6,');
  });

  it('reattaches repeated detached PDF subscripts to their prose variables', () => {
    const doc = fixtureDoc();
    const source = [
      'W asted , T otal , and perCore are the amounts of',
      'res', 'res', 'res',
      'wasted, total, and per-core resources, respectively.',
      'The smaller P erCore leads to less W asted because one',
      'res', 'res',
      'core leaves fewer resources unused.',
    ].join('\n');
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    block.text = source;
    block.rect = { x: 50, y: 100, w: 230, h: 70 };
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);
    const normalized = prepared.units.find((unit) => unit.id === 'p1')?.sourceText;

    expect(normalized).toContain('Wasted_res , Total_res , and perCore_res');
    expect(normalized).toContain('smaller PerCore_res leads to less Wasted_res');
    expect(normalized).not.toMatch(/(?:^|\n)res(?:\n|$)/);
  });

  it('removes a detached piecewise-brace glyph beside a verified formula', () => {
    const doc = fixtureDoc();
    const source = 'The resource model is defined in Equation (1).\n⎧';
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    block.text = source;
    block.rect = { x: 50, y: 100, w: 230, h: 24 };
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-formula-1', kind: 'formula', pageIndex: 0,
      rect: { x: 50, y: 118, w: 230, h: 24 }, widthMode: 'column',
    }] });

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('The resource model is defined in Equation (1).');
  });

  it('removes the fragmented tail of a piecewise resource formula below its immutable first row', () => {
    const doc = fixtureDoc();
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    block.text = 'res\nres\nres\nT otal\n(1)\n⎩ N = \u0002\nres \u0003\nP erCore\nres';
    block.rect = { x: 69.804, y: 382.1686, w: 218.84, h: 32.0444 };
    block.fragments = [{ pageIndex: 0, rect: { ...block.rect } }];
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = block.text;

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'resource-formula', kind: 'formula', pageIndex: 0,
      rect: { x: 69.804, y: 376.3263, w: 174.2, h: 9.9626 }, widthMode: 'column',
    }] });

    expect(prepared.units.some((unit) => unit.id === 'p1')).toBe(false);
    expect(prepared.regions[0].orderedUnitIds).not.toContain('p1');
  });

  it('removes a fragmented formula tail after its neighboring formula is detected deterministically', () => {
    const doc = fixtureDoc();
    const residual = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    residual.text = 'res\nres\nres\nT otal\n(1)\n⎩ N = \u0002\nres \u0003\nP erCore\nres';
    residual.rect = { x: 69.804, y: 382.1686, w: 218.84, h: 32.0444 };
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = residual.text;
    const formula = doc.blocks.find((candidate) => candidate.id === 'eq1')!;
    formula.text = '⎨ W asted = T otal − N × P erCore';
    formula.rect = { x: 69.804, y: 376.3263, w: 174.2, h: 9.9626 };
    const formulaUnit = doc.semanticUnits.find((unit) => unit.id === 'eq1')!;
    formulaUnit.sourceText = formula.text;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.assetRegions).toContainEqual(expect.objectContaining({ id: 'eq1', kind: 'formula' }));
    expect(prepared.units.some((unit) => unit.id === 'p1')).toBe(false);
  });

  it('preserves a wrapped equation term before explanatory prose when the previous line ends in an operator', () => {
    const doc = fixtureDoc();
    const source = [
      'The coefficients must satisfy the condition 4 a 3 +',
      '27 b 2 ≠ 0. Here, the parameters define the elliptic curve.',
    ].join('\n');
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    block.text = source;
    block.rect = { x: 50, y: 100, w: 230, h: 20 };
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toContain('27 b 2 ≠ 0. Here');
  });

  it('preserves short function words and opening punctuation at wrapped prose line starts', () => {
    const doc = fixtureDoc();
    doc.pageCount = 2;
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    const source = [
      'The first page contains ordinary prose.',
      'in the process, the trace is generated.',
      'to the pipeline, the result is returned.',
      'on-the-fly conversion remains enabled.',
      '(FastModRed) performs the reduction.',
    ].join('\n');
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    block.text = source;
    block.fragments = [
      { pageIndex: 0, rect: block.rect },
      { pageIndex: 1, rect: { x: 50, y: 100, w: 230, h: 50 } },
    ];
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText).toBe(source);
  });

  it('preserves decimal and percentage prefixes on wrapped prose lines', () => {
    const doc = fixtureDoc();
    doc.pageCount = 2;
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    const source = [
      'The first page contains ordinary prose.',
      '3.63 times in time consumption and 5.06 times in clock cycles.',
      '7.8% compared with the unoptimized architecture.',
    ].join('\n');
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    block.text = source;
    block.fragments = [
      { pageIndex: 0, rect: block.rect },
      { pageIndex: 1, rect: { x: 50, y: 100, w: 230, h: 30 } },
    ];
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);
    const preparedSource = prepared.units.find((unit) => unit.id === 'p1')?.sourceText ?? '';

    expect(preparedSource).toContain('3.63 times');
    expect(preparedSource).toContain('5.06 times');
    expect(preparedSource).toContain('7.8%');
  });

  it('removes unrenderable PDF control accents from vector variables', () => {
    const doc = fixtureDoc();
    const source = 'Scalar vectors S \u0003 n and A \u0003 n remain readable.';
    doc.blocks.find((block) => block.id === 'p1')!.text = source;
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);
    const preparedSource = prepared.units.find((unit) => unit.id === 'p1')?.sourceText ?? '';

    expect(preparedSource).toBe('Scalar vectors S  n and A  n remain readable.');
    expect(preparedSource).not.toContain('\u0003');
  });

  it('removes symbol-only extraction lines next to a verified display formula', () => {
    const doc = fixtureDoc();
    const source = [
      '∑',
      'which is equal to the result of the subtask n m P .',
      '∑ i =1 i i ∑ ij ∑ i j =1 j',
    ].join('\n');
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    block.text = source;
    block.rect = { x: 50, y: 100, w: 230, h: 80 };
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc, {
      verifiedAssetRegions: [{
        id: 'vision-formula', kind: 'formula', pageIndex: 0,
        rect: { x: 120, y: 205, w: 170, h: 55 }, widthMode: 'column',
      }],
    });

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('which is equal to the result of the subtask n m P .');
  });

  it('uses the Vision page layout and removes partially overlapping PDF formula duplicates', () => {
    const doc = fixtureDoc();
    doc.layoutRegions[0]!.mode = 'double';
    const duplicate = doc.blocks.find((block) => block.id === 'p1')!;
    duplicate.text = '∑\ni = 1\ni i\n(2)';
    duplicate.rect = { x: 50, y: 100, w: 200, h: 60 };
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = duplicate.text;

    const prepared = prepareImmutableStructure(doc, {
      pageLayouts: new Map([[0, 'single']]),
      verifiedAssetRegions: [{
        id: 'vision-formula', kind: 'formula', pageIndex: 0,
        rect: { x: 60, y: 110, w: 100, h: 20 }, widthMode: 'column',
      }],
    });

    expect(prepared.regions[0]?.mode).toBe('single');
    expect(prepared.units.some((unit) => unit.id === 'p1')).toBe(false);
    expect(prepared.units.find((unit) => unit.id === 'vision-formula')).toMatchObject({
      kind: 'formula', assetId: 'vision-formula',
    });
  });

  it('masks next-page algorithm text merged into the previous page block using character page coordinates', () => {
    const doc = fixtureDoc();
    doc.pageCount = 2;
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    doc.layoutRegions.push({
      id: 'r2', mode: 'single', sourcePage: 1,
      bounds: { x: 50, y: 50, w: 512, h: 692 }, orderedUnitIds: [],
    });
    const prose = 'The discussion continues.';
    const algorithm = 'Require: scalar vector';
    const source = `${prose}\n${algorithm}`;
    const body = doc.blocks.find((block) => block.id === 'p1')!;
    body.text = source;
    body.rect = { x: 50, y: 100, w: 230, h: 40 };
    body.characterRects = [
      ...[...prose].map((ch, index) => ({
        ch, sourceIndex: index, pageIndex: 0,
        rect: { x: 50 + index * 4, y: 100, w: 3.8, h: 8 },
      })),
      ...[...algorithm].map((ch, index) => ({
        ch, sourceIndex: prose.length + 1 + index, pageIndex: 1,
        rect: { x: 60 + index * 4, y: 120, w: 3.8, h: 8 },
      })),
    ];
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'page-2-code', kind: 'code', pageIndex: 1,
      rect: { x: 55, y: 112, w: 180, h: 24 }, widthMode: 'column',
    }] });

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText).toBe(prose);
  });

  it('separates overlapping arXiv metadata from a sentence and restores the sentence to its visual paragraph', () => {
    const doc = fixtureDoc();
    const metadata = 'arXiv:2605.25493v2 [cs.AR] 26 May 2026';
    const suffix = 'rapidly evolving into the dominant system performance bottleneck.';
    const mixed = `${metadata} ${suffix}`;
    doc.blocks.push({
      id: 'arxiv-mixed', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 32, y: 420, w: 528, h: 10 }, order: 0.5, text: mixed,
      splitAllowed: true, widthMode: 'span',
      characterRects: [
        ...[...metadata].map((ch, index) => ({
          ch, sourceIndex: index, pageIndex: 0,
          rect: { x: 32 + index * 8, y: 420, w: 7, h: 8 },
        })),
        ...[...suffix].map((ch, index) => ({
          ch, sourceIndex: metadata.length + 1 + index, pageIndex: 0,
          rect: { x: 330 + index * 3.5, y: 420, w: 3.2, h: 8 },
        })),
      ],
    });
    doc.semanticUnits.push({
      id: 'arxiv-mixed', kind: 'paragraph', sourceText: mixed,
      protectedTokens: [], layoutRegionId: 'r1', order: 0.5,
    });
    doc.layoutRegions[0].orderedUnitIds.splice(1, 0, 'arxiv-mixed');
    const targetBlock = doc.blocks.find((block) => block.id === 'p1')!;
    targetBlock.rect = { x: 330, y: 370, w: 230, h: 100 };
    targetBlock.text = 'This unoptimized front-end is\nFor instance, further gains are limited.';
    targetBlock.characterRects = [
      ...[...'This unoptimized front-end is'].map((ch, index) => ({
        ch, sourceIndex: index, pageIndex: 0,
        rect: { x: 330 + index * 4, y: 408, w: 3.8, h: 8 },
      })),
      ...[...'For instance, further gains are limited.'].map((ch, index) => ({
        ch, sourceIndex: 30 + index, pageIndex: 0,
        rect: { x: 330 + index * 4, y: 432, w: 3.8, h: 8 },
      })),
    ];
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = targetBlock.text;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'arxiv-mixed')).toEqual(expect.objectContaining({
      kind: 'reference', sourceText: metadata,
    }));
    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe(`This unoptimized front-end is\n${suffix}\nFor instance, further gains are limited.`);
  });

  it('removes running headers embedded into a body block while preserving the body text', () => {
    const doc = fixtureDoc();
    const body = doc.blocks.find((block) => block.id === 'p1')!;
    body.rect = { x: 50, y: 380, w: 230, h: 70 };
    body.text = 'The translated body remains here.\nJieran Cui et al.';
    body.characterRects = [
      ...[...'The translated body remains here.'].map((ch, index) => ({
        ch, sourceIndex: index, pageIndex: 0,
        rect: { x: 50 + index * 4, y: 400, w: 3.8, h: 8 },
      })),
      ...[...'Jieran Cui et al.'].map((ch, index) => ({
        ch, sourceIndex: 34 + index, pageIndex: 0,
        rect: { x: 480 + index * 3, y: 59, w: 2.8, h: 7 },
      })),
    ];
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = body.text;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('The translated body remains here.');
  });

  it('removes repeated page furniture merged into body endings across pages', () => {
    const doc = fixtureDoc();
    const furniture = 'Jieran Cui et al.';
    doc.pageCount = 2;
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    const body = doc.blocks.find((block) => block.id === 'p1')!;
    body.text = `The translated body remains here.\n${furniture}`;
    body.characterRects = undefined;
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = body.text;
    doc.blocks.push({
      id: 'running-author', docId: 'en', type: 'paragraph', pageIndex: 1,
      rect: { x: 480, y: 58, w: 80, h: 8 }, order: 7,
      text: furniture, splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'running-author', kind: 'paragraph', sourceText: furniture,
      protectedTokens: [], layoutRegionId: 'r1', order: 7,
    });
    doc.layoutRegions[0].orderedUnitIds.push('running-author');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('The translated body remains here.');
    expect(prepared.units.some((unit) => unit.id === 'running-author')).toBe(false);
    expect(prepared.regions[0].orderedUnitIds).not.toContain('running-author');
  });

  it('removes an embedded publisher permission footer without deleting adjacent body prose', () => {
    const doc = fixtureDoc();
    const source = [
      'The discussion begins on the first page.',
      'Corresponding author: author@example.edu.',
      'Permission to make digital or hard copies of all or part of this work for personal use is granted.',
      'Copyrights for components of this work owned by others must be honored.',
      'DAC ’24, June 23–27, 2024, San Francisco, CA, USA',
      '© 2024 Copyright held by the owner/author(s). Publication rights licensed to ACM.',
      'ACM ISBN 979-8-4007-0601-1/24/06. . . $15.00',
      'https://doi.org/10.1145/3649329.3658259',
      'The discussion continues on the following page.',
    ].join('\n');
    const body = doc.blocks.find((block) => block.id === 'p1')!;
    body.text = source;
    body.characterRects = undefined;
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText).toBe([
      'The discussion begins on the first page.',
      'The discussion continues on the following page.',
    ].join('\n'));
  });

  it('creates a full-width horizontal row for source figures aligned on the same band', () => {
    const doc = fixtureDoc();
    doc.semanticUnits.push(
      { id: 'cap-a', kind: 'caption', sourceText: 'Figure 2: A', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'cap-b', kind: 'caption', sourceText: 'Figure 3: B', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
    );
    doc.layoutRegions[0].orderedUnitIds.push('cap-a', 'cap-b');
    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [
      { id: 'fig-a', kind: 'figure', pageIndex: 0, rect: { x: 50, y: 200, w: 160, h: 100 }, widthMode: 'column', captionUnitId: 'cap-a' },
      { id: 'fig-b', kind: 'figure', pageIndex: 0, rect: { x: 225, y: 202, w: 160, h: 98 }, widthMode: 'column', captionUnitId: 'cap-b' },
      { id: 'fig-c', kind: 'figure', pageIndex: 0, rect: { x: 400, y: 200, w: 160, h: 100 }, widthMode: 'column' },
    ] });

    const row = prepared.regions.find((region) => region.presentation === 'horizontal');
    expect(row).toMatchObject({ mode: 'full-width', sourcePage: 0 });
    expect(row?.orderedUnitIds).toEqual(['fig-a', 'cap-a', 'fig-b', 'cap-b', 'fig-c']);
    expect(prepared.units.filter((unit) => row?.orderedUnitIds.includes(unit.id))
      .every((unit) => unit.layoutRegionId === row?.id)).toBe(true);
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

  it('keeps a biography page two-column and groups staggered author portraits into one gallery row', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((candidate) => !['fig-caption', 'eq1'].includes(candidate.id));
    doc.semanticUnits = doc.semanticUnits.filter((candidate) => !['fig-caption', 'eq1'].includes(candidate.id));
    doc.layoutRegions[0]!.orderedUnitIds = doc.layoutRegions[0]!.orderedUnitIds
      .filter((id) => !['fig-caption', 'eq1'].includes(id));
    const biographies = [
      'Alice Smith received the Ph.D. degree from Example University.',
      'Bob Jones received the M.S. degree from Example University.',
      'Carol Lee received the B.Eng. degree from Example University.',
      'David Wu received the Ph.D. degree from Example University.',
    ].join('\n');
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    block.text = biographies;
    block.rect = { x: 180, y: 80, w: 360, h: 560 };
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = biographies;
    const portraits = [80, 230, 380, 530].map((y, index) => ({
      id: `portrait-${index + 1}`, kind: 'figure' as const, pageIndex: 0,
      rect: { x: index < 2 ? 50 : 470, y, w: 72, h: 88 }, widthMode: 'column' as const,
    }));

    const prepared = prepareImmutableStructure(doc, {
      pageLayouts: new Map([[0, 'single']]),
      verifiedAssetRegions: portraits,
    });

    const gallery = prepared.regions.find((region) => region.presentation === 'horizontal');
    expect(gallery?.orderedUnitIds).toEqual(portraits.map((portrait) => portrait.id));
    expect(prepared.regions.find((region) => region.id === 'r1')?.mode).toBe('double');
  });

  it('recovers a centered full-width table and starts the following column figure after it', () => {
    const doc = fixtureDoc();
    doc.blocks = [
      {
        id: 'table-ii-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 290, y: 65, w: 34, h: 8 }, order: 1,
        text: 'TABLE II', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'table-ii-left', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 105, w: 60, h: 9 }, order: 2,
        text: 'BN128',
        splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'table-ii-left-tail', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 135, w: 90, h: 55 }, order: 2.5,
        text: 'MNT4-298\nBLS12-381\nMNT4-753',
        splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'table-ii-right', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 420, y: 100, w: 120, h: 118 }, order: 3,
        text: '3\n200\n4\n1\n100\n4\n200\n6\n2\n100\n3\n180\n4\n1\n100',
        splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'table-iii-boundary', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 150, y: 245, w: 40, h: 8 }, order: 4,
        text: 'TABLE III', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'figure-10-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 330, y: 388, w: 210, h: 8 }, order: 5,
        text: 'Fig. 10. Computing power improvement.', splitAllowed: false, widthMode: 'column',
      },
    ];
    doc.semanticUnits = [
      { id: 'table-ii-caption', kind: 'caption', sourceText: 'TABLE II', protectedTokens: [], layoutRegionId: 'r1', order: 1 },
      { id: 'table-ii-left', kind: 'paragraph', sourceText: doc.blocks[1]!.text, protectedTokens: [], layoutRegionId: 'r1', order: 2 },
      { id: 'table-ii-left-tail', kind: 'paragraph', sourceText: doc.blocks[2]!.text, protectedTokens: [], layoutRegionId: 'r1', order: 2.5 },
      { id: 'table-ii-right', kind: 'paragraph', sourceText: doc.blocks[3]!.text, protectedTokens: [], layoutRegionId: 'r1', order: 3 },
      { id: 'figure-10-caption', kind: 'caption', sourceText: 'Fig. 10. Computing power improvement.', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
    ];
    doc.layoutRegions = [{
      id: 'r1', mode: 'double', sourcePage: 0,
      bounds: { x: 50, y: 65, w: 490, h: 331 },
      orderedUnitIds: ['table-ii-caption', 'table-ii-left', 'table-ii-left-tail', 'table-ii-right', 'figure-10-caption'],
    }];

    const prepared = prepareImmutableStructure(doc);
    const table = prepared.assetRegions.find((asset) => asset.id === 'table-ii-caption-asset')!;
    const figure = prepared.assetRegions.find((asset) => asset.id === 'figure-10-caption-asset')!;

    expect(table).toMatchObject({ widthMode: 'span' });
    expect(table.rect.x).toBeLessThanOrEqual(50);
    expect(table.rect.x + table.rect.w).toBeGreaterThanOrEqual(540);
    expect(table.rect.y).toBeCloseTo(74);
    expect(table.rect.y + table.rect.h).toBeGreaterThanOrEqual(224);
    expect(table.rect.y + table.rect.h).toBeLessThan(245);
    expect(figure.rect.y).toBeGreaterThanOrEqual(224);
    expect(figure.rect.x).toBeGreaterThan(300);
    expect(prepared.units.some((unit) => unit.id === 'table-ii-left')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'table-ii-left-tail')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'table-ii-right')).toBe(false);
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

  it('translates only an embedded figure caption and extends the next figure through its label cluster', () => {
    const doc = fixtureDoc();
    const embeddedText = [
      'Fig. 1. The workflow of the prover has a constraint',
      'system size of five.',
      'POLY',
      'MSM',
      'INTT M NTT',
      'PMULT PADD',
    ].join('\n');
    let sourceIndex = 0;
    const lines = embeddedText.split('\n');
    const lineYs = [220, 232, 260, 272, 284, 296];
    doc.blocks.push(
      {
        id: 'embedded-figure-caption', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 330, y: 220, w: 220, h: 86 }, order: 4,
        text: embeddedText, splitAllowed: true, widthMode: 'column',
        characterRects: lines.flatMap((line, lineIndex) => {
          const chars = [...line].map((ch, index) => ({
            ch, sourceIndex: sourceIndex + index, pageIndex: 0,
            rect: { x: 330 + index * 4, y: lineYs[lineIndex]!, w: 3.8, h: 8 },
          }));
          sourceIndex += line.length + 1;
          return chars;
        }),
      },
      {
        id: 'figure-2-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 330, y: 385, w: 220, h: 10 }, order: 5,
        text: 'Fig. 2. Prover computations.', splitAllowed: false, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      { id: 'embedded-figure-caption', kind: 'paragraph', sourceText: embeddedText, protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'figure-2-caption', kind: 'caption', sourceText: 'Fig. 2. Prover computations.', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
    );
    doc.layoutRegions[0].orderedUnitIds.push('embedded-figure-caption', 'figure-2-caption');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [
      {
        id: 'vision-figure-1', kind: 'figure', pageIndex: 0,
        rect: { x: 325, y: 100, w: 230, h: 110 }, widthMode: 'column',
        captionUnitId: 'embedded-figure-caption',
      },
      {
        id: 'vision-figure-2', kind: 'figure', pageIndex: 0,
        rect: { x: 325, y: 320, w: 230, h: 60 }, widthMode: 'column',
        captionUnitId: 'figure-2-caption',
      },
    ] });
    const embeddedCaption = prepared.units.find((unit) => unit.id === 'embedded-figure-caption')!;
    const secondFigure = prepared.assetRegions.find((asset) => asset.id === 'vision-figure-2')!;

    expect(embeddedCaption).toMatchObject({
      kind: 'caption',
      sourceText: 'Fig. 1. The workflow of the prover has a constraint system size of five.',
    });
    expect(secondFigure.rect.y).toBeLessThan(260);
  });

  it('does not extend a following figure through text already owned by a verified table', () => {
    const doc = fixtureDoc();
    const tableText = [
      'Curve FPGA LUT REG DSP BRAM URAM Core No Freq CLK',
      'BN128 U200 663K 56.1 982K 41.5 1560 22.8',
      'BN128 U250 946K 54.7 1370K 39.6 2532 20.6',
      'MNT4 298 715K 60.5 950K 40.2 1824 26.7',
      'BLS12 381 799K 67.6 955K 40.4 1995 29.2',
      'MNT4 753 1081K 62.6 1277K 37.0 4242 34.5',
    ].join('\n');
    let sourceIndex = 0;
    const tableLines = tableText.split('\n');
    doc.blocks.push(
      {
        id: 'verified-table-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 282, y: 65, w: 35, h: 8 }, order: 10,
        text: 'TABLE II', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'verified-table-body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 301, y: 92, w: 241, h: 126 }, order: 11,
        text: tableText, splitAllowed: true, widthMode: 'column',
        characterRects: tableLines.flatMap((line, lineIndex) => {
          const chars = [...line].map((ch, index) => ({
            ch, sourceIndex: sourceIndex + index, pageIndex: 0,
            rect: { x: 301 + index * 3.6, y: 92 + lineIndex * 20, w: 3.4, h: 8 },
          }));
          sourceIndex += line.length + 1;
          return chars;
        }),
      },
      {
        id: 'following-figure-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 305, y: 388, w: 210, h: 8 }, order: 12,
        text: 'Fig. 10. Computing power improvement.', splitAllowed: false, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      { id: 'verified-table-caption', kind: 'caption', sourceText: 'TABLE II', protectedTokens: [], layoutRegionId: 'r1', order: 10 },
      { id: 'verified-table-body', kind: 'paragraph', sourceText: tableText, protectedTokens: [], layoutRegionId: 'r1', order: 11 },
      { id: 'following-figure-caption', kind: 'caption', sourceText: 'Fig. 10. Computing power improvement.', protectedTokens: [], layoutRegionId: 'r1', order: 12 },
    );
    doc.layoutRegions[0]!.orderedUnitIds.push(
      'verified-table-caption', 'verified-table-body', 'following-figure-caption',
    );

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [
      {
        id: 'verified-table', kind: 'table', pageIndex: 0,
        rect: { x: 26, y: 86, w: 542, h: 93 }, widthMode: 'span',
        captionUnitId: 'verified-table-caption',
      },
      {
        id: 'following-figure', kind: 'figure', pageIndex: 0,
        rect: { x: 309, y: 230, w: 255, h: 155 }, widthMode: 'column',
        captionUnitId: 'following-figure-caption',
      },
    ] });

    expect(prepared.assetRegions.find((asset) => asset.id === 'following-figure')?.rect.y).toBe(230);
  });

  it('rejects a prose-heavy Vision formula rectangle and preserves only its inline equation', () => {
    const doc = fixtureDoc();
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    const source = 'The NTT computation a = NTT(a) is defined on two arrays.';
    block.text = source;
    block.rect = { x: 50, y: 400, w: 500, h: 14 };
    block.characterRects = [...source].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: { x: 50 + sourceIndex * 7, y: 400, w: 7, h: 10 },
    }));
    const unit = doc.semanticUnits.find((candidate) => candidate.id === 'p1')!;
    unit.sourceText = source;
    unit.protectedTokens = [];

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-wide-formula', kind: 'formula', pageIndex: 0,
      rect: { x: 50, y: 398, w: 500, h: 18 }, widthMode: 'span',
    }] });

    expect(prepared.assetRegions.some((asset) => asset.id === 'vision-wide-formula')).toBe(false);
    expect(prepared.assetRegions).toContainEqual(expect.objectContaining({
      id: 'p1-inline-formula', kind: 'formula',
    }));
    expect(prepared.units.find((candidate) => candidate.id === 'p1-inline-before')?.sourceText)
      .toBe('The NTT computation');
    expect(prepared.units.find((candidate) => candidate.id === 'p1-inline-after')?.sourceText)
      .toBe('is defined on two arrays.');
  });

  it('rejects a Vision formula rectangle around one short prose continuation line', () => {
    const doc = fixtureDoc();
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    const source = 'corresponding architecture to accelerate it.';
    block.text = source;
    block.rect = { x: 330, y: 620, w: 190, h: 10 };
    block.characterRects = [...source].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: { x: 330 + sourceIndex * 4, y: 620, w: 3.8, h: 8 },
    }));
    doc.semanticUnits.find((candidate) => candidate.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-false-formula', kind: 'formula', pageIndex: 0,
      rect: { x: 328, y: 618, w: 194, h: 14 }, widthMode: 'column',
    }] });

    expect(prepared.assetRegions.some((asset) => asset.id === 'vision-false-formula')).toBe(false);
    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText).toBe(source);
  });

  it('rejects a column-wide Vision formula rectangle around an IEEE subsection heading', () => {
    const doc = fixtureDoc();
    const block = doc.blocks.find((candidate) => candidate.id === 'p1')!;
    const source = 'B. FPGA Hardware Resource Utilization';
    block.type = 'section';
    block.text = source;
    block.rect = { x: 50, y: 400, w: 240, h: 12 };
    block.characterRects = [...source].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: { x: 50 + sourceIndex * 5, y: 400, w: 4.8, h: 9 },
    }));
    const unit = doc.semanticUnits.find((candidate) => candidate.id === 'p1')!;
    unit.kind = 'heading';
    unit.sourceText = source;

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-false-heading-formula', kind: 'formula', pageIndex: 0,
      rect: { x: 45, y: 396, w: 250, h: 20 }, widthMode: 'column',
    }] });

    expect(prepared.assetRegions.some((asset) => asset.id === 'vision-false-heading-formula')).toBe(false);
    expect(prepared.units.find((unit) => unit.id === 'p1')).toMatchObject({
      sourceText: 'FPGA Hardware Resource Utilization', headingNumber: 'B', headingLevel: 2,
    });
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

  it('places captionless Vision formulas between the surrounding prose in source geometry order', () => {
    const doc = fixtureDoc();
    doc.layoutMode = 'single';
    doc.layoutRegions = [
      {
        id: 'body', mode: 'full-width', sourcePage: 0,
        bounds: { x: 50, y: 80, w: 500, h: 620 }, orderedUnitIds: ['before', 'after'],
      },
      {
        id: 'fragments', mode: 'double', sourcePage: 0,
        bounds: { x: 80, y: 120, w: 440, h: 260 }, orderedUnitIds: ['formula-fragment'],
      },
    ];
    doc.blocks = [
      { id: 'before', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 50, y: 100, w: 500, h: 70 }, order: 10, text: 'Before the equation.', splitAllowed: true, widthMode: 'span' },
      { id: 'formula-fragment', docId: 'en', type: 'equation', pageIndex: 0, rect: { x: 260, y: 190, w: 40, h: 10 }, order: 50, text: 'M =', splitAllowed: false, widthMode: 'column' },
      { id: 'after', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 50, y: 250, w: 500, h: 70 }, order: 11, text: 'After the equation.', splitAllowed: true, widthMode: 'span' },
    ];
    doc.semanticUnits = [
      { id: 'before', kind: 'paragraph', sourceText: 'Before the equation.', protectedTokens: [], layoutRegionId: 'body', order: 10 },
      { id: 'formula-fragment', kind: 'formula', sourceText: 'M =', protectedTokens: [], assetId: 'formula-fragment', layoutRegionId: 'fragments', order: 50 },
      { id: 'after', kind: 'paragraph', sourceText: 'After the equation.', protectedTokens: [], layoutRegionId: 'body', order: 11 },
    ];

    const prepared = prepareImmutableStructure(doc, {
      verifiedAssetRegions: [{
        id: 'vision-formula', kind: 'formula', pageIndex: 0,
        rect: { x: 50, y: 180, w: 500, h: 60 }, widthMode: 'span',
      }],
      pageLayouts: new Map([[0, 'single']]),
    });

    const body = prepared.regions.find((region) => region.id === 'body')!;
    expect(body.orderedUnitIds).toEqual(['before', 'vision-formula', 'after']);
    expect(prepared.units.find((unit) => unit.id === 'vision-formula')).toMatchObject({
      layoutRegionId: 'body', order: 10.5,
    });
  });

  it('places a captionless Vision algorithm between surrounding prose instead of appending it', () => {
    const doc = fixtureDoc();
    doc.layoutMode = 'single';
    doc.layoutRegions = [{
      id: 'body', mode: 'full-width', sourcePage: 0,
      bounds: { x: 50, y: 80, w: 500, h: 620 }, orderedUnitIds: ['before', 'after'],
    }];
    doc.blocks = [
      { id: 'before', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 50, y: 100, w: 500, h: 70 }, order: 10, text: 'Before the algorithm.', splitAllowed: true, widthMode: 'span' },
      { id: 'after', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 50, y: 360, w: 500, h: 70 }, order: 11, text: 'After the algorithm.', splitAllowed: true, widthMode: 'span' },
    ];
    doc.semanticUnits = [
      { id: 'before', kind: 'paragraph', sourceText: 'Before the algorithm.', protectedTokens: [], layoutRegionId: 'body', order: 10 },
      { id: 'after', kind: 'paragraph', sourceText: 'After the algorithm.', protectedTokens: [], layoutRegionId: 'body', order: 11 },
    ];

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-code', kind: 'code', pageIndex: 0,
      rect: { x: 50, y: 190, w: 500, h: 140 }, widthMode: 'span',
    }] });

    const body = prepared.regions.find((region) => region.id === 'body')!;
    expect(body.orderedUnitIds).toEqual(['before', 'vision-code', 'after']);
    expect(prepared.units.find((unit) => unit.id === 'vision-code')).toMatchObject({
      kind: 'code', assetId: 'vision-code', layoutRegionId: 'body', order: 10.5,
    });
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

  it('starts a column figure after prose carried by a cross-column text block', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((block) => block.id !== 'fig-caption');
    doc.semanticUnits = doc.semanticUnits.filter((unit) => unit.id !== 'fig-caption');
    doc.layoutRegions[0]!.orderedUnitIds = doc.layoutRegions[0]!.orderedUnitIds
      .filter((id) => id !== 'fig-caption');
    const lines = [
      { text: 'The left column sentence anchors the aggregate block.', x: 50, y: 450 },
      { text: 'This right column paragraph appears immediately before the large source figure.', x: 330, y: 100 },
      { text: 'It provides enough natural language evidence to establish the visual boundary.', x: 330, y: 112 },
      { text: 'to mask latency of data input.', x: 330, y: 124 },
    ];
    let sourceIndex = 0;
    const text = lines.map((line) => line.text).join('\n');
    const characterRects = lines.flatMap((line) => {
      const characters = [...line.text].map((ch, index) => ({
        ch, sourceIndex: sourceIndex + index, pageIndex: 0,
        rect: { x: line.x + index * 3, y: line.y, w: 2.8, h: 8 },
      }));
      sourceIndex += line.text.length + 1;
      return characters;
    });
    doc.blocks.push(
      {
        id: 'cross-column-prose', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 450, w: 230, h: 12 }, order: 4,
        fragments: [
          { pageIndex: 0, rect: { x: 50, y: 450, w: 230, h: 12 } },
          { pageIndex: 0, rect: { x: 330, y: 100, w: 230, h: 32 } },
        ],
        text, characterRects, splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'right-figure-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 330, y: 400, w: 200, h: 12 }, order: 5,
        text: 'Figure 8: Right-column architecture.', splitAllowed: false, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      { id: 'cross-column-prose', kind: 'paragraph', sourceText: text, protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'right-figure-caption', kind: 'caption', sourceText: 'Figure 8: Right-column architecture.', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
    );
    doc.layoutRegions[0]!.orderedUnitIds.push('cross-column-prose', 'right-figure-caption');

    const prepared = prepareImmutableStructure(doc);
    const figure = prepared.assetRegions.find((asset) => asset.id === 'right-figure-caption-asset')!;

    expect(figure.rect.y).toBeGreaterThanOrEqual(138);
    expect(figure.rect.y).toBeLessThan(148);
  });

  it('recovers a column caption polluted by prose from the opposite column', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((block) => block.id !== 'fig-caption');
    doc.semanticUnits = doc.semanticUnits.filter((unit) => unit.id !== 'fig-caption');
    doc.layoutRegions[0]!.orderedUnitIds = doc.layoutRegions[0]!.orderedUnitIds
      .filter((id) => id !== 'fig-caption');
    const leftCaption = 'Figure 9: Left strategy where';
    const rightProse = 'Right prose continues';
    const polluted = `${leftCaption} ${rightProse}`;
    const characters = [
      ...[...leftCaption].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 0,
        rect: { x: 50 + sourceIndex * 3, y: 500, w: 2.8, h: 8 },
      })),
      ...[...rightProse].map((ch, index) => ({
        ch, sourceIndex: leftCaption.length + 1 + index, pageIndex: 0,
        rect: { x: 330 + index * 3, y: 500, w: 2.8, h: 8 },
      })),
    ];
    doc.blocks.push(
      {
        id: 'left-prior-content', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 300, w: 230, h: 100 }, order: 4,
        text: '10 20 30', splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'polluted-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 50, y: 500, w: 510, h: 10 }, order: 5,
        text: polluted, characterRects: characters, splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'caption-continuation-1', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 510, w: 230, h: 10 }, order: 6,
        text: 'Core 0 remains in one clock strat-', splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'caption-continuation-2', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 520, w: 230, h: 10 }, order: 7,
        text: 'egy.', splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'right-prose-behind-caption', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 330, y: 300, w: 230, h: 220 }, order: 8,
        text: 'The opposite column continues through the caption baseline without belonging to the figure.',
        splitAllowed: true, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      { id: 'left-prior-content', kind: 'paragraph', sourceText: '10 20 30', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'polluted-caption', kind: 'caption', sourceText: polluted, protectedTokens: [], layoutRegionId: 'caption-region', order: 5 },
      { id: 'caption-continuation-1', kind: 'paragraph', sourceText: 'Core 0 remains in one clock strat-', protectedTokens: [], layoutRegionId: 'caption-region', order: 6 },
      { id: 'caption-continuation-2', kind: 'paragraph', sourceText: 'egy.', protectedTokens: [], layoutRegionId: 'r1', order: 7 },
      { id: 'right-prose-behind-caption', kind: 'paragraph', sourceText: 'The opposite column continues through the caption baseline without belonging to the figure.', protectedTokens: [], layoutRegionId: 'r1', order: 8 },
    );
    doc.layoutRegions[0]!.orderedUnitIds.push(
      'left-prior-content', 'caption-continuation-2', 'right-prose-behind-caption',
    );
    doc.layoutRegions.push({
      id: 'caption-region', mode: 'full-width', sourcePage: 0,
      bounds: { x: 50, y: 500, w: 510, h: 30 },
      orderedUnitIds: ['polluted-caption', 'caption-continuation-1'],
    });

    const prepared = prepareImmutableStructure(doc);
    const caption = prepared.units.find((unit) => unit.id === 'polluted-caption');
    const figure = prepared.assetRegions.find((asset) => asset.id === 'polluted-caption-asset');

    expect(caption?.sourceText)
      .toBe('Figure 9: Left strategy where Core 0 remains in one clock strategy.');
    expect(prepared.units.some((unit) => unit.id.startsWith('caption-continuation-'))).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'right-prose-behind-caption')).toBe(true);
    expect(figure).toMatchObject({ widthMode: 'column', rect: { y: 406 } });
    expect(figure!.rect.x + figure!.rect.w).toBeLessThan(doc.pages[0]!.width / 2 + 8);
  });

  it('uses a trailing diagram-label cluster inside a mixed prose block as the figure top', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((block) => block.id !== 'fig-caption');
    doc.semanticUnits = doc.semanticUnits.filter((unit) => unit.id !== 'fig-caption');
    doc.layoutRegions[0]!.orderedUnitIds = doc.layoutRegions[0]!.orderedUnitIds
      .filter((id) => id !== 'fig-caption');
    const prose = [
      'The controller processes requests from the input queue and preserves ordering.',
      'The conflict buffer provides enough capacity for the delayed operation.',
      'Therefore, execution completes without introducing overflow errors.',
    ];
    const labels = [
      'Base address for Bucket RAM',
      'Batch size',
      'Destination selector Bucket RAM Temp RAM Output FIFO',
      'OP size addr_b addr_t src_sel dest_sel step_b step_t',
      'Instruction type',
      'Base address for Temp RAM',
    ];
    const lines = [...prose, ...labels];
    const text = lines.join('\n');
    let sourceIndex = 0;
    const lineYs = [100, 112, 124, 220, 232, 244, 256, 268, 280];
    const characterRects = lines.flatMap((line, lineIndex) => {
      const characters = [...line].map((ch, index) => ({
        ch, sourceIndex: sourceIndex + index, pageIndex: 0,
        rect: { x: 54 + index * 3, y: lineYs[lineIndex]!, w: 2.8, h: 8 },
      }));
      sourceIndex += line.length + 1;
      return characters;
    });
    doc.blocks.push(
      {
        id: 'mixed-prose-labels', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 54, y: 100, w: 242, h: 188 }, order: 4,
        text, characterRects, splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'mixed-figure-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 120, y: 300, w: 110, h: 9 }, order: 5,
        text: 'Figure 5: instruction', splitAllowed: false, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      {
        id: 'mixed-prose-labels', kind: 'paragraph', sourceText: text,
        protectedTokens: [], layoutRegionId: 'r1', order: 4,
      },
      {
        id: 'mixed-figure-caption', kind: 'caption', sourceText: 'Figure 5: instruction',
        protectedTokens: [], layoutRegionId: 'r1', order: 5,
      },
    );
    doc.layoutRegions[0].orderedUnitIds.push('mixed-prose-labels', 'mixed-figure-caption');

    const prepared = prepareImmutableStructure(doc);
    const figure = prepared.assetRegions.find((asset) => asset.id === 'mixed-figure-caption-asset')!;

    expect(figure.rect.y).toBeCloseTo(214);
    expect(figure.rect.y + figure.rect.h).toBeCloseTo(294);
    expect(prepared.units.find((unit) => unit.id === 'mixed-prose-labels')?.sourceText)
      .toBe(prose.join('\n'));
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

  it('uses an isolated full-width numeric region as the lower boundary of a table', () => {
    const doc = fixtureDoc();
    const tableText = [
      'Workload Size Poly Dense SpG1 SpG2 Total Speedup',
      'AES 16383 0.103 0.345 1.07 0.43 1.20 480x',
      'SHA2 32767 0.212 0.626 2.05 0.03 2.05 434x',
      'RSA 131071 0.994 2.207 3.84 0.95 6.85 544x',
    ].join('\n');
    doc.blocks = [
      {
        id: 'isolated-table-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 212, y: 82, w: 188, h: 9 }, order: 1,
        text: 'Table 7: Full Proof Runtime vs. CPU', splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'isolated-table-body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 89, y: 109, w: 423, h: 79 }, order: 2,
        text: tableText, splitAllowed: true, widthMode: 'span',
      },
    ];
    doc.semanticUnits = [
      {
        id: 'isolated-table-caption', kind: 'caption',
        sourceText: 'Table 7: Full Proof Runtime vs. CPU', protectedTokens: [],
        layoutRegionId: 'isolated-table-region', order: 1,
      },
      {
        id: 'isolated-table-body', kind: 'paragraph', sourceText: tableText,
        protectedTokens: [], layoutRegionId: 'isolated-table-region', order: 2,
      },
    ];
    doc.layoutRegions = [{
      id: 'isolated-table-region', mode: 'full-width', sourcePage: 0,
      bounds: { x: 89, y: 82, w: 423, h: 106 },
      orderedUnitIds: ['isolated-table-caption', 'isolated-table-body'],
    }];

    const prepared = prepareImmutableStructure(doc);
    const table = prepared.assetRegions.find((asset) => asset.id === 'isolated-table-caption-asset');

    expect(table).toMatchObject({ kind: 'table', widthMode: 'span' });
    expect(table!.rect.y + table!.rect.h).toBeCloseTo(194);
    expect(prepared.units.some((unit) => unit.id === 'isolated-table-body')).toBe(false);
  });

  it('rejoins a detached inline table reference instead of inferring a table asset', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((block) => !['fig-caption', 'eq1'].includes(block.id));
    doc.semanticUnits = doc.semanticUnits.filter((unit) => !['fig-caption', 'eq1'].includes(unit.id));
    doc.layoutRegions[0].orderedUnitIds = doc.layoutRegions[0].orderedUnitIds
      .filter((id) => !['fig-caption', 'eq1'].includes(id));
    const prose = 'The performance of our work and comparison with other works are shown in';
    doc.blocks.push(
      {
        id: 'comparison-prose', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 220, w: 230, h: 52 }, order: 4,
        text: prose, splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'detached-table-reference', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 50, y: 274, w: 39, h: 10 }, order: 5,
        text: 'Table VI.', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'following-prose', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 286, w: 230, h: 80 }, order: 6,
        text: 'For MSM mode, comparisons are performed with prior work.',
        splitAllowed: true, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      { id: 'comparison-prose', kind: 'paragraph', sourceText: prose, protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'detached-table-reference', kind: 'caption', sourceText: 'Table VI.', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
      { id: 'following-prose', kind: 'paragraph', sourceText: 'For MSM mode, comparisons are performed with prior work.', protectedTokens: [], layoutRegionId: 'r1', order: 6 },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'comparison-prose', 'detached-table-reference', 'following-prose',
    );

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'comparison-prose')?.sourceText)
      .toBe(`${prose} Table VI.`);
    expect(prepared.units.some((unit) => unit.id === 'detached-table-reference')).toBe(false);
    expect(prepared.assetRegions.some((asset) => asset.kind === 'table')).toBe(false);
    expect(prepared.regions[0].orderedUnitIds).not.toContain('detached-table-reference');
  });

  it('clamps a derived column figure inside the gutter and outer page margin', () => {
    const doc = fixtureDoc();
    doc.blocks.push(
      {
        id: 'figure-labels', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 330, y: 90, w: 220, h: 80 }, order: 4,
        text: 'Buffer\nR R R R\nAcc Acc\nFold Fold\nFSU\nHash',
        splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'safe-column-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 350, y: 180, w: 176, h: 9 }, order: 5,
        text: 'Figure 10: Timing of the pipeline', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'page-edge-aggregate', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 318, y: 200, w: 295, h: 300 }, order: 6,
        text: 'Ordinary prose whose coarse PDF box leaks beyond the physical page edge.',
        splitAllowed: true, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      { id: 'figure-labels', kind: 'paragraph', sourceText: 'Buffer\nR R R R\nAcc Acc\nFold Fold\nFSU\nHash', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'safe-column-caption', kind: 'caption', sourceText: 'Figure 10: Timing of the pipeline', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
      { id: 'page-edge-aggregate', kind: 'paragraph', sourceText: 'Ordinary prose whose coarse PDF box leaks beyond the physical page edge.', protectedTokens: [], layoutRegionId: 'r1', order: 6 },
    );
    doc.layoutRegions[0].orderedUnitIds.push('figure-labels', 'safe-column-caption', 'page-edge-aggregate');

    const prepared = prepareImmutableStructure(doc);
    const figure = prepared.assetRegions.find((asset) => asset.id === 'safe-column-caption-asset')!;

    expect(figure.rect.x).toBeGreaterThanOrEqual(612 / 2 + 612 * 0.012);
    expect(figure.rect.x + figure.rect.w).toBeLessThanOrEqual(612 * 0.93);
  });

  it('recovers a cross-page numeric table placed immediately above its split caption', () => {
    const doc = fixtureDoc();
    doc.pages.push({ pageIndex: 1, width: 612, height: 792, columns: [] });
    const prose = 'the performance vs. area Pareto frontier for both configurations';
    const rows = [
      'Prover Send Verifier Total vs. PipeZK',
      'AES 0.1 0.8 0.1 1.1 7.4x',
      'SHA 0.3 0.9 0.2 1.3 12.1x',
      'RSA 1.3 1.0 0.2 2.5 19.6x',
      'gmean 16.8x',
    ];
    const source = [prose, ...rows].join('\n');
    let sourceIndex = 0;
    const characterRects = [prose, ...rows].flatMap((line, lineIndex) => {
      const pageIndex = lineIndex === 0 ? 0 : 1;
      const y = lineIndex === 0 ? 680 : 50 + (lineIndex - 1) * 16;
      const chars = [...line].map((ch, index) => ({
        ch, sourceIndex: sourceIndex + index, pageIndex,
        rect: { x: 58 + index * 4, y, w: 3.8, h: 9 },
      }));
      sourceIndex += line.length + 1;
      return chars;
    });
    doc.blocks.push(
      {
        id: 'cross-page-table-body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 312, y: 670, w: 250, h: 10 }, order: 4,
        fragments: [
          { pageIndex: 0, rect: { x: 312, y: 670, w: 250, h: 10 } },
          { pageIndex: 1, rect: { x: 58, y: 50, w: 226, h: 73 } },
        ],
        characterRects, text: source, splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'bottom-table-caption', docId: 'en', type: 'caption', pageIndex: 1,
        rect: { x: 49, y: 133, w: 252, h: 9 }, order: 5,
        text: 'TABLE V: Per-benchmark end-to-end runtime in seconds for',
        splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'bottom-table-caption-tail', docId: 'en', type: 'paragraph', pageIndex: 1,
        rect: { x: 49, y: 144, w: 204, h: 9 }, order: 6,
        text: 'NoCap along with end-to-end speedups vs. PipeZK.',
        splitAllowed: true, widthMode: 'column',
      },
    );
    doc.layoutRegions.push({
      id: 'page-two-left', mode: 'double', sourcePage: 1,
      bounds: { x: 49, y: 48, w: 252, h: 110 },
      orderedUnitIds: ['cross-page-table-body', 'bottom-table-caption', 'bottom-table-caption-tail'],
    });
    doc.semanticUnits.push(
      { id: 'cross-page-table-body', kind: 'paragraph', sourceText: source, protectedTokens: [], layoutRegionId: 'page-two-left', order: 4 },
      { id: 'bottom-table-caption', kind: 'caption', sourceText: 'TABLE V: Per-benchmark end-to-end runtime in seconds for', protectedTokens: [], layoutRegionId: 'page-two-left', order: 5 },
      { id: 'bottom-table-caption-tail', kind: 'paragraph', sourceText: 'NoCap along with end-to-end speedups vs. PipeZK.', protectedTokens: [], layoutRegionId: 'page-two-left', order: 6 },
    );

    const prepared = prepareImmutableStructure(doc);
    const table = prepared.assetRegions.find((asset) => asset.id === 'bottom-table-caption-asset');
    const region = prepared.regions.find((candidate) => candidate.id === 'page-two-left')!;

    expect(table).toMatchObject({ kind: 'table', pageIndex: 1, widthMode: 'column' });
    expect(table!.rect.y).toBeLessThanOrEqual(44);
    expect(table!.rect.y + table!.rect.h).toBeCloseTo(129);
    expect(prepared.units.find((unit) => unit.id === 'bottom-table-caption')?.sourceText)
      .toBe('TABLE V: Per-benchmark end-to-end runtime in seconds for NoCap along with end-to-end speedups vs. PipeZK.');
    expect(prepared.units.some((unit) => unit.id === 'bottom-table-caption-tail')).toBe(false);
    expect(region.orderedUnitIds.indexOf('bottom-table-caption-asset'))
      .toBe(region.orderedUnitIds.indexOf('bottom-table-caption') - 1);
  });

  it('extends a caption-derived span table through a right-column label block', () => {
    const doc = fixtureDoc();
    const rightLabels = [
      'Optional', 'Operations', 'Elliptic Curves',
      'Groth BLS12-381, MNT4753,', 'BLS12-377',
      'Groth', 'BLS12-381', 'Groth', 'MNT4753',
      'MSM', 'BLS12-377', 'MSM', 'BLS12-377',
    ].join('\n');
    doc.blocks.push(
      { id: 'cross-table-caption', docId: 'en', type: 'caption', pageIndex: 0, rect: { x: 103, y: 230, w: 389, h: 18 }, order: 4, text: 'Table 9: Optional operations', splitAllowed: false, widthMode: 'span' },
      { id: 'cross-table-right', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 324, y: 257, w: 139, h: 116 }, order: 5, text: rightLabels, splitAllowed: true, widthMode: 'column' },
      { id: 'cross-table-span-boundary', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 103, y: 279, w: 389, h: 12 }, order: 6, text: 'Curve 12 381 4753', splitAllowed: true, widthMode: 'span' },
    );
    doc.semanticUnits.push(
      { id: 'cross-table-caption', kind: 'caption', sourceText: 'Table 9: Optional operations', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'cross-table-right', kind: 'paragraph', sourceText: rightLabels, protectedTokens: [], layoutRegionId: 'r1', order: 5 },
      { id: 'cross-table-span-boundary', kind: 'paragraph', sourceText: 'Curve 12 381 4753', protectedTokens: [], layoutRegionId: 'r1', order: 6 },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'cross-table-caption', 'cross-table-right', 'cross-table-span-boundary',
    );

    const prepared = prepareImmutableStructure(doc);
    const table = prepared.assetRegions.find((asset) => asset.id === 'cross-table-caption-asset')!;

    expect(table.rect.y + table.rect.h).toBeGreaterThanOrEqual(375);
    expect(prepared.units.some((unit) => unit.id === 'cross-table-right')).toBe(false);
  });

  it('extends a shallow full-width table header through a column-classified numeric body', () => {
    const doc = fixtureDoc();
    const tableRows = [
      'CPU MSMAC',
      'Size 1 core 64 cores 1 FPGA 4 FPGAs',
      '2^18 2.45s 122.47ms 10.65ms 6.30ms 230x 11x 389x 19x',
      '2^19 4.63s 218.28ms 19.45ms 9.79ms 238x 11x 473x 22x',
      '2^20 9.09s 399.61ms 34.15ms 14.39ms 266x 12x 632x 28x',
    ].join('\n');
    doc.blocks.push(
      {
        id: 'msmac-table-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 182.7, y: 82.4, w: 246.3, h: 9 }, order: 4,
        text: 'Table 3: Performance comparison between MSMAC and CPU',
        splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'msmac-table-body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 90.7, y: 108.9, w: 210.1, h: 112.1 }, order: 5,
        text: tableRows, splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'msmac-table-header', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 115.5, y: 118.8, w: 405.8, h: 8 }, order: 6,
        text: '1 core 64 cores 1 FPGA 4 FPGAs v.s. CPU (1 core) v.s. CPU (64 cores)',
        splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'msmac-conclusion', docId: 'en', type: 'section', pageIndex: 0,
        rect: { x: 318, y: 240.2, w: 87.8, h: 10.9 }, order: 7,
        text: '6 CONCLUSION', splitAllowed: true, widthMode: 'column',
      },
    );
    doc.semanticUnits.push(
      {
        id: 'msmac-table-caption', kind: 'caption',
        sourceText: 'Table 3: Performance comparison between MSMAC and CPU',
        protectedTokens: [], layoutRegionId: 'r1', order: 4,
      },
      {
        id: 'msmac-table-body', kind: 'paragraph', sourceText: tableRows,
        protectedTokens: [], layoutRegionId: 'r1', order: 5,
      },
      {
        id: 'msmac-table-header', kind: 'paragraph',
        sourceText: '1 core 64 cores 1 FPGA 4 FPGAs v.s. CPU (1 core) v.s. CPU (64 cores)',
        protectedTokens: [], layoutRegionId: 'r1', order: 6,
      },
      {
        id: 'msmac-conclusion', kind: 'heading', sourceText: '6 CONCLUSION',
        protectedTokens: [], layoutRegionId: 'r1', order: 7,
      },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'msmac-table-caption', 'msmac-table-body', 'msmac-table-header', 'msmac-conclusion',
    );

    const prepared = prepareImmutableStructure(doc);
    const table = prepared.assetRegions.find((asset) => asset.id === 'msmac-table-caption-asset')!;

    expect(table.rect.y).toBeCloseTo(97.4);
    expect(table.rect.y + table.rect.h).toBeGreaterThanOrEqual(223);
    expect(prepared.units.some((unit) => unit.id === 'msmac-table-body')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'msmac-table-header')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'msmac-conclusion')).toBe(true);
  });

  it('trims an over-tall Vision table crop before the following prose paragraph', () => {
    const doc = fixtureDoc();
    doc.blocks.push(
      { id: 'vision-table-caption', docId: 'en', type: 'caption', pageIndex: 0, rect: { x: 330, y: 490, w: 200, h: 14 }, order: 4, text: 'Table 2: Results', splitAllowed: false, widthMode: 'column' },
      { id: 'vision-table-body', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 330, y: 510, w: 200, h: 48 }, order: 5, text: 'Benchmark CPU Accelerator Speedup 1.0 2.0', splitAllowed: true, widthMode: 'column' },
      { id: 'vision-table-prose', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 330, y: 575, w: 200, h: 80 }, order: 6, text: 'This ordinary paragraph explains the measured memory access latency and must be translated instead of becoming table pixels.', splitAllowed: true, widthMode: 'column' },
    );
    doc.semanticUnits.push(
      { id: 'vision-table-caption', kind: 'caption', sourceText: 'Table 2: Results', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'vision-table-body', kind: 'paragraph', sourceText: 'Benchmark CPU Accelerator Speedup 1.0 2.0', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
      { id: 'vision-table-prose', kind: 'paragraph', sourceText: 'This ordinary paragraph explains the measured memory access latency and must be translated instead of becoming table pixels.', protectedTokens: [], layoutRegionId: 'r1', order: 6 },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'vision-table-caption', 'vision-table-body', 'vision-table-prose',
    );

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-over-tall-table', kind: 'table', pageIndex: 0,
      rect: { x: 328, y: 506, w: 204, h: 110 }, widthMode: 'column',
      captionUnitId: 'vision-table-caption',
    }] });
    const asset = prepared.assetRegions.find((candidate) => candidate.id === 'vision-over-tall-table');

    expect(asset?.rect.h).toBe(54);
    expect(prepared.units.some((unit) => unit.id === 'vision-table-body')).toBe(false);
    expect(prepared.units.find((unit) => unit.id === 'vision-table-prose')?.sourceText)
      .toContain('must be translated');
  });

  it('preserves trailing table rows when PDF.js merges them with following table notes', () => {
    const doc = fixtureDoc();
    const mergedText = [
      '2^22 1785 3081 1129 6899 10.30 1329 153 1763',
      '2^23 3831 5686 1659 12119 19.50 2579 306 3431',
      '(1) MUL in Bellperson is executed in CPU, while that in cuZK is executed in GPU.',
    ].join('\n');
    const lineStarts = [0, mergedText.indexOf('\n') + 1, mergedText.lastIndexOf('\n') + 1];
    const lineYs = [550, 562, 586];
    const characterRects = [...mergedText].map((ch, sourceIndex) => {
      const lineIndex = sourceIndex >= lineStarts[2]! ? 2 : sourceIndex >= lineStarts[1]! ? 1 : 0;
      return {
        ch, sourceIndex, pageIndex: 0,
        rect: { x: 330 + (sourceIndex - lineStarts[lineIndex]!) * 2, y: lineYs[lineIndex]!, w: 2, h: 10 },
      };
    });
    doc.blocks.push(
      { id: 'merged-table-caption', docId: 'en', type: 'caption', pageIndex: 0, rect: { x: 328, y: 490, w: 204, h: 14 }, order: 4, text: 'Table 6: Results', splitAllowed: false, widthMode: 'column' },
      { id: 'merged-table-tail', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 330, y: 550, w: 200, h: 46 }, order: 5, text: mergedText, characterRects, splitAllowed: true, widthMode: 'column' },
    );
    doc.semanticUnits.push(
      { id: 'merged-table-caption', kind: 'caption', sourceText: 'Table 6: Results', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'merged-table-tail', kind: 'paragraph', sourceText: mergedText, protectedTokens: [], layoutRegionId: 'r1', order: 5 },
    );
    doc.layoutRegions[0].orderedUnitIds.push('merged-table-caption', 'merged-table-tail');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-merged-table', kind: 'table', pageIndex: 0,
      rect: { x: 328, y: 506, w: 204, h: 100 }, widthMode: 'column',
      captionUnitId: 'merged-table-caption',
    }] });
    const asset = prepared.assetRegions.find((candidate) => candidate.id === 'vision-merged-table');

    expect(asset).toBeDefined();
    const assetBottom = asset!.rect.y + asset!.rect.h;
    expect(assetBottom).toBe(584);
    expect(assetBottom).toBeGreaterThan(572);
  });

  it('extends a table crop through a short final note line crossing its bottom edge', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'clipped-table-note-tail', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 70, y: 201, w: 220, h: 8 }, order: 4,
      text: 'where Groth represents all operations in its protocol.',
      splitAllowed: false, widthMode: 'span',
    });

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-table-with-clipped-note', kind: 'table', pageIndex: 0,
      rect: { x: 60, y: 100, w: 250, h: 106 }, widthMode: 'span',
    }] });
    const asset = prepared.assetRegions.find((candidate) => candidate.id === 'vision-table-with-clipped-note');

    const assetBottom = asset ? asset.rect.y + asset.rect.h : undefined;
    expect(assetBottom).toBe(211);
  });

  it('moves an uppercase table description into the translated caption and keeps it out of the immutable crop', () => {
    const doc = fixtureDoc();
    const description = 'R ESULTS FOR Z CASH ( LATENCIES IN SECONDS ).';
    const body = `${description}\nASIC CPU GPU\nAES 1.0 2.0 3.0`;
    const rows = [
      { text: description, y: 594 },
      { text: 'ASIC CPU GPU', y: 612 },
      { text: 'AES 1.0 2.0 3.0', y: 630 },
    ];
    let sourceIndex = 0;
    doc.blocks.push(
      {
        id: 'table-v-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 270, y: 580, w: 72, h: 10 }, order: 4,
        text: 'TABLE V', splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'table-v-body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 70, y: 594, w: 470, h: 48 }, order: 5,
        text: body, splitAllowed: true, widthMode: 'span',
        characterRects: rows.flatMap((row) => {
          const result = [...row.text].map((ch, index) => ({
            ch, sourceIndex: sourceIndex + index, pageIndex: 0,
            rect: { x: 80 + index * 4, y: row.y, w: 3.8, h: 9 },
          }));
          sourceIndex += row.text.length + 1;
          return result;
        }),
      },
    );
    doc.semanticUnits.push(
      {
        id: 'table-v-caption', kind: 'caption', sourceText: 'TABLE V',
        protectedTokens: [], layoutRegionId: 'r1', order: 4,
      },
      {
        id: 'table-v-body', kind: 'paragraph', sourceText: body,
        protectedTokens: [], layoutRegionId: 'r1', order: 5,
      },
    );
    doc.layoutRegions[0].orderedUnitIds.push('table-v-caption', 'table-v-body');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'table-v-asset', kind: 'table', pageIndex: 0,
      rect: { x: 65, y: 610, w: 480, h: 45 }, widthMode: 'span',
      captionUnitId: 'table-v-caption',
    }] });

    expect(prepared.units.find((unit) => unit.id === 'table-v-caption')?.sourceText)
      .toBe('TABLE V\nRESULTS FOR ZCASH ( LATENCIES IN SECONDS ).');
    expect(prepared.units.some((unit) => unit.sourceText?.includes('R ESULTS FOR Z CASH'))).toBe(false);
    expect(prepared.assetRegions.find((asset) => asset.id === 'table-v-asset')?.rect.y)
      .toBeGreaterThanOrEqual(606);
  });

  it('moves extracted small-caps descriptions into consecutive table captions without character geometry', () => {
    const doc = fixtureDoc();
    doc.blocks.push(
      {
        id: 'pipe-table-v-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 292.171, y: 70.5316, w: 31.8079, h: 7.5715 }, order: 4,
        text: 'TABLE V', splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'pipe-table-v-description', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 202.2216, y: 79.0495, w: 211.7062, h: 7.5715 }, order: 5,
        text: 'R ESULTS FOR DIFFERENT WORKLOADS ( LATENCIES IN SECONDS ).', splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'pipe-table-vi-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 290.91, y: 189.5205, w: 34.3292, h: 7.5715 }, order: 6,
        text: 'TABLE VI', splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'pipe-table-vi-body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 230.55, y: 198.0384, w: 275.6944, h: 42.6085 }, order: 7,
        text: 'R ESULTS FOR Z CASH ( LATENCIES IN SECONDS ).\nASIC\nAcceleration Rate\nMSM\nProof\nASIC/CPU\nPOLY', splitAllowed: true, widthMode: 'span',
        // Broken PDF source indexes can map the leading description to cells
        // well below the first physical line. Caption recovery must ignore
        // those implausible glyph coordinates and use the block-top fallback.
        characterRects: [...'R ESULTS FOR Z CASH ( LATENCIES IN SECONDS ).'].map((ch, index) => ({
          ch, sourceIndex: index, pageIndex: 0,
          rect: { x: 230.55 + index * 3.5, y: 246, w: 3.2, h: 7 },
        })),
      },
    );
    doc.semanticUnits.push(
      { id: 'pipe-table-v-caption', kind: 'caption', sourceText: 'TABLE V', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'pipe-table-v-description', kind: 'paragraph', sourceText: 'R ESULTS FOR DIFFERENT WORKLOADS ( LATENCIES IN SECONDS ).', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
      { id: 'pipe-table-vi-caption', kind: 'caption', sourceText: 'TABLE VI', protectedTokens: [], layoutRegionId: 'r1', order: 6 },
      { id: 'pipe-table-vi-body', kind: 'paragraph', sourceText: 'R ESULTS FOR Z CASH ( LATENCIES IN SECONDS ).\nASIC\nAcceleration Rate\nMSM\nProof\nASIC/CPU\nPOLY', protectedTokens: [], layoutRegionId: 'r1', order: 7 },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'pipe-table-v-caption', 'pipe-table-v-description', 'pipe-table-vi-caption', 'pipe-table-vi-body',
    );

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [
      {
        id: 'pipe-table-v-asset', kind: 'table', pageIndex: 0,
        rect: { x: 25.38, y: 89.6218, w: 561.25, h: 85.5242 }, widthMode: 'span',
        captionUnitId: 'pipe-table-v-caption',
      },
      {
        id: 'pipe-table-vi-asset', kind: 'table', pageIndex: 0,
        rect: { x: 25.38, y: 208.6099, w: 561.25, h: 59.97 }, widthMode: 'span',
        captionUnitId: 'pipe-table-vi-caption',
      },
    ] });

    expect(prepared.units.find((unit) => unit.id === 'pipe-table-v-caption')?.sourceText)
      .toBe('TABLE V\nRESULTS FOR DIFFERENT WORKLOADS ( LATENCIES IN SECONDS ).');
    expect(prepared.units.find((unit) => unit.id === 'pipe-table-vi-caption')?.sourceText)
      .toBe('TABLE VI\nRESULTS FOR ZCASH ( LATENCIES IN SECONDS ).');
    expect(prepared.units.some((unit) => unit.id === 'pipe-table-v-description')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'pipe-table-vi-body')).toBe(false);
  });

  it('drops a short table-cell remainder joined to a caption continuation', () => {
    const doc = fixtureDoc();
    const description = 'Execution time across several devices.';
    const remainderLines = ['Baseline SystemA Baseline SystemA', '409'];
    const raw = [description, ...remainderLines].join('\n');
    let sourceIndex = 0;
    const characterRects = [description, ...remainderLines].flatMap((line, lineIndex) => {
      const characters = [...line].map((ch, index) => ({
        ch,
        sourceIndex: sourceIndex + index,
        pageIndex: 0,
        rect: { x: 110 + index * 4, y: 112 + lineIndex * 14, w: 3.8, h: 8 },
      }));
      sourceIndex += line.length + 1;
      return characters;
    });
    doc.blocks.push(
      {
        id: 'generic-table-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 260, y: 100, w: 90, h: 10 }, order: 4,
        text: 'TABLE 4', splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'generic-table-description-and-cells', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 104, y: 112, w: 388, h: 44 }, order: 5,
        text: raw, splitAllowed: true, widthMode: 'span', characterRects,
      },
    );
    doc.semanticUnits.push(
      { id: 'generic-table-caption', kind: 'caption', sourceText: 'TABLE 4', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'generic-table-description-and-cells', kind: 'paragraph', sourceText: raw, protectedTokens: [], layoutRegionId: 'r1', order: 5 },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'generic-table-caption', 'generic-table-description-and-cells',
    );

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'generic-table-asset', kind: 'table', pageIndex: 0,
      rect: { x: 60, y: 125, w: 476, h: 80 }, widthMode: 'span',
      captionUnitId: 'generic-table-caption',
    }] });

    expect(prepared.units.find((unit) => unit.id === 'generic-table-caption')?.sourceText)
      .toBe('TABLE 4\nExecution time across several devices.');
    expect(prepared.units.some((unit) => unit.id === 'generic-table-description-and-cells')).toBe(false);
  });

  it('reconstructs split two-lane table footnotes and places them directly after the table', () => {
    const doc = fixtureDoc();
    const left = [
      '(1) MUL in Bellperson is executed in CPU, wh',
      '(2) DT represents the execution time for CP',
      '(3) Proof represents the execution time for the',
      'including MUL, NTT, MSM, CPU-GPU data tr',
      '(4) The speedup refers to the proof generat',
      'generation time in cuZK.',
    ].join('\n');
    const right = [
      'ile that in cuZK is executed in GPU.',
      'U-GPU data transfer.',
      'proof generation, which consists of operations',
      'ansfer, and other less critical operations.',
      'ion time in Bellperson divided by the proof',
    ].join('\n');
    doc.blocks.push(
      {
        id: 'table-six-caption', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 104, y: 104, w: 387, h: 10 }, order: 4,
        text: 'Table 6: Execution time.', splitAllowed: false, widthMode: 'span',
      },
      {
        id: 'table-six-footnote-left', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 116, y: 340, w: 183, h: 92 }, order: 6,
        text: left, splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'table-six-footnote-right', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 296, y: 341, w: 187, h: 81 }, order: 8,
        text: right, splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'after-table-section', docId: 'en', type: 'section', pageIndex: 0,
        rect: { x: 104, y: 450, w: 100, h: 14 }, order: 7,
        text: '6 Conclusion', splitAllowed: false, widthMode: 'span',
      },
    );
    doc.semanticUnits.push(
      { id: 'table-six-caption', kind: 'caption', sourceText: 'Table 6: Execution time.', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'table-six-footnote-left', kind: 'paragraph', sourceText: left, protectedTokens: [], layoutRegionId: 'r1', order: 6 },
      { id: 'after-table-section', kind: 'heading', sourceText: '6 Conclusion', protectedTokens: [], layoutRegionId: 'r1', order: 7 },
      { id: 'table-six-footnote-right', kind: 'paragraph', sourceText: right, protectedTokens: [], layoutRegionId: 'r1', order: 8 },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'table-six-caption', 'table-six-footnote-left', 'after-table-section', 'table-six-footnote-right',
    );

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'table-six-asset', kind: 'table', pageIndex: 0,
      rect: { x: 61, y: 127, w: 472, h: 203 }, widthMode: 'span',
      captionUnitId: 'table-six-caption',
    }] });
    const footnote = prepared.units.find((unit) => unit.id === 'table-six-footnote-left');
    expect(footnote?.sourceText).toContain('CPU, while that in cuZK is executed in GPU.');
    expect(footnote?.sourceText).toContain('CPU-GPU data transfer.');
    expect(footnote?.sourceText).toContain('proof generation time in Bellperson');
    expect(footnote?.sourceText).toContain('CPU-GPU data transfer, and other less critical operations.');
    expect(prepared.units.some((unit) => unit.id === 'table-six-footnote-right')).toBe(false);
    const order = prepared.regions.find((region) => region.orderedUnitIds.includes('table-six-asset'))!.orderedUnitIds;
    expect(order.indexOf('table-six-footnote-left')).toBe(order.indexOf('table-six-asset') + 1);
    expect(order.indexOf('table-six-footnote-left')).toBeLessThan(order.indexOf('after-table-section'));
  });

  it('reconstructs a complete caption-anchored algorithm and rejects a misplaced Vision code crop', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((block) => block.id !== 'fig-caption');
    doc.semanticUnits = doc.semanticUnits.filter((unit) => unit.id !== 'fig-caption');
    doc.layoutRegions[0].orderedUnitIds = doc.layoutRegions[0].orderedUnitIds
      .filter((unitId) => unitId !== 'fig-caption');
    doc.blocks.push(
      { id: 'algorithm-caption', docId: 'en', type: 'caption', pageIndex: 0, rect: { x: 50, y: 200, w: 300, h: 12 }, order: 4, text: 'Algorithm 1 Pippenger Algorithm', splitAllowed: false, widthMode: 'span' },
      { id: 'algorithm-body-1', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 60, y: 218, w: 290, h: 36 }, order: 5, text: '1: for i ← 1 to n do\n2: // Initialize buckets', splitAllowed: false, widthMode: 'span' },
      { id: 'algorithm-body-2', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 60, y: 258, w: 250, h: 36 }, order: 6, text: '3: if value ≠ 0 then\n4: return Q', splitAllowed: false, widthMode: 'span' },
      { id: 'after-algorithm', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 50, y: 315, w: 480, h: 40 }, order: 7, text: 'The result is the vector that we need after completing the algorithm.\nAfter obtaining G = ∑ B, this ordinary paragraph must remain available for translation.\n2: for i ← 1 to n do', splitAllowed: true, widthMode: 'span' },
    );
    doc.semanticUnits.push(
      { id: 'algorithm-caption', kind: 'caption', sourceText: 'Algorithm 1 Pippenger Algorithm', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'algorithm-body-1', kind: 'paragraph', sourceText: '1: for i ← 1 to n do\n2: // Initialize buckets', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
      { id: 'algorithm-body-2', kind: 'paragraph', sourceText: '3: if value ≠ 0 then\n4: return Q', protectedTokens: [], layoutRegionId: 'r1', order: 6 },
      { id: 'after-algorithm', kind: 'paragraph', sourceText: 'The result is the vector that we need after completing the algorithm.\nAfter obtaining G = ∑ B, this ordinary paragraph must remain available for translation.\n2: for i ← 1 to n do', protectedTokens: [], layoutRegionId: 'r1', order: 7 },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'algorithm-caption', 'algorithm-body-1', 'algorithm-body-2', 'after-algorithm',
    );

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [{
      id: 'vision-misplaced-code', kind: 'code', pageIndex: 0,
      rect: { x: 50, y: 360, w: 480, h: 90 }, widthMode: 'span',
    }] });

    expect(prepared.assetRegions).toContainEqual(expect.objectContaining({
      id: 'algorithm-caption-body-asset', kind: 'code', captionUnitId: 'algorithm-caption', widthMode: 'span',
    }));
    expect(prepared.assetRegions.some((asset) => asset.id === 'vision-misplaced-code')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'algorithm-body-1')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'algorithm-body-2')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'after-algorithm')).toBe(true);
    expect(prepared.regions[0].orderedUnitIds).toEqual(expect.arrayContaining([
      'algorithm-caption', 'algorithm-caption-body-asset', 'after-algorithm',
    ]));
  });

  it('keeps a column algorithm crop inside the caption column', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((block) => block.id !== 'fig-caption');
    doc.semanticUnits = doc.semanticUnits.filter((unit) => unit.id !== 'fig-caption');
    doc.layoutRegions[0].orderedUnitIds = doc.layoutRegions[0].orderedUnitIds
      .filter((unitId) => unitId !== 'fig-caption');
    doc.blocks.push(
      { id: 'right-algorithm-caption', docId: 'en', type: 'caption', pageIndex: 0, rect: { x: 330, y: 200, w: 200, h: 12 }, order: 4, text: 'Algorithm 1 Reduction', splitAllowed: false, widthMode: 'column' },
      { id: 'right-algorithm-line-1', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 332, y: 218, w: 198, h: 24 }, order: 5, text: '1: for i ← 1 to n do', splitAllowed: false, widthMode: 'column' },
      { id: 'right-algorithm-line-2', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 332, y: 246, w: 198, h: 24 }, order: 6, text: '2: return Q', splitAllowed: false, widthMode: 'column' },
      { id: 'left-unrelated-list', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 50, y: 220, w: 230, h: 48 }, order: 5.5, text: '1: unrelated left-column list\n2: preserve this content', splitAllowed: true, widthMode: 'column' },
    );
    doc.semanticUnits.push(
      { id: 'right-algorithm-caption', kind: 'caption', sourceText: 'Algorithm 1 Reduction', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'right-algorithm-line-1', kind: 'paragraph', sourceText: '1: for i ← 1 to n do', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
      { id: 'right-algorithm-line-2', kind: 'paragraph', sourceText: '2: return Q', protectedTokens: [], layoutRegionId: 'r1', order: 6 },
      { id: 'left-unrelated-list', kind: 'paragraph', sourceText: '1: unrelated left-column list\n2: preserve this content', protectedTokens: [], layoutRegionId: 'r1', order: 5.5 },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'right-algorithm-caption', 'right-algorithm-line-1',
      'left-unrelated-list', 'right-algorithm-line-2',
    );

    const prepared = prepareImmutableStructure(doc);
    const algorithm = prepared.assetRegions.find((asset) => asset.id === 'right-algorithm-caption-body-asset')!;

    expect(algorithm.widthMode).toBe('column');
    expect(algorithm.rect.x).toBeGreaterThanOrEqual(328);
    expect(algorithm.rect.x + algorithm.rect.w).toBeLessThanOrEqual(532);
    expect(prepared.units.some((unit) => unit.id === 'left-unrelated-list')).toBe(true);
  });

  it('keeps wide pseudocode rows attached to a caption misclassified as a column item', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((block) => block.id !== 'fig-caption');
    doc.semanticUnits = doc.semanticUnits.filter((unit) => unit.id !== 'fig-caption');
    doc.layoutRegions[0].orderedUnitIds = doc.layoutRegions[0].orderedUnitIds
      .filter((unitId) => unitId !== 'fig-caption');
    doc.blocks.push(
      { id: 'mixed-algorithm-caption', docId: 'en', type: 'caption', pageIndex: 0, rect: { x: 50, y: 200, w: 205, h: 12 }, order: 4, text: 'Algorithm 2 Bucket Reduction', splitAllowed: false, widthMode: 'column' },
      { id: 'mixed-algorithm-header', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 52, y: 218, w: 200, h: 32 }, order: 5, text: 'Require: point vector B\nEnsure: result G', splitAllowed: false, widthMode: 'column' },
      { id: 'mixed-algorithm-wide-row', docId: 'en', type: 'equation', pageIndex: 0, rect: { x: 55, y: 270, w: 300, h: 12 }, order: 6, text: '3: M ← M + B // accumulate every bucket point', splitAllowed: false, widthMode: 'span' },
      { id: 'mixed-algorithm-tail', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 55, y: 286, w: 180, h: 30 }, order: 7, text: '4: G ← G + M\n5: return G', splitAllowed: false, widthMode: 'column' },
      { id: 'mixed-after-heading', docId: 'en', type: 'section', pageIndex: 0, rect: { x: 50, y: 340, w: 220, h: 16 }, order: 8, text: '3 Next Section', splitAllowed: false, widthMode: 'column' },
    );
    doc.semanticUnits.push(
      { id: 'mixed-algorithm-caption', kind: 'caption', sourceText: 'Algorithm 2 Bucket Reduction', protectedTokens: [], layoutRegionId: 'r1', order: 4 },
      { id: 'mixed-algorithm-header', kind: 'paragraph', sourceText: 'Require: point vector B\nEnsure: result G', protectedTokens: [], layoutRegionId: 'r1', order: 5 },
      { id: 'mixed-algorithm-wide-row', kind: 'formula', sourceText: '3: M ← M + B // accumulate every bucket point', protectedTokens: [], assetId: 'mixed-algorithm-wide-row', layoutRegionId: 'r1', order: 6 },
      { id: 'mixed-algorithm-tail', kind: 'paragraph', sourceText: '4: G ← G + M\n5: return G', protectedTokens: [], layoutRegionId: 'r1', order: 7 },
      { id: 'mixed-after-heading', kind: 'heading', sourceText: '3 Next Section', protectedTokens: [], layoutRegionId: 'r1', order: 8 },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'mixed-algorithm-caption', 'mixed-algorithm-header', 'mixed-algorithm-wide-row',
      'mixed-algorithm-tail', 'mixed-after-heading',
    );

    const prepared = prepareImmutableStructure(doc);
    const algorithm = prepared.assetRegions.find((asset) => asset.id === 'mixed-algorithm-caption-body-asset')!;

    expect(algorithm).toBeDefined();
    expect(algorithm.rect.y + algorithm.rect.h).toBeGreaterThanOrEqual(324);
    expect(algorithm.widthMode).toBe('span');
    expect(prepared.units.some((unit) => unit.id === 'mixed-algorithm-tail')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'mixed-after-heading')).toBe(true);
  });

  it('stops a deterministic algorithm crop before a detached figure formula cluster', () => {
    const doc = fixtureDoc();
    doc.blocks.push(
      { id: 'algorithm-caption-2', docId: 'en', type: 'caption', pageIndex: 0, rect: { x: 50, y: 100, w: 300, h: 12 }, order: 10, text: 'Algorithm 2 Reduction', splitAllowed: false, widthMode: 'span' },
      { id: 'algorithm-line-1', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 55, y: 118, w: 300, h: 22 }, order: 11, text: '1: for i ← 1 to n do', splitAllowed: false, widthMode: 'span' },
      { id: 'algorithm-line-2', docId: 'en', type: 'paragraph', pageIndex: 0, rect: { x: 55, y: 144, w: 300, h: 22 }, order: 12, text: '2: return Q', splitAllowed: false, widthMode: 'span' },
      { id: 'detached-figure-formula', docId: 'en', type: 'equation', pageIndex: 0, rect: { x: 120, y: 240, w: 240, h: 40 }, order: 13, text: '∑ P_i → B_i', splitAllowed: false, widthMode: 'span' },
      { id: 'detached-figure-caption', docId: 'en', type: 'caption', pageIndex: 0, rect: { x: 100, y: 290, w: 300, h: 12 }, order: 14, text: 'Figure 9: Detached figure.', splitAllowed: false, widthMode: 'span' },
    );
    doc.semanticUnits.push(
      { id: 'algorithm-caption-2', kind: 'caption', sourceText: 'Algorithm 2 Reduction', protectedTokens: [], layoutRegionId: 'r1', order: 10 },
      { id: 'algorithm-line-1', kind: 'paragraph', sourceText: '1: for i ← 1 to n do', protectedTokens: [], layoutRegionId: 'r1', order: 11 },
      { id: 'algorithm-line-2', kind: 'paragraph', sourceText: '2: return Q', protectedTokens: [], layoutRegionId: 'r1', order: 12 },
      { id: 'detached-figure-formula', kind: 'formula', sourceText: '∑ P_i → B_i', protectedTokens: [], layoutRegionId: 'r1', order: 13 },
      { id: 'detached-figure-caption', kind: 'caption', sourceText: 'Figure 9: Detached figure.', protectedTokens: [], layoutRegionId: 'r1', order: 14 },
    );
    doc.layoutRegions[0].orderedUnitIds.push(
      'algorithm-caption-2', 'algorithm-line-1', 'algorithm-line-2',
      'detached-figure-formula', 'detached-figure-caption',
    );

    const prepared = prepareImmutableStructure(doc);
    const algorithm = prepared.assetRegions.find((asset) => asset.id === 'algorithm-caption-2-body-asset');
    expect(algorithm).toBeDefined();
    expect(algorithm!.rect.y + algorithm!.rect.h).toBeLessThan(200);
  });

  it('splits a PDF text block that contains both a figure caption and a table title', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'mixed-caption', docId: 'en', type: 'caption', pageIndex: 0,
      rect: { x: 50, y: 300, w: 230, h: 34 }, order: 4,
      text: 'Figure 9: Parallelism Analysis\nTable 2: PPA Results',
      splitAllowed: false, widthMode: 'column',
    }, {
      id: 'mixed-caption-table-body', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 50, y: 338, w: 230, h: 15 }, order: 4.5,
      text: 'Size Baseline Accelerator\n2^16 10.0 2.0\n2^17 20.0 4.0',
      splitAllowed: true, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'mixed-caption', kind: 'caption',
      sourceText: 'Figure 9: Parallelism Analysis\nTable 2: PPA Results',
      protectedTokens: [], layoutRegionId: 'r1', order: 4,
    });
    doc.layoutRegions[0].orderedUnitIds.push('mixed-caption');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [
      {
        id: 'figure-9', kind: 'figure', pageIndex: 0,
        rect: { x: 50, y: 180, w: 230, h: 110 }, widthMode: 'column',
        captionUnitId: 'mixed-caption',
      },
      {
        id: 'table-2', kind: 'table', pageIndex: 0,
        rect: { x: 50, y: 345, w: 230, h: 90 }, widthMode: 'column',
        captionUnitId: 'mixed-caption',
      },
    ] });

    expect(prepared.units.some((unit) => unit.id === 'mixed-caption')).toBe(false);
    expect(prepared.units).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mixed-caption-figure', sourceBlockId: 'mixed-caption', sourceText: 'Figure 9: Parallelism Analysis' }),
      expect.objectContaining({ id: 'mixed-caption-table', sourceBlockId: 'mixed-caption', sourceText: 'Table 2: PPA Results' }),
    ]));
    expect(prepared.assetRegions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'figure-9', captionUnitId: 'mixed-caption-figure' }),
      expect.objectContaining({ id: 'table-2', captionUnitId: 'mixed-caption-table' }),
    ]));
  });

  it('splits two figure captions merged into one PDF text block and binds them left-to-right', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'paired-figures', docId: 'en', type: 'caption', pageIndex: 0,
      rect: { x: 50, y: 300, w: 480, h: 18 }, order: 4,
      text: 'Figure 9: Parallelism Analysis Figure 10: MTU and PTU Speedup',
      splitAllowed: false, widthMode: 'span',
    });
    doc.semanticUnits.push({
      id: 'paired-figures', kind: 'caption',
      sourceText: 'Figure 9: Parallelism Analysis Figure 10: MTU and PTU Speedup',
      protectedTokens: [], layoutRegionId: 'r1', order: 4,
    });
    doc.layoutRegions[0].orderedUnitIds.push('paired-figures');

    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: [
      {
        id: 'figure-9', kind: 'figure', pageIndex: 0,
        rect: { x: 50, y: 180, w: 220, h: 110 }, widthMode: 'column',
        captionUnitId: 'paired-figures',
      },
      {
        id: 'figure-10', kind: 'figure', pageIndex: 0,
        rect: { x: 310, y: 180, w: 220, h: 110 }, widthMode: 'column',
        captionUnitId: 'paired-figures',
      },
    ] });

    expect(prepared.units.some((unit) => unit.id === 'paired-figures')).toBe(false);
    expect(prepared.units).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'paired-figures-figure-1', sourceBlockId: 'paired-figures', sourceText: 'Figure 9: Parallelism Analysis' }),
      expect.objectContaining({ id: 'paired-figures-figure-2', sourceBlockId: 'paired-figures', sourceText: 'Figure 10: MTU and PTU Speedup' }),
    ]));
    expect(prepared.assetRegions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'figure-9', captionUnitId: 'paired-figures-figure-1' }),
      expect.objectContaining({ id: 'figure-10', captionUnitId: 'paired-figures-figure-2' }),
    ]));
  });

  it('preserves every line of a first-page title that straddles the generic top margin', () => {
    const doc = fixtureDoc();
    const title = doc.blocks.find((block) => block.id === 'title')!;
    const source = 'Falic: An FPGA-Based Multi-Scalar Multiplication\nAccelerator for Zero-Knowledge Proof';
    title.text = source;
    title.rect = { x: 50, y: 55, w: 500, h: 45 };
    title.characterRects = [...source].map((ch, sourceIndex) => ({
      ch, sourceIndex, pageIndex: 0,
      rect: {
        x: 50 + (sourceIndex % 50) * 8,
        y: sourceIndex < source.indexOf('\n') ? 58 : 84,
        w: 7.5, h: 12,
      },
    }));
    doc.semanticUnits.find((unit) => unit.id === 'title')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'title')?.sourceText).toBe(source);
  });

  it('drops a multi-block IEEE first-page editorial and affiliation footnote', () => {
    const doc = fixtureDoc();
    const notes = [
      { id: 'received-note', type: 'paragraph' as const, y: 520, text: 'Manuscript received 25 January 2024; revised 4 August 2024. This work was supported by the NSFC.' },
      { id: 'corresponding-note', type: 'section' as const, y: 600, text: 'X. Fu. (Corresponding author: Zhibin Yu.)' },
      { id: 'affiliation-note', type: 'paragraph' as const, y: 620, text: 'Yongkui Yang is with Shenzhen Institute of Advanced Technology (e-mail: author@example.edu).' },
      { id: 'rights-note', type: 'paragraph' as const, y: 734, text: 'See https://www.ieee.org/publications/rights/index.html for more information.' },
    ];
    doc.blocks.push(...notes.map((note, index) => ({
      id: note.id, docId: 'en' as const, type: note.type, pageIndex: 0,
      rect: { x: 50, y: note.y, w: 240, h: 20 }, order: 4 + index,
      text: note.text, splitAllowed: true, widthMode: 'column' as const,
    })));
    doc.semanticUnits.push(...notes.map((note, index) => ({
      id: note.id,
      kind: note.type === 'section' ? 'heading' as const : 'paragraph' as const,
      sourceText: note.text, protectedTokens: [], layoutRegionId: 'r1', order: 4 + index,
    })));
    doc.layoutRegions[0].orderedUnitIds.push(...notes.map((note) => note.id));

    const prepared = prepareImmutableStructure(doc);

    for (const note of notes) {
      expect(prepared.units.some((unit) => unit.id === note.id)).toBe(false);
      expect(prepared.regions[0].orderedUnitIds).not.toContain(note.id);
    }
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

  it('preserves the original section number when cleaning a short heading near formulas', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'section-2-4', docId: 'en', type: 'section', pageIndex: 0,
      rect: { x: 330, y: 450, w: 200, h: 18 }, order: 4,
      text: '2.4 Sparse Matrix', splitAllowed: false, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'section-2-4', kind: 'heading', sourceText: '2.4 Sparse Matrix',
      protectedTokens: [], layoutRegionId: 'r1', order: 4,
    });
    doc.layoutRegions[0].orderedUnitIds.push('section-2-4');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'section-2-4')).toEqual(
      expect.objectContaining({ sourceText: 'Sparse Matrix', headingNumber: '2.4', headingLevel: 2 }),
    );
    expect(buildTranslationRequestsFromDoc({ ...doc, semanticUnits: prepared.units })
      .find((request) => request.blockId === 'section-2-4')).toMatchObject({ source: 'Sparse Matrix' });
  });

  it('repairs a single letter-spaced small-caps word in a heading only', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'references', docId: 'en', type: 'section', pageIndex: 0,
      rect: { x: 60, y: 420, w: 140, h: 16 }, order: 4,
      text: 'R EFERENCES', splitAllowed: false, widthMode: 'column',
    });
    doc.semanticUnits.push({
      id: 'references', kind: 'heading', sourceText: 'R EFERENCES',
      protectedTokens: [], layoutRegionId: 'r1', order: 4,
    });
    doc.layoutRegions[0].orderedUnitIds.push('references');

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'references')?.sourceText).toBe('REFERENCES');
    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('First result. Second result.');
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
