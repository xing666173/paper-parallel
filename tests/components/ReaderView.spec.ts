// @vitest-environment jsdom
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ReaderView from '../../src/components/reader/ReaderView.vue';
import type { AlignmentManifest } from '../../src/core/align/manifest';

const PdfPaneStub = defineComponent({
  name: 'PdfPane',
  props: {
    side: { type: String, required: true },
    activeRects: { type: Array, required: true },
    unitGeometry: { type: Array, required: true },
  },
  template: '<div class="pane-stub" :data-side="side" :data-active-count="activeRects.length" :data-unit-count="unitGeometry.length" />',
});

describe('paired reader highlights', () => {
  it('ignores a cached target-only unit and starts from a complete pair', () => {
    const manifest: AlignmentManifest = {
      schemaVersion: 1,
      projectId: 'p1',
      createdAt: 1,
      units: [
        {
          id: 'right-only', kind: 'semantic-group', relation: '1:1',
          sourceUnitIds: ['s1'], targetUnitIds: ['t1'], source: [],
          target: [{ page: 0, rects: [{ x: 1, y: 2, w: 3, h: 4 }] }],
          confidence: 1, status: 'aligned',
        },
        {
          id: 'paired', kind: 'semantic-group', relation: '1:1',
          sourceUnitIds: ['s2'], targetUnitIds: ['t2'],
          source: [{ page: 0, rects: [{ x: 5, y: 6, w: 7, h: 8 }] }],
          target: [{ page: 0, rects: [{ x: 9, y: 10, w: 11, h: 12 }] }],
          confidence: 1, status: 'aligned',
        },
      ],
      stats: { total: 2, aligned: 2, lowConfidence: 0, unmatched: 0, coverage: 1 },
    };
    const wrapper = mount(ReaderView, {
      props: { englishPdf: new Blob(), chinesePdf: new Blob(), manifest },
      global: {
        stubs: { PdfPane: PdfPaneStub, ReaderToolbar: true },
      },
    });

    const panes = wrapper.findAll('.pane-stub');
    expect(panes).toHaveLength(2);
    expect(panes[0].attributes()).toMatchObject({
      'data-side': 'en', 'data-active-count': '1', 'data-unit-count': '1',
    });
    expect(panes[1].attributes()).toMatchObject({
      'data-side': 'zh', 'data-active-count': '1', 'data-unit-count': '1',
    });
  });
});
