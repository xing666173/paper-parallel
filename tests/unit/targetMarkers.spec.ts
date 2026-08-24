import { describe, expect, it } from 'vitest';
import { readTargetMarkers } from '../../src/core/align/targetMarkers';

describe('Typst target markers', () => {
  it('extracts and groups only Paper Parallel annotations by decoded stable unit ID', async () => {
    const pdf = fakePdf([[
      { url: 'https://paper-parallel.invalid/unit/sec-1-p-1-s-1', rect: [10, 20, 80, 32] },
      { url: 'https://paper-parallel.invalid/unit/sec-1-p-1-s-1', rect: [10, 34, 70, 46] },
      { url: 'https://paper-parallel.invalid/unit/fig%2F1', rect: [90, 20, 120, 40] },
      { url: 'https://example.com', rect: [0, 0, 1, 1] },
    ]]);

    const markers = await readTargetMarkers(pdf);
    expect(markers.get('sec-1-p-1-s-1')).toEqual([{ page: 0, rects: [
      { x: 10, y: 20, w: 70, h: 12 },
      { x: 10, y: 34, w: 60, h: 12 },
    ] }]);
    expect(markers.has('fig/1')).toBe(true);
    expect(markers.has('https://example.com')).toBe(false);
  });

  it('converts bottom-left PDF annotation coordinates through the page viewport', async () => {
    const pdf = fakePdf([[{
      url: 'https://paper-parallel.invalid/unit/u1',
      rect: [10, 700, 40, 720],
    }]], ([x1, y1, x2, y2]) => [x1, 792 - y1, x2, 792 - y2]);

    expect((await readTargetMarkers(pdf)).get('u1')).toEqual([{
      page: 0,
      rects: [{ x: 10, y: 72, w: 30, h: 20 }],
    }]);
  });
});

function fakePdf(
  pages: Array<Array<{ url?: string; rect: number[] }>>,
  transform: (rect: number[]) => number[] = (rect) => rect,
) {
  return {
    numPages: pages.length,
    async getPage(pageNumber: number) {
      return {
        getViewport: () => ({ convertToViewportRectangle: transform }),
        getAnnotations: async () => pages[pageNumber - 1],
      };
    },
  };
}
