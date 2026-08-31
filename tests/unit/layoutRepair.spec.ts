import { describe, expect, it } from 'vitest';
import { buildLayoutRepairPlan } from '../../src/core/quality/layoutRepair';
import type { VisionFinalIssue } from '../../src/core/vision/finalReview';

const pageSizes = new Map([[0, { width: 600, height: 800 }]]);
const headingUnit = {
  id: 'heading', kind: 'heading' as const, layoutRegionId: 'r1', order: 1,
  headingLevel: 1 as const,
};
const manifest = {
  units: [{
    id: 'group', sourceBlockId: 'heading', parentId: 'heading', sourceUnitIds: ['heading-s1'],
    target: [{ page: 0, rects: [{ x: 60, y: 160, w: 300, h: 30 }] }],
  }],
} as any;

function issue(overrides: Partial<VisionFinalIssue> = {}): VisionFinalIssue {
  return {
    targetPageIndex: 0, type: 'layout_drift', severity: 'severe',
    bbox: [100, 200, 500, 60], confidence: 0.95,
    evidence: 'Heading crowds the following body paragraph',
    ...overrides,
  };
}

describe('deterministic layout repair planning', () => {
  it('adds bounded heading spacing and never repeats an identical issue', () => {
    const first = buildLayoutRepairPlan({
      attempt: 1, issues: [issue()], manifest, units: [headingUnit], pageSizes,
    });
    expect(first?.extraHeadingBelowPt).toEqual({ heading: 2 });
    expect(first?.actions[0]).toMatchObject({ type: 'heading-spacing', unitId: 'heading' });
    const repeated = buildLayoutRepairPlan({
      attempt: 2, issues: [issue()], manifest, units: [headingUnit], pageSizes, previous: first,
    });
    expect(repeated).toBeUndefined();
  });

  it('does not invent a layout repair for content-integrity failures', () => {
    expect(buildLayoutRepairPlan({
      attempt: 1,
      issues: [issue({ type: 'formula_changed', evidence: 'Formula symbols changed' })],
      manifest, units: [headingUnit], pageSizes,
    })).toBeUndefined();
  });

  it('fails closed for structural text scattering instead of hiding it with spacing', () => {
    expect(buildLayoutRepairPlan({
      attempt: 1,
      issues: [issue({ evidence: 'Author metadata is mixed with body text and leaves scattered lines.' })],
      manifest, units: [headingUnit], pageSizes,
    })).toBeUndefined();
  });
});
