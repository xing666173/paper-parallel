import { describe, expect, it } from 'vitest';
import { buildAssetManifest } from '../../src/core/assets/extract';
import { composeChinesePdf, type CompositionProgress } from '../../src/core/compose/compose';
import type { ProjectArtifactRecord } from '../../src/core/project/db';

describe('Chinese PDF composition', () => {
  it('preserves source region order and persists compiled artifacts', async () => {
    const { assets } = await buildAssetManifest([{
      id: 'fig-1', kind: 'figure', pageIndex: 0,
      rect: { x: 72, y: 300, w: 468, h: 180 }, bytes: new Uint8Array([1, 2, 3]),
      widthMode: 'span', captionUnitId: 'fig-1-caption',
    }]);
    const persisted: ProjectArtifactRecord[] = [];
    const progress: CompositionProgress[] = [];
    const result = await composeChinesePdf({
      projectId: 'project-1',
      metadata: { paperWidth: 612, paperHeight: 792 },
      regions: [
        { id: 'front', mode: 'full-width', sourcePage: 0, bounds: { x: 72, y: 60, w: 468, h: 80 }, orderedUnitIds: ['title'] },
        { id: 'body', mode: 'double', sourcePage: 0, bounds: { x: 72, y: 180, w: 468, h: 500 }, orderedUnitIds: ['p1', 'fig-1', 'fig-1-caption'] },
      ],
      units: [
        { id: 'title', kind: 'title', layoutRegionId: 'front', order: 0, text: '论文标题' },
        { id: 'p1', kind: 'paragraph', layoutRegionId: 'body', order: 1, targetSegments: [{ id: 'sec-1-p-1-g-1-t-1', text: '中文正文。' }] },
        { id: 'fig-1', kind: 'figure', layoutRegionId: 'body', order: 2, assetId: 'fig-1' },
        { id: 'fig-1-caption', kind: 'caption', layoutRegionId: 'body', order: 3, targetSegments: [{ id: 'fig-1-caption-g-1-t-1', text: '图 1：结构。' }] },
      ],
      assets,
    }, {
      compile: async (project) => {
        expect(project.markerIds).toEqual([
          'title', 'sec-1-p-1-g-1-t-1', 'fig-1', 'fig-1-caption-g-1-t-1',
        ]);
        return { pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), svg: '<svg></svg>' };
      },
      saveArtifact: async (record) => { persisted.push(record); },
      onProgress: (event) => progress.push(event),
    });

    expect(result.pdfKey).toBe('project-1:chinese-pdf');
    expect(persisted.map((record) => record.kind)).toEqual([
      'chinese-pdf', 'typst-source', 'typst-preview',
    ]);
    expect(persisted[0]?.blob.type).toBe('application/pdf');
    expect(progress.map((event) => event.phase)).toEqual([
      'composing', 'compiling-pdf', 'persisting-pdf',
    ]);
  });
});
