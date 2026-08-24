import { describe, expect, it } from 'vitest';
import { buildAssetManifest } from '../../src/core/assets/extract';
import { escapeTypstText } from '../../src/core/typst/escape';
import { buildTypstProject } from '../../src/core/typst/project';

describe('Typst project generation', () => {
  it('emits ordered inherited regions, stable markers and immutable asset files', async () => {
    const figBytes = new Uint8Array([1, 2, 3]);
    const { assets } = await buildAssetManifest([{
      id: 'fig-1', kind: 'figure', pageIndex: 0,
      rect: { x: 70, y: 300, w: 220, h: 120 }, bytes: figBytes,
      widthMode: 'span', captionUnitId: 'fig-1-caption',
    }]);
    const project = await buildTypstProject({
      metadata: { paperWidth: 612, paperHeight: 792, margin: 72, columnGap: 12 },
      regions: [
        { id: 'front', mode: 'full-width', sourcePage: 0, bounds: { x: 72, y: 60, w: 468, h: 100 }, orderedUnitIds: ['title'] },
        { id: 'body', mode: 'double', sourcePage: 0, bounds: { x: 72, y: 180, w: 468, h: 400 }, orderedUnitIds: ['p1', 'fig-1', 'fig-1-caption'] },
      ],
      units: [
        { id: 'title', kind: 'title', layoutRegionId: 'front', order: 0, text: '论文标题' },
        {
          id: 'p1', kind: 'paragraph', layoutRegionId: 'body', order: 1,
          targetSegments: [{ id: 'sec-1-p-1-g-1-t-1', text: '准确率为 96%。' }],
        },
        { id: 'fig-1', kind: 'figure', layoutRegionId: 'body', order: 2, assetId: 'fig-1' },
        {
          id: 'fig-1-caption', kind: 'caption', layoutRegionId: 'body', order: 3,
          targetSegments: [{ id: 'fig-1-caption-g-1-t-1', text: '图 1：系统结构。' }],
        },
      ],
      assets,
    });

    expect(project.mainContent).toContain('#pp-full-width[');
    expect(project.mainContent).toContain('论文标题');
    expect(project.mainContent).toContain('#pp-title[');
    expect(project.mainContent).toContain('#pp-double[');
    expect(project.mainContent).toContain('#pp-unit("sec-1-p-1-g-1-t-1")');
    expect(project.mainContent).toContain('#pp-asset("fig-1", "/assets/fig-1.png", span: true)');
    expect(project.mainContent).toContain('#pp-caption[');
    expect(project.mainContent).toContain('footer: context');
    expect(project.mainContent.indexOf('pp-full-width')).toBeLessThan(project.mainContent.indexOf('pp-double'));
    expect(project.files.get('/assets/fig-1.png')).toEqual(figBytes);
    expect(project.markerIds).toEqual([
      'title', 'sec-1-p-1-g-1-t-1', 'fig-1', 'fig-1-caption-g-1-t-1',
    ]);
  });

  it('escapes Typst syntax without changing ordinary protected text', () => {
    expect(escapeTypstText('Cost is $5 and [x] #tag.')).toBe('Cost is \\$5 and \\[x\\] \\#tag.');
  });

  it('rejects an asset whose bytes no longer match its recorded hash', async () => {
    const { assets } = await buildAssetManifest([{
      id: 'fig-1', kind: 'figure', pageIndex: 0,
      rect: { x: 0, y: 0, w: 10, h: 10 }, bytes: new Uint8Array([1]),
    }]);
    assets[0]!.blob = new Blob([new Uint8Array([2])], { type: 'image/png' });
    await expect(buildTypstProject({
      metadata: { paperWidth: 612, paperHeight: 792 },
      regions: [{ id: 'r1', mode: 'single', sourcePage: 0, bounds: { x: 0, y: 0, w: 10, h: 10 }, orderedUnitIds: ['fig-1'] }],
      units: [{ id: 'fig-1', kind: 'figure', layoutRegionId: 'r1', order: 0, assetId: 'fig-1' }],
      assets,
    })).rejects.toThrow('hash');
  });
});
