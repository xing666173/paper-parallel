// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PdfPane from '../../src/components/reader/PdfPane.vue';

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
});
