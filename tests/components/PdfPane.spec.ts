// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import PdfPane from '../../src/components/reader/PdfPane.vue';

const pdfRuntime = vi.hoisted(() => ({
  getDocument: vi.fn(),
}));

vi.mock('../../src/core/pdf/runtime', () => ({
  getDocument: pdfRuntime.getDocument,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

describe('real PDF pane contract', () => {
  it('renders independent page labels and an unobtrusive active overlay', () => {
    const wrapper = mount(PdfPane, {
      props: {
        side: 'en',
        title: '英文原文',
        pageCount: 8,
        pageMetrics: [{ width: 612, height: 792 }],
        visiblePages: [0],
        activeRects: [{ page: 0, rects: [{ x: 72, y: 210, w: 220, h: 42 }] }],
        zoom: 1,
      },
    });

    expect(wrapper.text()).toContain('英文原文');
    expect(wrapper.text()).toContain('第 1 / 8 页');
    expect(wrapper.get('[data-page="0"]')).toBeDefined();
    expect(wrapper.get('[data-alignment-overlay]').attributes('style')).toContain('pointer-events: none');
    expect(wrapper.attributes('data-pdf-side')).toBe('en');
  });

  it('keeps unrendered page spacers so independent scroll geometry remains stable', () => {
    const wrapper = mount(PdfPane, {
      props: {
        side: 'zh', title: '中文译文', pageCount: 7,
        pageMetrics: Array.from({ length: 7 }, (_, index) => ({
          width: 612, height: index === 3 ? 900 : 792,
        })),
        visiblePages: [3], activeRects: [], zoom: 1,
      },
    });
    expect(wrapper.findAll('[data-page]')).toHaveLength(7);
    expect(wrapper.get('[data-page="0"]').classes()).toContain('is-spacer');
    expect(wrapper.get('[data-page="3"]').find('canvas').exists()).toBe(true);
  });

  it('renders only the latest request when canvas mounting and PDF loading request the same page', async () => {
    const renderPromises: Array<ReturnType<typeof deferred<void>>> = [];
    const render = vi.fn(() => {
      const pending = deferred<void>();
      renderPromises.push(pending);
      return { promise: pending.promise, cancel: vi.fn() };
    });
    const createPage = () => ({
      getViewport: () => ({ width: 612, height: 792 }),
      render,
    });
    const pendingPages = [deferred<ReturnType<typeof createPage>>(), deferred<ReturnType<typeof createPage>>()];
    let getPageCalls = 0;
    const document = {
      numPages: 1,
      getPage: vi.fn(() => {
        getPageCalls += 1;
        if (getPageCalls === 1) return Promise.resolve(createPage());
        return pendingPages[Math.min(getPageCalls - 2, pendingPages.length - 1)].promise;
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    pdfRuntime.getDocument.mockReturnValue({
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);

    const wrapper = mount(PdfPane, {
      props: {
        side: 'en', title: '英文原文',
        pdfBlob: { arrayBuffer: async () => new ArrayBuffer(1) } as Blob,
        activeRects: [], zoom: 1,
      },
    });

    await vi.waitFor(() => expect(document.getPage.mock.calls.length).toBeGreaterThanOrEqual(3));
    pendingPages.forEach((pending) => pending.resolve(createPage()));
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    expect(render).toHaveBeenCalledTimes(1);
    renderPromises.forEach((pending) => pending.resolve());
    await wrapper.unmount();
  });
});
