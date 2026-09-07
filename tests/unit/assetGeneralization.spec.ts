import { describe, expect, it } from 'vitest';
import type { Block, Doc, Rect } from '../../src/types/models';
import type { DetectedAssetRegion } from '../../src/core/assets/extract';
import { buildAssetManifest } from '../../src/core/assets/extract';
import { validateImmutableRegion } from '../../src/core/assets/geometryGate';
import { prepareImmutableStructure } from '../../src/core/pipeline/preparation';
import { validatePreparedStructure } from '../../src/core/pipeline/structureInvariants';
import { buildTypstProject } from '../../src/core/typst/project';

const page = { pageIndex: 0, width: 612, height: 792, columns: [] };
function document(blocks: Array<Pick<Block, 'id' | 'text' | 'rect' | 'type'>>): Doc {
  return {
    id: 'en', role: 'en', pageCount: 1, pages: [page], layoutMode: 'double',
    meta: { paperWidth: 612, paperHeight: 792 },
    blocks: blocks.map((block, order) => ({ ...block, order, pageIndex: 0,
      docId: 'en', splitAllowed: block.type === 'paragraph', widthMode: block.rect.w > 320 ? 'span' : 'column' })),
    semanticUnits: blocks.map((block, order) => ({ id: block.id, order,
      kind: block.type === 'caption' ? 'caption' : 'paragraph', sourceText: block.text,
      protectedTokens: [], layoutRegionId: 'body' })),
    layoutRegions: [{ id: 'body', mode: 'double', sourcePage: 0,
      bounds: { x: 50, y: 50, w: 510, h: 700 }, orderedUnitIds: blocks.map((block) => block.id) }],
  };
}

