import { describe, expect, it } from 'vitest';
import { itemsToCharRects, normalizeTextItem, parsePageItems, rectsForRange } from '../../src/core/parser';

describe('rotated PDF text geometry', () => {
  it('rotates the em box and source-character advance of a vertical chart label', () => {
    const item = normalizeTextItem({
      str: 'AB', width: 100, height: 10,
      transform: [0, 10, -10, 0, 100, 692],
    }, { transform: [1, 0, 0, -1, 0, 792] });

    // These are bounds of the adapter's em-box convention, not ink extents.
    expect(item).toMatchObject({ x: 90, y: 0, w: 10, h: 100 });
    const chars = itemsToCharRects([item], { pageIndex: 2, sourceOffset: 4 });
    expect(chars).toEqual([
      { ch: 'A', pageIndex: 2, sourceIndex: 4, x: 90, y: 50, w: 10, h: 50 },
      { ch: 'B', pageIndex: 2, sourceIndex: 5, x: 90, y: 0, w: 10, h: 50 },
    ]);
  });

  it('preserves the same baseline geometry when the rotation belongs to the PDF viewport', () => {
    const item = normalizeTextItem({
      str: 'AB', width: 100, height: 10,
      transform: [10, 0, 0, 10, 100, 700],
    }, { transform: [0, 1, 1, 0, 0, 0] });

    expect(item).toMatchObject({ x: 700, y: 100, w: 10, h: 100 });
    expect(itemsToCharRects([item])).toMatchObject([
      { ch: 'A', x: 700, y: 100, w: 10, h: 50, sourceIndex: 0 },
      { ch: 'B', x: 700, y: 150, w: 10, h: 50, sourceIndex: 1 },
    ]);
  });

  it('advances backwards in x for a 180-degree text run without reversing the source string', () => {
    const item = normalizeTextItem({
      str: 'AB', width: 100, height: 10,
      transform: [-10, 0, 0, -10, 200, 692],
    }, { transform: [1, 0, 0, -1, 0, 792] });

    expect(item).toMatchObject({ str: 'AB', x: 100, y: 100, w: 100, h: 10 });
    expect(itemsToCharRects([item])).toMatchObject([
      { ch: 'A', x: 150, y: 100, w: 50, h: 10 },
      { ch: 'B', x: 100, y: 100, w: 50, h: 10 },
    ]);
    expect(rectsForRange(itemsToCharRects([item]), [0, 2])).toEqual([{ x: 100, y: 100, w: 100, h: 10 }]);
  });

  it('does not join a vertical label to horizontal prose sharing its bounding-box top', () => {
    const label = normalizeTextItem({
      str: 'Axis', width: 100, height: 10,
      transform: [0, 10, -10, 0, 100, 592],
    }, { transform: [1, 0, 0, -1, 0, 792] });
    const parsed = parsePageItems([
      label,
      { str: 'Horizontal source prose stays outside the vertical label.', x: 105, y: 100, w: 180, h: 10 },
    ], 612, 792);

    expect(parsed.blocks.map((block) => block.text)).toEqual([
      'Axis', 'Horizontal source prose stays outside the vertical label.',
    ]);
    expect(parsed.blocks[0]?.characterRects?.map((character) => character.sourceIndex)).toEqual([0, 1, 2, 3]);
  });
});
