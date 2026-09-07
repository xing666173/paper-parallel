import { describe, expect, it } from 'vitest';
import { createVisionPagePlan } from '../../src/core/vision/pagePlan';
import {
  hasSubstantiveVisionCorrectionProgress,
  isVisionCorrectableReason,
  reconciliationValidationIssues,
  recoverLocallyRejectedRegions,
} from '../../src/core/vision/recoveryPolicy';
import type { VisionPlanValidationIssue } from '../../src/core/vision/planVerifier';

function issue(code: VisionPlanValidationIssue['code'], regionId = 'r', fingerprint: string = code): VisionPlanValidationIssue {
  return { stage: 'source-plan', code, severity: 'error', pageIndex: 0, regionId,
    reason: code, allowedFields: ['bbox'], fingerprint };
}

describe('vision recovery policy', () => {
  it('allows geometry correction for an asset that includes another asset caption', () => {
    const plan = createVisionPagePlan({ analysis: {
      pageIndex: 0, layout: 'single', regions: [{
        type: 'figure', bbox: [100, 300, 700, 200], column: 'full', confidence: 0.99,
      }],
    }, renderFingerprint: 'foreign-caption' });
    expect(isVisionCorrectableReason('foreign-caption-overlap')).toBe(true);
    const issues = reconciliationValidationIssues(new Map([[0, plan]]), {
      assetRegions: [], unresolved: [{
        pageIndex: 0, regionIndex: 0, regionId: plan.regions[0]!.id,
        type: 'figure', reason: 'foreign-caption-overlap',
      }],
    });
    expect(issues[0]!.code).toBe('source-plan.foreign-caption-overlap');
    expect(issues[0]!.allowedFields).toEqual(['bbox']);
  });

  it('retains uncertain regions instead of treating low confidence as proof they are absent', () => {
    const plan = createVisionPagePlan({ analysis: {
      pageIndex: 0, layout: 'single', regions: [{
        type: 'display_formula', bbox: [100, 300, 700, 20], column: 'full', confidence: 0.5,
      }],
    }, renderFingerprint: 'raster-formula' });
    const retained = recoverLocallyRejectedRegions(plan, { assetRegions: [], unresolved: [{
      pageIndex: 0, regionIndex: 0, regionId: plan.regions[0]!.id,
      type: 'display_formula', reason: 'low-confidence',
    }] });
    expect(retained).toBe(plan);
    expect(retained.recoveryActions).toEqual([]);
  });

  it('continues after a repaired first defect exposes another defect on the same region', () => {
    expect(hasSubstantiveVisionCorrectionProgress(
      [issue('source-plan.page-edge-touch')],
      [issue('source-plan.page-coverage-excessive')],
    )).toBe(true);
  });

  it('does not count jittered coordinates as repair of the same defect', () => {
    expect(hasSubstantiveVisionCorrectionProgress(
      [issue('source-plan.caption-overlap', 'r', 'original-box')],
      [issue('source-plan.caption-overlap', 'r', 'slightly-moved-box')],
    )).toBe(false);
  });

  it('recognizes resolved regions and completion while rejecting added defects', () => {
    const before = [issue('source-plan.page-edge-touch')];
    expect(hasSubstantiveVisionCorrectionProgress(before, [])).toBe(true);
    expect(hasSubstantiveVisionCorrectionProgress(before, [
      issue('source-plan.caption-overlap'), issue('source-plan.page-coverage-excessive'),
    ])).toBe(false);
    expect(hasSubstantiveVisionCorrectionProgress([], [])).toBe(false);
  });
});
