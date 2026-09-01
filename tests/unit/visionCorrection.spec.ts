import { describe, expect, it, vi } from 'vitest';
import {
  applyVisionCorrectionPatch,
  buildVisionCorrectionPrompt,
  parseVisionCorrectionPatch,
  requestVisionCorrection,
  replayCachedVisionCorrection,
  type VisionCorrectionPatch,
} from '../../src/core/vision/correction';
import { createVisionPagePlan, withRecomputedPlanVersion } from '../../src/core/vision/pagePlan';
import type { VisionPlanValidationIssue } from '../../src/core/vision/planVerifier';

function fixture() {
  return createVisionPagePlan({
    analysis: {
      pageIndex: 0,
      layout: 'double',
      regions: [
        { type: 'table', bbox: [100, 200, 350, 120], column: 'left', confidence: 0.9 },
        { type: 'figure', bbox: [520, 200, 350, 220], column: 'right', confidence: 0.9 },
      ],
    },
    renderFingerprint: 'render-a',
  });
}

function issue(regionId: string): VisionPlanValidationIssue {
  return {
    stage: 'source-plan', code: 'source-plan.caption-overlap', severity: 'error',
    pageIndex: 0, regionId, reason: 'caption overlap', allowedFields: ['bbox', 'captionBBox'],
    fingerprint: `0|caption-overlap|${regionId}`,
  };
}

