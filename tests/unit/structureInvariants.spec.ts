import { describe, expect, it } from 'vitest';
import { validatePreparedStructure } from '../../src/core/pipeline/structureInvariants';
import type { LayoutRegion, SemanticUnit } from '../../src/types/models';
import type { DetectedAssetRegion } from '../../src/core/assets/extract';

function validFixture(): {
  regions: LayoutRegion[];
  units: SemanticUnit[];
  assets: DetectedAssetRegion[];
} {
  return {
    regions: [{
      id: 'region-1', mode: 'single', sourcePage: 0,
      bounds: { x: 0, y: 0, w: 600, h: 800 }, orderedUnitIds: ['caption-1', 'asset-unit-1'],
    }],
    units: [
      {
        id: 'caption-1', kind: 'caption', sourceText: 'Figure 1', protectedTokens: [],
        layoutRegionId: 'region-1', order: 0,
      },
      {
        id: 'asset-unit-1', kind: 'figure', assetId: 'asset-1', protectedTokens: [],
        layoutRegionId: 'region-1', order: 1,
      },
    ],
    assets: [{
      id: 'asset-1', kind: 'figure', pageIndex: 0,
      rect: { x: 10, y: 20, w: 100, h: 80 }, widthMode: 'column', captionUnitId: 'caption-1',
    }],
  };
}

describe('prepared structure invariants', () => {
  it('accepts one-owner asset and caption structure without mutating it', () => {
    const fixture = validFixture();
    const before = JSON.stringify(fixture);
    expect(validatePreparedStructure({ stage: 'pre-translation', ...fixture })).toEqual([]);
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it('reports duplicate ownership, unknown references and missing assets with stable sources', () => {
    const fixture = validFixture();
    fixture.regions.push({
      id: 'region-2', mode: 'single', sourcePage: 0,
      bounds: { x: 0, y: 0, w: 600, h: 800 }, orderedUnitIds: ['asset-unit-1', 'missing'],
    });
    fixture.units[1]!.assetId = 'missing-asset';
    const issues = validatePreparedStructure({ stage: 'pre-translation', ...fixture });
    expect(issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'local-structural.multiple-region-owners',
      'local-structural.unknown-unit-reference',
      'local-structural.missing-asset-record',
      'local-structural.missing-asset-unit',
    ]));
    expect(issues.every((item) => item.fingerprint)).toBe(true);
  });
});
