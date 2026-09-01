import { describe, expect, it } from 'vitest';
import {
  createVisionPagePlan,
  parseCachedVisionPagePlan,
  planToVisionAnalysis,
} from '../../src/core/vision/pagePlan';
import { verifyVisionPagePlan } from '../../src/core/vision/planVerifier';
import type { VisionPageAnalysis } from '../../src/core/vision/protocol';

function analysis(regions: VisionPageAnalysis['regions']): VisionPageAnalysis {
  return { pageIndex: 0, layout: 'double', regions };
}

describe('vision page plan canonicalization', () => {
  it('assigns stable local IDs and digest independent of provider region order', () => {
    const regions: VisionPageAnalysis['regions'] = [
      { type: 'figure', bbox: [100, 200, 300, 180], column: 'left', confidence: 0.9 },
      { type: 'table', bbox: [520, 400, 380, 220], column: 'right', confidence: 0.95 },
    ];
    const first = createVisionPagePlan({ analysis: analysis(regions), renderFingerprint: 'render-a' });
    const second = createVisionPagePlan({
      analysis: analysis([...regions].reverse()), renderFingerprint: 'render-a',
    });

    expect(first.planDigest).toBe(second.planDigest);
    expect(first.regions.map((region) => region.id).sort())
      .toEqual(second.regions.map((region) => region.id).sort());
    expect(planToVisionAnalysis(first).regions.every((region) => region.localId)).toBe(true);
  });

  it('rejects a cached plan whose content no longer matches its digest', () => {
    const plan = createVisionPagePlan({ analysis: analysis([]), renderFingerprint: 'render-a' });
    expect(parseCachedVisionPagePlan(plan, 0)).toEqual(plan);
    expect(() => parseCachedVisionPagePlan({ ...plan, layout: 'single' }, 0)).toThrow('摘要不一致');
  });

  it('keeps equation numbers inside formula crops instead of treating them as captions', () => {
    const plan = createVisionPagePlan({
      analysis: analysis([{
        type: 'display_formula',
        bbox: [300, 400, 400, 80],
        captionBBox: [700, 440, 30, 20],
        captionPosition: 'below',
        column: 'full',
        confidence: 0.98,
      }]),
      renderFingerprint: 'render-formula',
    });

    expect(plan.regions[0]).toMatchObject({
      type: 'display_formula',
      captionPosition: 'none',
    });
    expect(plan.regions[0]).not.toHaveProperty('captionBBox');
  });

  it('keeps free-form evidence out of the structural digest while versioning runtime state', () => {
    const first = createVisionPagePlan({
      analysis: analysis([{
        type: 'figure', bbox: [100, 200, 300, 180], column: 'left', confidence: 0.91,
        evidence: 'diagram clearly visible',
      }]),
      renderFingerprint: 'render-a',
    });
    const second = createVisionPagePlan({
      analysis: analysis([{
        type: 'figure', bbox: [100, 200, 300, 180], column: 'left', confidence: 0.911,
        evidence: 'same diagram described using different words',
      }]),
      renderFingerprint: 'render-b',
    });
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.planVersion).not.toBe(second.planVersion);
  });

  it('reports unknown and cyclic order candidates without mutating the plan', () => {
    const plan = createVisionPagePlan({
      analysis: analysis([
        { type: 'figure', bbox: [100, 200, 300, 180], column: 'left', confidence: 0.9 },
        { type: 'table', bbox: [520, 400, 380, 220], column: 'right', confidence: 0.95 },
      ]),
      renderFingerprint: 'render-a',
    });
    const [left, right] = plan.regions;
    plan.orderCandidates = [
      { beforeRegionId: left!.id, afterRegionId: right!.id, confidence: 0.9, evidence: 'top down' },
      { beforeRegionId: right!.id, afterRegionId: left!.id, confidence: 0.9, evidence: 'conflict' },
      { beforeRegionId: left!.id, afterRegionId: 'missing', confidence: 0.9, evidence: 'unknown' },
    ];
    const before = JSON.stringify(plan);
    const codes = verifyVisionPagePlan(plan).map((issue) => issue.code);
    expect(codes).toContain('source-plan.order-cycle');
    expect(codes).toContain('source-plan.unknown-order-region');
    expect(JSON.stringify(plan)).toBe(before);
  });
});
