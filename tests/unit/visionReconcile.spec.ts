import { describe, expect, it } from 'vitest';
import { reconcileVisionLayout } from '../../src/core/vision/reconcile';
import type { Doc } from '../../src/types/models';

describe('vision: deterministic layout reconciliation', () => {
  it('maps a confident figure box to source coordinates and its existing caption', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 190, 360, 260], column: 'left',
        captionBBox: [80, 470, 360, 35], confidence: 0.98,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toEqual([expect.objectContaining({
      id: 'vision-p1-figure-1', kind: 'figure', pageIndex: 0,
      rect: { x: 48.96, y: 150.48, w: 220.32, h: 205.92 },
      widthMode: 'column', captionUnitId: 'caption-1',
    })]);
  });

  it('matches a nearby approximate caption box and trims a figure crop that includes the real caption', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 190, 360, 320], column: 'left',
        captionBBox: [80, 440, 360, 20], confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toHaveLength(1);
    const asset = result.assetRegions[0]!;
    expect(asset.captionUnitId).toBe('caption-1');
    expect(asset.rect.y + asset.rect.h).toBeLessThanOrEqual(372);
  });

  it('links the nearest real caption when Vision omits caption_bbox', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 190, 360, 230], column: 'left', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.captionUnitId).toBe('caption-1');
  });

  it('fails closed for low confidence and page-edge assets', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [
        { type: 'figure', bbox: [80, 190, 360, 260], column: 'left', confidence: 0.4 },
        { type: 'figure', bbox: [0, 0, 400, 300], column: 'left', confidence: 0.99 },
      ],
    }]);

    expect(result.assetRegions).toEqual([]);
    expect(result.unresolved.map((item) => item.reason)).toEqual([
      'low-confidence', 'page-edge-touch',
    ]);
  });

  it('ignores body text annotations and rejects missing or duplicate page analyses', () => {
    expect(reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'body_text', bbox: [80, 100, 360, 100], column: 'left', confidence: 0.99,
      }],
    }])).toEqual({ assetRegions: [], unresolved: [] });

    expect(() => reconcileVisionLayout(fixtureDoc(), [])).toThrow('缺少第 1 页');
    expect(() => reconcileVisionLayout(fixtureDoc(), [
      { pageIndex: 0, layout: 'double', regions: [] },
      { pageIndex: 0, layout: 'double', regions: [] },
    ])).toThrow('重复');
  });
});

function fixtureDoc(): Doc {
  return {
    id: 'en', role: 'en', pageCount: 1,
    pages: [{ pageIndex: 0, width: 612, height: 792, columns: [] }],
    blocks: [
      {
        id: 'body-1', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 80, w: 220, h: 50 }, order: 0,
        text: 'A normal body paragraph that should remain translated text.',
        splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'caption-1', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 49, y: 372, w: 220, h: 28 }, order: 1,
        text: 'Figure 1: Workflow', splitAllowed: false, widthMode: 'column',
      },
    ],
    layoutRegions: [{
      id: 'region-1', mode: 'double', sourcePage: 0,
      bounds: { x: 49, y: 70, w: 514, h: 660 }, orderedUnitIds: ['body-1', 'caption-1'],
    }],
    semanticUnits: [
      { id: 'body-1', kind: 'paragraph', sourceText: 'A normal body paragraph that should remain translated text.', protectedTokens: [], layoutRegionId: 'region-1', order: 0 },
      { id: 'caption-1', kind: 'caption', sourceText: 'Figure 1: Workflow', protectedTokens: [], layoutRegionId: 'region-1', order: 1 },
    ],
    layoutMode: 'double', meta: { paperWidth: 612, paperHeight: 792 },
  };
}
