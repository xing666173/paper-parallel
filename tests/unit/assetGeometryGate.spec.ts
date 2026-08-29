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

  it('rejects one large prose block swallowed by a Vision figure box', () => {
    const swallowed = block(
      'p1',
      'According to the evaluation results, the proposed architecture improves performance while retaining compatibility with the existing system.',
      55, 145, 230, 70,
    );
    expect(validateImmutableRegion(
      { id: 'prose', kind: 'figure', pageIndex: 0, rect: { x: 50, y: 120, w: 240, h: 150 }, widthMode: 'column' },
      page,
      [swallowed],
    ).issues).toContain('body-prose-density');
  });

  it('does not mistake multiline chart labels for body prose', () => {
    const labels = block(
      'labels',
      'Main Trace Generation Permutation Trace Quotient Values Merkle Commit Openings & LDE\n1.0\n0.8\n0.6\nProportion\n0.2\n0.0\nJson RSA',
      55, 130, 230, 95,
    );
    expect(validateImmutableRegion(
      { id: 'chart', kind: 'figure', pageIndex: 0, rect: { x: 50, y: 120, w: 240, h: 150 }, widthMode: 'column' },
      page,
      [labels],
    ).pass).toBe(true);
  });

  it('uses character geometry when only a formula tail of a long prose block intersects', () => {
    const proseWithFormulaTail = block(
      'p1',
      `${Array.from({ length: 10 }, (_, index) => `A long technical paragraph line ${index} contains ordinary discussion words.`).join('\n')}\n𝑖 𝑗\n∑ 𝑖\n1`,
      318, 340, 242, 258,
    );
    proseWithFormulaTail.characterRects = [
      ...[...'A long technical paragraph'].map((ch, index) => ({
        ch, sourceIndex: index, pageIndex: 0,
        rect: { x: 320 + index * 4, y: 350, w: 3.8, h: 8 },
      })),
      { ch: '𝑖', sourceIndex: 80, pageIndex: 0, rect: { x: 390, y: 574, w: 5, h: 8 } },
      { ch: '𝑗', sourceIndex: 82, pageIndex: 0, rect: { x: 410, y: 574, w: 5, h: 8 } },
      { ch: '∑', sourceIndex: 84, pageIndex: 0, rect: { x: 374, y: 587, w: 8, h: 12 } },
      { ch: '1', sourceIndex: 88, pageIndex: 0, rect: { x: 376, y: 590, w: 4, h: 7 } },
    ];

    expect(validateImmutableRegion(
      { id: 'formula', kind: 'formula', pageIndex: 0, rect: { x: 326, y: 572, w: 234, h: 48 }, widthMode: 'column' },
      page,
      [proseWithFormulaTail],
    ).pass).toBe(true);
  });

  it('accepts a high-confidence pseudocode crop even when its comments resemble prose', () => {
    const algorithm = block(
      'algorithm',
      'Algorithm 1 The Pippenger Algorithm\nRequire: A scalar vector and a chosen window size.\n1: for j to 1 do // Convert the original task into subtasks.\n2: return Q',
      70, 100, 470, 360,
    );
    expect(validateImmutableRegion(
      { id: 'code', kind: 'code', pageIndex: 0, rect: { x: 65, y: 90, w: 480, h: 380 }, widthMode: 'span' },
      page,
      [algorithm],
    ).pass).toBe(true);
  });

  it('still rejects sentence-like prose when character geometry confirms it is inside the crop', () => {
    const swallowed = block(
      'p1',
      'The proposed architecture improves performance and retains compatibility with the existing system.',
      55, 145, 230, 20,
    );
    swallowed.characterRects = [...swallowed.text!].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 58 + index * 2.2, y: 148, w: 2, h: 8 },
    }));
    expect(validateImmutableRegion(
      { id: 'prose', kind: 'figure', pageIndex: 0, rect: { x: 50, y: 120, w: 240, h: 150 }, widthMode: 'column' },
      page,
      [swallowed],
    ).issues).toContain('body-prose-density');
  });

  it('does not treat benchmark names such as Is-Prime as natural-language prose', () => {
    const labels = block(
      'labels',
      'BLS12-381 BN254 Fibonacci Gorth16_Verify Is-Prime Tendermint BLS12-381 BN254 Fibonacci Is-Prime',
      55, 176, 430, 8,
    );
    labels.characterRects = [...labels.text!].map((ch, index) => ({
      ch, sourceIndex: index, pageIndex: 0,
      rect: { x: 56 + index * 3.5, y: 176, w: 3.3, h: 6 },
    }));
    expect(validateImmutableRegion(
      { id: 'chart', kind: 'figure', pageIndex: 0, rect: { x: 33, y: 82, w: 279, h: 107 }, widthMode: 'column' },
      page,
      [labels],
    ).pass).toBe(true);
  });
});
