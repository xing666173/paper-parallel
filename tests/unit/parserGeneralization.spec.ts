import { describe, expect, it } from 'vitest';
import { parsePageItems, type SimpleTextItem } from '../../src/core/parser';
import { buildDoc } from '../../src/core/parser/docBuilder';

const pageWidth = 612;
const pageHeight = 792;

function parsedDoc(items: SimpleTextItem[]) {
  const parsed = parsePageItems(items, pageWidth, pageHeight);
  const doc = buildDoc([{
    no: 1, w: pageWidth, h: pageHeight,
    layoutMode: parsed.layoutMode, blocks: parsed.blocks,
  }], 'en');
  return { parsed, doc };
}

function singleColumnParagraph() {
  const left = [
    'The proposed method improves the model and',
    'The evaluation uses the same data and the',
    'The final experiment confirms the result in',
  ];
  const right = [
    'the model is then used in the next stage.',
    'same configuration for all of the systems.',
    'the previous section of the present paper.',
  ];
  return {
    expected: left.map((text, row) => `${text} ${right[row]}`).join('\n'),
    items: left.flatMap((str, row): SimpleTextItem[] => row === 0 ? [
      { str, x: 50, y: 250, w: 250, h: 10 },
      { str: right[row]!, x: 309, y: 250, w: 250, h: 10 },
    ] : [{ str: `${str} ${right[row]}`, x: 50, y: 250 + row * 15, w: 509, h: 10 }]),
  };
}

describe('parser generalization regressions', () => {
  it('keeps a real single-column paragraph intact despite one ordinary 9pt central word gap', () => {
    const { items, expected } = singleColumnParagraph();
    const { parsed, doc } = parsedDoc(items);

    expect(parsed.layoutMode).toBe('single');
    expect(doc.blocks.map((block) => block.text)).toEqual([expected]);
    expect(doc.semanticUnits.map((unit) => unit.sourceText)).toEqual([expected]);
    expect(doc.layoutRegions.map((region) => region.mode)).toEqual(['single']);
    for (const character of doc.blocks[0]!.characterRects!) {
      expect(expected[character.sourceIndex]).toBe(character.ch);
    }
  });

  it('does not reinterpret ordinary word spacing as a gutter even on a mixed page', () => {
    const { items, expected } = singleColumnParagraph();
    const parsed = parsePageItems(items, pageWidth, pageHeight);
    const doc = buildDoc([{
      no: 1, w: pageWidth, h: pageHeight, layoutMode: 'mixed', blocks: parsed.blocks,
    }], 'en');

    expect(doc.blocks.map((block) => block.text)).toEqual([expected]);
  });

  it('retains genuine twelve-point-gutter columns from text items through document construction', () => {
    const left = ['The left column starts with the first explanation.', 'The explanation continues in the left column.'];
    const right = ['The right column starts with the second explanation.', 'The explanation continues in the right column.'];
    const { parsed, doc } = parsedDoc(left.flatMap((str, row) => [
      { str, x: 50, y: 230 + row * 13, w: 250, h: 9 },
      { str: right[row]!, x: 312, y: 230 + row * 13, w: 250, h: 9 },
    ]));

    expect(parsed.layoutMode).toBe('double');
    expect(doc.blocks.map((block) => block.text)).toEqual([left.join('\n'), right.join('\n')]);
    expect(doc.layoutRegions.map((region) => region.mode)).toEqual(['double']);
  });

  it('reads each two-column band before the full-width text below it and keeps the later band separate', () => {
    const item = (str: string, x: number, y: number, w = 240): SimpleTextItem => ({ str, x, y, w, h: 10 });
    const { parsed, doc } = parsedDoc([
      item('The upper left paragraph describes the first method.', 50, 230),
      item('Its remaining explanation belongs to the upper left.', 50, 245),
      item('The upper right paragraph describes the second method.', 320, 230),
      item('Its remaining explanation belongs to the upper right.', 320, 245),
      item('The full-width comparison follows both methods above and introduces the next discussion.', 50, 265, 510),
      item('The lower left paragraph begins a separate discussion.', 50, 280),
      item('The lower right paragraph completes that discussion.', 320, 280),
    ]);
    const expected = [
      'The upper left paragraph describes the first method.\nIts remaining explanation belongs to the upper left.',
      'The upper right paragraph describes the second method.\nIts remaining explanation belongs to the upper right.',
      'The full-width comparison follows both methods above and introduces the next discussion.',
      'The lower left paragraph begins a separate discussion.',
      'The lower right paragraph completes that discussion.',
    ];

    expect(parsed.layoutMode).toBe('mixed');
    expect(parsed.blocks.map((block) => block.text)).toEqual(expected);
    expect(doc.blocks.map((block) => block.text)).toEqual(expected);
    expect(doc.semanticUnits.map((unit) => unit.sourceText)).toEqual(expected);
    expect(doc.layoutRegions.map((region) => region.mode)).toEqual(['double', 'full-width', 'double']);
    expect(doc.layoutRegions.flatMap((region) => region.orderedUnitIds)).toEqual(doc.blocks.map((block) => block.id));
  });

  it('keeps numeric body text at the page bottom while still removing an actual page number', () => {
    const text = '100 participants completed the protocol and all measurements were retained.';
    const { parsed, doc } = parsedDoc([
      { str: text, x: 50, y: 726, w: 240, h: 12 },
      { str: '12', x: 307, y: 765, w: 10, h: 10 },
    ]);

    expect(parsed.blocks.find((block) => block.text === text)?.type).toBe('paragraph');
    expect(doc.blocks.map((block) => block.text)).toEqual([text]);
    expect(doc.semanticUnits.map((unit) => unit.sourceText)).toEqual([text]);
  });

  it('keeps a numbered section at the bottom and removes publisher download furniture', () => {
    const doc = buildDoc([{
      no: 1, w: pageWidth, h: pageHeight, layoutMode: 'single', blocks: [
        { id: 'section', type: 'section', col: 'left', rect: { x: 50, y: 726, w: 180, h: 12 }, text: '2 Experimental Setup' },
        { id: 'footer', type: 'paragraph', col: 'full', rect: { x: 50, y: 768, w: 510, h: 10 }, text: 'Authorized licensed use limited to: Example University.' },
      ],
    }], 'en');

    expect(doc.blocks.map((block) => block.text)).toEqual(['2 Experimental Setup']);
    expect(doc.semanticUnits[0]?.kind).toBe('heading');
  });
});
