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

    expect(project.mainContent).not.toContain('#pp-full-width[');
    expect(project.mainContent).toContain('论文标题');
    expect(project.mainContent).toContain('#pp-title[');
    expect(project.mainContent).toContain('#pp-double[');
    expect(project.mainContent).toContain('#pp-unit("sec-1-p-1-g-1-t-1")');
    expect(project.mainContent).toContain('#pp-asset("fig-1", "/assets/fig-1.png", 220pt, span: true)');
    expect(project.mainContent).toContain('#pp-caption[');
    expect(project.mainContent).toContain('#pagebreak(weak: true)\n#pp-asset-group[');
    expect(project.mainContent).toContain('footer: context');
    expect(project.mainContent).toContain('"DejaVu Math TeX Gyre"');
    expect(project.mainContent.indexOf('论文标题')).toBeLessThan(project.mainContent.indexOf('#pp-double['));
    expect(project.files.get('/assets/fig-1.png')).toEqual(figBytes);
    expect(project.markerIds).toEqual([
      'title', 'sec-1-p-1-g-1-t-1', 'fig-1', 'fig-1-caption-g-1-t-1',
    ]);
  });

  it('preserves the source physical width instead of stretching every asset to its container', async () => {
    const { assets } = await buildAssetManifest([{
      id: 'fig-small', kind: 'figure', pageIndex: 0,
      rect: { x: 100, y: 200, w: 126.5, h: 90 }, bytes: new Uint8Array([1]),
      widthMode: 'column',
    }]);
    const project = await buildTypstProject({
      metadata: { paperWidth: 612, paperHeight: 792 },
      regions: [{ id: 'r1', mode: 'double', sourcePage: 0, bounds: { x: 50, y: 80, w: 512, h: 600 }, orderedUnitIds: ['fig-small'] }],
      units: [{ id: 'fig-small', kind: 'figure', layoutRegionId: 'r1', order: 0, assetId: 'fig-small' }],
      assets,
    });

    expect(project.mainContent).toContain('#pp-asset("fig-small", "/assets/fig-small.png", 126.5pt, span: false)');
    expect(project.mainContent).not.toContain('#image(path, width: 100%)');
  });

  it('moves an uncaptioned full-width algorithm or figure as one unit to a fresh page', async () => {
    const { assets } = await buildAssetManifest([{
      id: 'algorithm-1', kind: 'code', pageIndex: 0,
      rect: { x: 70, y: 300, w: 468, h: 260 }, bytes: new Uint8Array([1]),
      widthMode: 'span',
    }]);
    const project = await buildTypstProject({
      metadata: { paperWidth: 612, paperHeight: 792 },
      regions: [{
        id: 'r1', mode: 'full-width', sourcePage: 0,
        bounds: { x: 70, y: 100, w: 468, h: 500 }, orderedUnitIds: ['algorithm-1'],
      }],
      units: [{ id: 'algorithm-1', kind: 'code', layoutRegionId: 'r1', order: 0, assetId: 'algorithm-1' }],
      assets,
    });

    expect(project.mainContent).toContain('#pagebreak(weak: true)\n#pp-asset("algorithm-1"');
  });

  it('preserves explicit left-to-right source column flow in a double-column region', async () => {
    const project = await buildTypstProject({
      metadata: { paperWidth: 612, paperHeight: 792 },
      regions: [{
        id: 'r1', mode: 'double', sourcePage: 0,
        bounds: { x: 50, y: 80, w: 512, h: 600 }, orderedUnitIds: ['left', 'right'],
      }],
      units: [
        { id: 'left', kind: 'paragraph', layoutRegionId: 'r1', order: 0, text: '左栏', sourceColumn: 'left' },
        { id: 'right', kind: 'paragraph', layoutRegionId: 'r1', order: 1, text: '右栏', sourceColumn: 'right' },
      ],
      assets: [],
    });

    expect(project.mainContent).toContain('#colbreak()');
    expect(project.mainContent.indexOf('左栏')).toBeLessThan(project.mainContent.indexOf('#colbreak()'));
    expect(project.mainContent.indexOf('#colbreak()')).toBeLessThan(project.mainContent.indexOf('右栏'));
  });

  it('keeps later source pages in one natural pagination flow', async () => {
    const project = await buildTypstProject({
      metadata: { paperWidth: 612, paperHeight: 792 },
      regions: [
        { id: 'p1', mode: 'double', sourcePage: 0, bounds: { x: 50, y: 80, w: 512, h: 600 }, orderedUnitIds: ['a'] },
        { id: 'p2', mode: 'double', sourcePage: 1, bounds: { x: 50, y: 80, w: 512, h: 600 }, orderedUnitIds: ['b'] },
      ],
      units: [
        { id: 'a', kind: 'paragraph', layoutRegionId: 'p1', order: 0, text: '第一页' },
        { id: 'b', kind: 'paragraph', layoutRegionId: 'p2', order: 1, text: '第二页' },
      ],
      assets: [],
    });

    expect(project.mainContent).not.toContain('#pagebreak(weak: true)');
    expect(project.mainContent.indexOf('第一页')).toBeLessThan(project.mainContent.indexOf('第二页'));
  });

  it('keeps an immutable figure and translated caption in one unbreakable group', async () => {
    const { assets } = await buildAssetManifest([{
      id: 'fig', kind: 'figure', pageIndex: 0,
      rect: { x: 50, y: 100, w: 220, h: 160 }, bytes: new Uint8Array([1]),
      widthMode: 'column', captionUnitId: 'cap',
    }]);
    const project = await buildTypstProject({
      metadata: { paperWidth: 612, paperHeight: 792 },
      regions: [{
        id: 'r1', mode: 'double', sourcePage: 0,
        bounds: { x: 50, y: 80, w: 512, h: 600 }, orderedUnitIds: ['fig', 'cap'],
      }],
      units: [
        { id: 'fig', kind: 'figure', layoutRegionId: 'r1', order: 0, assetId: 'fig', sourceColumn: 'left' },
        { id: 'cap', kind: 'caption', layoutRegionId: 'r1', order: 1, text: '图 1：结构。', sourceColumn: 'left' },
      ],
      assets,
    });

    expect(project.mainContent).toContain('#pp-asset-group[');
    expect(project.mainContent).toContain('#let pp-asset-group(body) = block(breakable: false');
    expect(project.mainContent).toContain('#let pp-full-width(body) = body');
    expect(project.mainContent).toContain('#let pp-single(body) = body');
    expect(project.mainContent).not.toContain('#let pp-full-width(body) = block');
    expect(project.mainContent.indexOf('#pp-asset(')).toBeLessThan(project.mainContent.indexOf('#pp-caption['));
  });

  it('moves a column-width figure group after prose to the next column', async () => {
    const { assets } = await buildAssetManifest([{
      id: 'fig', kind: 'figure', pageIndex: 0,
      rect: { x: 50, y: 300, w: 220, h: 180 }, bytes: new Uint8Array([1]),
      widthMode: 'column', captionUnitId: 'cap',
    }]);
    const project = await buildTypstProject({
      metadata: { paperWidth: 612, paperHeight: 792 },
      regions: [{
        id: 'r1', mode: 'double', sourcePage: 0,
        bounds: { x: 50, y: 80, w: 512, h: 600 }, orderedUnitIds: ['p1', 'fig', 'cap'],
      }],
      units: [
        { id: 'p1', kind: 'paragraph', layoutRegionId: 'r1', order: 0, text: '前置正文', sourceColumn: 'left' },
        { id: 'fig', kind: 'figure', layoutRegionId: 'r1', order: 1, assetId: 'fig', sourceColumn: 'left' },
        { id: 'cap', kind: 'caption', layoutRegionId: 'r1', order: 2, text: '图 1', sourceColumn: 'left' },
      ],
      assets,
    });

    expect(project.mainContent.indexOf('前置正文')).toBeLessThan(project.mainContent.indexOf('#colbreak()'));
    expect(project.mainContent.indexOf('#colbreak()')).toBeLessThan(project.mainContent.indexOf('#pp-asset-group['));
  });

  it('starts a two-column segment with an immutable asset on a fresh page', async () => {
    const { assets } = await buildAssetManifest([{
      id: 'fig', kind: 'figure', pageIndex: 1,
      rect: { x: 50, y: 80, w: 220, h: 260 }, bytes: new Uint8Array([1]),
      widthMode: 'column', captionUnitId: 'cap',
    }]);
    const project = await buildTypstProject({
      metadata: { paperWidth: 612, paperHeight: 792 },
      regions: [{
        id: 'r1', mode: 'double', sourcePage: 1,
        bounds: { x: 50, y: 80, w: 512, h: 600 }, orderedUnitIds: ['fig', 'cap', 'p1'],
      }],
      units: [
        { id: 'fig', kind: 'figure', layoutRegionId: 'r1', order: 0, assetId: 'fig', sourceColumn: 'left' },
        { id: 'cap', kind: 'caption', layoutRegionId: 'r1', order: 1, text: '图 1', sourceColumn: 'left' },
        { id: 'p1', kind: 'paragraph', layoutRegionId: 'r1', order: 2, text: '后续正文', sourceColumn: 'left' },
      ],
      assets,
    });

    expect(project.mainContent).toContain('#pagebreak(weak: true)\n#pp-double[');
    expect(project.mainContent.indexOf('#pagebreak(weak: true)')).toBeLessThan(project.mainContent.indexOf('#pp-asset-group['));
  });

  it('renders a horizontal source asset band as one multi-column grid', async () => {
    const { assets } = await buildAssetManifest([
      { id: 'a', kind: 'figure', pageIndex: 0, rect: { x: 50, y: 100, w: 160, h: 90 }, bytes: new Uint8Array([1]), captionUnitId: 'ca' },
      { id: 'b', kind: 'figure', pageIndex: 0, rect: { x: 225, y: 100, w: 160, h: 90 }, bytes: new Uint8Array([2]), captionUnitId: 'cb' },
      { id: 'c', kind: 'figure', pageIndex: 0, rect: { x: 400, y: 100, w: 160, h: 90 }, bytes: new Uint8Array([3]), captionUnitId: 'cc' },
    ]);
    const project = await buildTypstProject({
      metadata: { paperWidth: 612, paperHeight: 792 },
      regions: [{
        id: 'row', mode: 'full-width', presentation: 'horizontal', sourcePage: 0,
        bounds: { x: 50, y: 100, w: 510, h: 110 },
        orderedUnitIds: ['a', 'ca', 'b', 'cb', 'c', 'cc'],
      }],
      units: ['a', 'b', 'c'].flatMap((id, index) => [
        { id, kind: 'figure' as const, layoutRegionId: 'row', order: index * 2, assetId: id },
        { id: `c${id}`, kind: 'caption' as const, layoutRegionId: 'row', order: index * 2 + 1, text: `图 ${index + 1}` },
      ]),
      assets,
    });

    expect(project.mainContent).toContain('#grid(columns: 3, gutter: 6pt');
    expect(project.mainContent).toContain('155.2pt');
    expect(project.mainContent).not.toContain('[#pagebreak(weak: true)');
    expect(project.mainContent.match(/#pagebreak\(weak: true\)/g)).toHaveLength(1);
  });

  it('escapes Typst syntax without changing ordinary protected text', () => {
    expect(escapeTypstText('Cost is $5 and [x] #tag.')).toBe('Cost is \\$5 and \\[x\\] \\#tag.');
  });

  it('escapes email, label, citation, emphasis, and raw-markup delimiters', () => {
    expect(escapeTypstText('xi.wang@<seu.edu.cn> uses *ASIC* and `code_ref`.')).toBe(
      'xi.wang\\@\\<seu.edu.cn\\> uses \\*ASIC\\* and \\`code\\_ref\\`.',
    );
  });

  it('escapes algorithm line-comment markers so they cannot swallow the closing content delimiter', () => {
    expect(escapeTypstText('1: T ← O // O is the point at infinity.')).toBe(
      '1: T ← O \\/\\/ O is the point at infinity.',
    );
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