describe('vision correction patch', () => {
  it('states JSON explicitly when requesting json_object response format', () => {
    const plan = fixture();
    const prompt = buildVisionCorrectionPrompt({
      plan, issues: [issue(plan.regions[0]!.id)], round: 1,
    });
    expect(prompt).toMatch(/JSON/i);
    expect(prompt).toContain(`"page":${plan.pageIndex + 1}`);
    expect(prompt).toContain(`"base_plan_version":"${plan.planVersion}"`);
    expect(prompt).toContain('"round":1');
  });

  it('applies an allowed update against the exact base version and preserves the input', () => {
    const plan = fixture();
    const regionId = plan.regions[0]!.id;
    const patch: VisionCorrectionPatch = {
      schemaVersion: 1, patchId: 'patch-1', pageIndex: 0,
      basePlanVersion: plan.planVersion, round: 1,
      operations: [{ type: 'update-region', regionId, changes: { bbox: [100, 210, 350, 150] } }],
    };
    const before = JSON.stringify(plan);
    const next = applyVisionCorrectionPatch(plan, patch, { issues: [issue(regionId)] });
    expect(next.regions[0]?.bbox).toEqual([100, 210, 350, 150]);
    expect(next.basePlanVersion).toBe(plan.planVersion);
    expect(next.appliedPatchIds).toEqual(['patch-1']);
    expect(next.planVersion).not.toBe(plan.planVersion);
    expect(JSON.stringify(plan)).toBe(before);
    expect(() => applyVisionCorrectionPatch(next, patch, { issues: [issue(regionId)] }))
      .toThrow('基础版本已经过期');
  });

  it('rejects the whole patch when any operation targets a locked region', () => {
    const original = fixture();
    const plan = withRecomputedPlanVersion({
      ...original,
      regions: original.regions.map((region, index) => ({ ...region, locked: index === 1 })),
    });
    const [first, locked] = plan.regions;
    const patch: VisionCorrectionPatch = {
      schemaVersion: 1, patchId: 'patch-atomic', pageIndex: 0,
      basePlanVersion: plan.planVersion, round: 1,
      operations: [
        { type: 'update-region', regionId: first!.id, changes: { bbox: [100, 210, 350, 150] } },
        { type: 'update-region', regionId: locked!.id, changes: { bbox: [520, 210, 350, 230] } },
      ],
    };
    const before = JSON.stringify(plan);
    expect(() => applyVisionCorrectionPatch(plan, patch, {
      issues: [issue(first!.id), issue(locked!.id)],
    })).toThrow('已锁定区域');
    expect(JSON.stringify(plan)).toBe(before);
  });

  it('parses only the operation whitelist and rejects direct reading-order writes', () => {
    expect(() => parseVisionCorrectionPatch({
      schema_version: 1, patch_id: 'bad', page: 1, base_plan_version: 'p', round: 1,
      operations: [{ type: 'change-reading-order', orderedUnitIds: ['a', 'b'] }],
    })).toThrow('不支持补丁操作');
  });

  it('rejects unknown envelope, operation and nested region fields', () => {
    const base = {
      schema_version: 1, patch_id: 'bad', page: 1, base_plan_version: 'p', round: 1,
      operations: [],
    };
    expect(() => parseVisionCorrectionPatch({ ...base, hidden: true })).toThrow('不允许字段 hidden');
    expect(() => parseVisionCorrectionPatch({
      ...base, operations: [{ type: 'remove-region', region_id: 'r', reason: 'x', hidden: true }],
    })).toThrow('不允许字段 hidden');
    expect(() => parseVisionCorrectionPatch({
      ...base, operations: [{
        type: 'add-region', region: {
          id: 'tmp', type: 'figure', bbox: [1, 1, 10, 10], column: 'left',
          caption_position: 'none', confidence: 0.9, evidence: '', hidden: true,
        },
      }],
    })).toThrow('不允许字段 hidden');
  });

  it('replaces provider ids for added regions with deterministic local ids', () => {
    const plan = fixture();
    const patch = parseVisionCorrectionPatch({
      schema_version: 1, patch_id: 'add', page: 1,
      base_plan_version: plan.planVersion, round: 1,
      operations: [{
        type: 'add-region', region: {
          id: 'provider-new-asset', type: 'code', bbox: [100, 600, 300, 120],
          column: 'left', caption_position: 'none', confidence: 0.9, evidence: 'visible code',
        },
      }],
    });
    const next = applyVisionCorrectionPatch(plan, patch, { issues: [{
      stage: 'source-plan', code: 'source-plan.missing-region', severity: 'error',
      pageIndex: 0, reason: 'missing', allowedFields: ['regions'], fingerprint: 'missing',
    }] });
    expect(next.regions.at(-1)?.id).toMatch(/^vp-p1-code-/);
    expect(next.regions.at(-1)).toMatchObject({ modelTemporaryId: 'provider-new-asset' });
  });

  it('requires full-page coordinate context for round-two crops', () => {
    const plan = fixture();
    expect(() => buildVisionCorrectionPrompt({
      plan, issues: [issue(plan.regions[0]!.id)], round: 2,
    })).toThrow('缺少局部裁图坐标上下文');
    const prompt = buildVisionCorrectionPrompt({
      plan, issues: [issue(plan.regions[0]!.id)], round: 2,
      localContext: {
        cropBBox: [100, 200, 300, 400],
        adjacentTextAnchors: [{
          blockId: 'b1', relation: 'before', bbox: [100, 150, 300, 30], text: 'nearby source text',
        }],
        candidateRegions: [{
          regionId: plan.regions[0]!.id, type: 'table', bbox: [100, 200, 350, 120],
          issueCodes: ['source-plan.caption-overlap'],
        }],
      },
    });
    expect(prompt).toContain('[100,200,300,400]');
    expect(prompt).toContain('nearby source text');
    expect(prompt).toContain('full-page coordinates');
  });

  it('normalizes the bounded provider aliases before applying the same strict atomic gate', () => {
    const plan = fixture();
    const regionId = plan.regions[0]!.id;
    const patch = parseVisionCorrectionPatch({
      schema_version: 1,
      patch_id: 'provider-alias',
      page: 1,
      base_plan_version: plan.planVersion,
      round: 1,
      operations: [{
        op: 'update',
        regionId,
        fields: {
          bbox: [100, 210, 350, 150],
          captionBBox: [100, 365, 350, 20],
        },
      }],
    });

    expect(patch.operations[0]).toMatchObject({
      type: 'update-region',
      regionId,
      changes: {
        bbox: [100, 210, 350, 150],
        captionBBox: [100, 365, 350, 20],
      },
    });
    const next = applyVisionCorrectionPatch(plan, patch, { issues: [issue(regionId)] });
    expect(next.regions[0]).toMatchObject({
      bbox: [100, 210, 350, 150],
      captionBBox: [100, 365, 350, 20],
    });
  });

  it('resumes only when a cached patch replays to the exact persisted corrected plan', () => {
    const plan = fixture();
    const regionId = plan.regions[0]!.id;
    const patch: VisionCorrectionPatch = {
      schemaVersion: 1,
      patchId: 'resume-patch',
      pageIndex: 0,
      basePlanVersion: plan.planVersion,
      round: 1,
      operations: [{ type: 'update-region', regionId, changes: { bbox: [100, 210, 350, 150] } }],
    };
    const corrected = applyVisionCorrectionPatch(plan, patch, { issues: [issue(regionId)] });

    expect(replayCachedVisionCorrection({
      patchValue: patch,
      planValue: corrected,
      patchBase: plan,
      issues: [issue(regionId)],
      round: 1,
    })).toEqual({ patch, plan: corrected });
    expect(() => replayCachedVisionCorrection({
      patchValue: patch,
      planValue: { ...corrected, planVersion: 'plan-stale' },
      patchBase: plan,
      issues: [issue(regionId)],
      round: 1,
    })).toThrow();
  });

  it('does not retry the model after a local correction-cache write failure', async () => {
    const plan = fixture();
    const regionId = plan.regions[0]!.id;
    const complete = vi.fn(async () => ({
      content: JSON.stringify({
        schema_version: 1, patch_id: 'p1', page: 1,
        base_plan_version: plan.planVersion, round: 1,
        operations: [{
          type: 'update-region', region_id: regionId,
          changes: { bbox: [100, 210, 350, 150] },
        }],
      }),
      usage: { promptTokens: 2, completionTokens: 1 },
    }));
    await expect(requestVisionCorrection({
      plan,
      issues: [issue(regionId)],
      round: 1,
      imageUrl: 'data:image/png;base64,PAGE',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      complete,
      onRawResponse: async () => { throw new Error('quota'); },
    })).rejects.toMatchObject({ name: 'CachePersistenceError' });
    expect(complete).toHaveBeenCalledOnce();
  });

  it('retries a syntactically valid patch that fails the atomic local gate and counts all usage', async () => {
    const plan = fixture();
    const regionId = plan.regions[0]!.id;
    const responses = [
      {
        schema_version: 1, patch_id: 'bad-noop', page: 1,
        base_plan_version: plan.planVersion, round: 1,
        operations: [{
          type: 'update-region', region_id: regionId,
          changes: { bbox: [...plan.regions[0]!.bbox] },
        }],
      },
      {
        schema_version: 1, patch_id: 'fixed', page: 1,
        base_plan_version: plan.planVersion, round: 1,
        operations: [{
          type: 'update-region', region_id: regionId,
          changes: { bbox: [100, 210, 350, 150] },
        }],
      },
    ];
    const complete = vi.fn(async () => ({
      content: JSON.stringify(responses.shift()),
      usage: { promptTokens: 2, completionTokens: 1 },
    }));
    const result = await requestVisionCorrection({
      plan,
      issues: [issue(regionId)],
      round: 1,
      imageUrl: 'data:image/png;base64,PAGE',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      complete,
      validatePatch: (patch) => { applyVisionCorrectionPatch(plan, patch, { issues: [issue(regionId)] }); },
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.patch.patchId).toBe('fixed');
    expect(result.usage).toEqual({ promptTokens: 4, completionTokens: 2 });
    expect(result.networkAttempts).toBe(2);
  });
});