describe('asset layout generalization', () => {
  it.each([false, true])('keeps shared-caption panels together through preparation and composition (vertical=%s)', async (vertical) => {
    const doc = document([{ id: 'intro', type: 'paragraph', text: 'The following figure compares both methods.',
      rect: { x: 50, y: 75, w: 240, h: 20 } }, { id: 'caption', type: 'caption',
      text: 'Figure 1: Comparison of (a) baseline and (b) proposed method.',
      rect: { x: 50, y: vertical ? 440 : 340, w: 510, h: 12 } }]);
    const regions: DetectedAssetRegion[] = [
      { id: 'panel-a', kind: 'figure', pageIndex: 0, widthMode: 'column', captionUnitId: 'caption',
        rect: { x: 50, y: 150, w: 240, h: vertical ? 120 : 170 } },
      { id: 'panel-b', kind: 'figure', pageIndex: 0, widthMode: 'column', captionUnitId: 'caption',
        rect: { x: vertical ? 50 : 320, y: vertical ? 300 : 150, w: 240, h: vertical ? 120 : 170 } },
    ];
    const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: regions });
    expect(prepared.assetRegions).toHaveLength(2);
    expect(validatePreparedStructure({ stage: 'pre-translation', ...prepared, assets: prepared.assetRegions })).toEqual([]);
    expect(prepared.regions.flatMap((region) => region.orderedUnitIds).filter((id) => id === 'caption')).toHaveLength(1);
    expect(prepared.regions.flatMap((region) => region.orderedUnitIds)[0]).toBe('intro');
    const { assets } = await buildAssetManifest(prepared.assetRegions.map((asset) => ({
      ...asset, bytes: new Uint8Array([1, 2, 3]),
    })));
    const project = await buildTypstProject({ metadata: doc.meta, regions: prepared.regions, assets,
      units: prepared.units.map((unit) => ({ ...unit, text: unit.sourceText })),
    });
    expect(project.mainContent.match(/#pp-caption\[/g)).toHaveLength(1);
    expect(project.mainContent.match(/#pp-asset\(/g)).toHaveLength(2);
    expect(project.mainContent.includes('#grid(columns: 2')).toBe(!vertical);
  });

  it.each(['overlap', 'different-page', 'different-region'] as const)('rejects false shared caption groups: %s', (fault) => {
    const doc = document([{ id: 'caption', type: 'caption', text: 'Figure 1: Panels.',
      rect: { x: 50, y: 340, w: 510, h: 12 } }]);
    const assets: DetectedAssetRegion[] = ['a', 'b'].map((id, index) => ({
      id, kind: 'figure', pageIndex: fault === 'different-page' ? index : 0,
      widthMode: 'column', captionUnitId: 'caption',
      rect: { x: fault === 'overlap' ? 50 : 50 + 270 * index, y: 150, w: 240, h: 170 },
    }));
    const units = [...doc.semanticUnits, ...assets.map((asset, index) => ({
      id: asset.id, assetId: asset.id, kind: 'figure' as const, order: index + 1, protectedTokens: [],
      layoutRegionId: fault === 'different-region' && index === 1 ? 'elsewhere' : 'body',
    }))];
    const issues = validatePreparedStructure({ stage: 'pre-typst', regions: doc.layoutRegions, units, assets });
    expect(issues.some((issue) => issue.code === 'local-structural.multiple-caption-owners')).toBe(true);
  });

  it('accepts a large table supported by a nearby separate caption through the preparation gate', () => {
    const captionRect = { x: 56, y: 85, w: 500, h: 12 };
    const asset: DetectedAssetRegion = { id: 'table', kind: 'table', pageIndex: 0,
      rect: { x: 56, y: 110, w: 500, h: 550 }, widthMode: 'span', captionUnitId: 'caption' };
    const doc = document([{ id: 'caption', type: 'caption', text: 'Table 1: Evaluation results.', rect: captionRect }]);
    expect(validateImmutableRegion(asset, page, [], captionRect).pass).toBe(true);
    expect(prepareImmutableStructure(doc, { verifiedAssetRegions: [asset] }).assetRegions).toHaveLength(1);
    expect(validateImmutableRegion({ ...asset, captionUnitId: undefined }, page, []).pass).toBe(false);
    const foreignCaption = { ...doc.blocks[0]!, id: 'another-caption', rect: { x: 56, y: 300, w: 240, h: 12 } };
    expect(validateImmutableRegion(asset, page, [foreignCaption], captionRect).issues).toContain('foreign-caption-overlap');
    expect(validateImmutableRegion({ ...asset, rect: { ...asset.rect, x: NaN } }, page, []).pass).toBe(false);
  });

  it('uses the last numeric row as the boundary of a table at the end of a column', () => {
    const doc = document([
      { id: 'intro', type: 'paragraph', text: 'The evaluation compares the methods in the following table.', rect: { x: 50, y: 350, w: 240, h: 20 } },
      { id: 'caption', type: 'caption', text: 'Table 1: Results', rect: { x: 50, y: 400, w: 240, h: 10 } },
      { id: 'data', type: 'paragraph', text: 'Alpha 1.0 2.0\nBeta 3.0 4.0\nGamma 5.0 6.0', rect: { x: 50, y: 423, w: 240, h: 45 } },
    ]);
    const prepared = prepareImmutableStructure(doc);
    const table = prepared.assetRegions.find((asset) => asset.kind === 'table')!;
    expect(table).toBeDefined();
    expect(table.rect.y + table.rect.h).toBeGreaterThanOrEqual(468);
    expect(table.rect.y + table.rect.h).toBeLessThanOrEqual(474);
    expect(prepared.units.some((unit) => unit.id === 'data')).toBe(false);
    expect(prepared.units.some((unit) => unit.id === 'intro')).toBe(true);
  });

  it('does not turn unbounded prose after a table title into an immutable table', () => {
    const doc = document([
      { id: 'caption', type: 'caption', text: 'Table 1: Results', rect: { x: 50, y: 400, w: 240, h: 10 } },
      { id: 'prose', type: 'paragraph', text: 'The proposed method improves performance and retains compatibility with the existing system. The observations require additional analysis.',
        rect: { x: 50, y: 423, w: 240, h: 45 } as Rect },
    ]);
    expect(() => prepareImmutableStructure(doc)).toThrow(/边界/);
  });
});
