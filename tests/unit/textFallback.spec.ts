import { describe, expect, it } from 'vitest';
import { matchTranslatedText } from '../../src/core/align/textFallback';

const r1 = { x: 10, y: 20, w: 100, h: 12 };
const r2 = { x: 10, y: 34, w: 100, h: 12 };

describe('target text geometry fallback', () => {
  it('matches text despite PDF item line breaks', async () => {
    const result = await matchTranslatedText(fakeTextPdf([[
      { str: '高性能异构加速', rect: r1, hasEOL: true },
      { str: '器能够降低延迟。', rect: r2 },
    ]]), [{ id: 's1', targetText: '高性能异构加速器能够降低延迟。' }]);

    expect(result.get('s1')?.status).toBe('aligned');
    expect(result.get('s1')?.rects[0].rects).toHaveLength(2);
  });

  it('removes only explicit line-end word hyphenation', async () => {
    const result = await matchTranslatedText(fakeTextPdf([[
      { str: 'hetero-', rect: r1, hasEOL: true },
      { str: 'geneous accelerator', rect: r2 },
    ]]), [{ id: 's1', targetText: 'heterogeneous accelerator' }]);
    expect(result.get('s1')?.status).toBe('aligned');
  });

  it('does not ignore changed numbers during fallback matching', async () => {
    const result = await matchTranslatedText(fakeTextPdf([[
      { str: '准确率为 69%。', rect: r1 },
    ]]), [{ id: 's1', targetText: '准确率为 96%。' }]);
    expect(result.get('s1')?.status).toBe('unmatched');
  });

  it('matches repeated segments only in forward semantic order', async () => {
    const result = await matchTranslatedText(fakeTextPdf([[
      { str: '结果。', rect: r1 },
      { str: '结果。', rect: r2 },
    ]]), [
      { id: 's1', targetText: '结果。' },
      { id: 's2', targetText: '结果。' },
    ]);
    expect(result.get('s1')?.rects[0].rects).toEqual([r1]);
    expect(result.get('s2')?.rects[0].rects).toEqual([r2]);
  });
});

function fakeTextPdf(pages: Array<Array<{ str: string; rect: typeof r1; hasEOL?: boolean }>>) {
  return {
    numPages: pages.length,
    async getPage(pageNumber: number) {
      return {
        getViewport: () => ({ transform: [1, 0, 0, 1, 0, 0] }),
        getTextContent: async () => ({ items: pages[pageNumber - 1] }),
      };
    },
  };
}
