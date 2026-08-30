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
        const row = [...line].map((ch, charIndex) => ({
          ch,
          sourceIndex: sourceIndex + charIndex,
          pageIndex: 0,
          rect: { x: x + charIndex * 5, y: ys[rowIndex]!, w: 4.5, h: 8 },
        }));
        sourceIndex += line.length + 1;
        return row;
      });
    };
    const bodyLines = [
      'A. Author. A paral-',
      'lel paper.',
      'B. Writer. Second title.',
      'continued venue.',
    ];
    doc.blocks.push(
      {
        id: 'reference-body', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 100, y: 630, w: 380, h: 60 }, order: 4,
        text: bodyLines.join('\n'), characterRects: characterRows(bodyLines, 100, [630, 642, 660, 672]),
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
      '[B2] B. Writer. Second title. continued venue.',
    ]);
    expect(prepared.units.some((unit) => unit.id === 'reference-body')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'reference-labels')).toBe(false);
    expect(prepared.regions.find((region) => region.id === 'reference-heading-region')?.orderedUnitIds)
      .toEqual(['references-heading', ...references.map((unit) => unit.id)]);
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
      orderedUnitIds: ['two-column-references', ...references.map((reference) => reference.id)],
    });
    doc.semanticUnits.push({
      id: 'two-column-references', parentId: 'two-column-references', kind: 'heading',
      sourceText: 'References', protectedTokens: [], layoutRegionId: 'two-column-reference-region', order: 4,
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
      .toEqual({ x: 330, y: 500, w: 200, h: 42 });
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
    block.fragments = [
      { pageIndex: 0, rect: block.rect },
      { pageIndex: 1, rect: { x: 50, y: 100, w: 230, h: 30 } },
    ];
    doc.semanticUnits.find((unit) => unit.id === 'p1')!.sourceText = source;

    const prepared = prepareImmutableStructure(doc);

    expect(prepared.units.find((unit) => unit.id === 'p1')?.sourceText)
      .toBe('Specifically, as shown in Figure 6,');
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
      expect.objectContaining({ sourceText: '2.4 Sparse Matrix' }),
    );
    expect(buildTranslationRequestsFromDoc({ ...doc, semanticUnits: prepared.units })
      .find((request) => request.blockId === 'section-2-4')?.protectedTokens).toEqual(['2.4']);
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
