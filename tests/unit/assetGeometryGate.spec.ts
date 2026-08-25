import { describe, expect, it } from 'vitest';
import { validateImmutableRegion } from '../../src/core/assets/geometryGate';
import type { Block } from '../../src/types/models';

const page = { width: 612, height: 792 };
const block = (id: string, text: string, x: number, y: number, w: number, h: number): Block => ({
  id, docId: 'en', type: 'paragraph', pageIndex: 0,
  rect: { x, y, w, h }, order: 0, text, splitAllowed: true, widthMode: 'column',
});

describe('immutable asset geometry gate', () => {
  it('rejects crops that touch the page edge or cover an implausible page fraction', () => {
    expect(validateImmutableRegion(
      { id: 'edge', kind: 'figure', pageIndex: 0, rect: { x: 53, y: 0, w: 242, h: 240 }, widthMode: 'column' },
      page,
      [],
    ).pass).toBe(false);
    expect(validateImmutableRegion(
      { id: 'huge', kind: 'figure', pageIndex: 0, rect: { x: 20, y: 20, w: 572, h: 650 }, widthMode: 'span' },
      page,
      [],
    ).pass).toBe(false);
  });

  it('rejects a crop that includes its translated caption', () => {
    expect(validateImmutableRegion(
      { id: 'fig', kind: 'figure', pageIndex: 0, rect: { x: 50, y: 120, w: 240, h: 220 }, widthMode: 'column' },
      page,
      [],
      { x: 50, y: 320, w: 240, h: 18 },
    ).issues).toContain('caption-overlap');
  });

  it('rejects a figure crop dominated by long body prose but accepts short internal labels', () => {
    const prose = [
      block('p1', 'This ordinary paragraph contains a full sentence that belongs outside the figure.', 55, 130, 230, 28),
      block('p2', 'Another long paragraph continues the technical discussion in the source column.', 55, 165, 230, 28),
      block('p3', 'The third paragraph proves that the proposed crop swallowed source body text.', 55, 200, 230, 28),
    ];
    expect(validateImmutableRegion(
      { id: 'prose', kind: 'figure', pageIndex: 0, rect: { x: 50, y: 120, w: 240, h: 150 }, widthMode: 'column' },
      page,
      prose,
    ).issues).toContain('body-prose-density');

    expect(validateImmutableRegion(
      { id: 'labels', kind: 'figure', pageIndex: 0, rect: { x: 50, y: 120, w: 240, h: 150 }, widthMode: 'column' },
      page,
      [block('l1', 'Program', 60, 140, 50, 10), block('l2', 'Proof', 180, 210, 40, 10)],
    ).pass).toBe(true);
  });
});
