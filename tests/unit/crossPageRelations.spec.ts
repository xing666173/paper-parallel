import { describe, expect, it } from 'vitest';
import {
  digestAcceptedDocumentPlan,
  inferCrossPageAssetCandidates,
  parseAcceptedDocumentPlan,
  validateCrossPageAssetCandidates,
} from '../../src/core/vision/crossPageRelations';
import { createVisionPagePlan } from '../../src/core/vision/pagePlan';

function plan(pageIndex: number) {
  return createVisionPagePlan({
    analysis: {
      pageIndex, layout: 'double', regions: [
        { type: 'table', bbox: [100, 50, 800, 900], column: 'full', confidence: 0.95 },
      ],
    },
    renderFingerprint: `render-${pageIndex}`,
  });
}

describe('cross-page asset relationship gate', () => {
  it('requires strong evidence or two independent weak signals', () => {
    const plans = [plan(0), plan(1)];
    const members = [
      { pageIndex: 0, regionId: plans[0]!.regions[0]!.id, role: 'head' as const },
      { pageIndex: 1, regionId: plans[1]!.regions[0]!.id, role: 'tail' as const },
    ];
    const rejected = validateCrossPageAssetCandidates(plans, [{
      kind: 'table', members, weakEvidence: ['same-column'], provenance: ['exp-candidate'],
    }]);
    expect(rejected.groups).toEqual([]);
    expect(rejected.issues[0]?.code).toBe('cross-page.insufficient-evidence');

    const accepted = validateCrossPageAssetCandidates(plans, [{
      kind: 'table', members,
      weakEvidence: ['same-column', 'repeated-table-header'], provenance: ['exp-candidate', 'pdfjs'],
    }]);
    expect(accepted.issues).toEqual([]);
    expect(accepted.groups[0]).toMatchObject({ status: 'validated', kind: 'table' });
    expect(digestAcceptedDocumentPlan(plans, accepted.groups))
      .toBe(digestAcceptedDocumentPlan([...plans].reverse(), [...accepted.groups].reverse()));
  });

  it('rejects non-adjacent or dangling members', () => {
    const plans = [plan(0), plan(2)];
    const result = validateCrossPageAssetCandidates(plans, [{
      kind: 'table',
      members: [
        { pageIndex: 0, regionId: plans[0]!.regions[0]!.id, role: 'head' },
        { pageIndex: 2, regionId: 'missing', role: 'tail' },
      ],
      strongEvidence: 'continued-label', weakEvidence: [], provenance: ['label'],
    }]);
    expect(result.groups).toEqual([]);
    expect(result.issues[0]?.code).toBe('cross-page.invalid-members');
  });

  it('uses compatible Exp page hints only to propose a locally evidenced candidate', () => {
    const first = createVisionPagePlan({
      analysis: { pageIndex: 0, layout: 'double', regions: [{
        type: 'table', bbox: [100, 850, 400, 150], column: 'full', confidence: 0.9,
        crossPageHint: 'starts',
      }] },
      renderFingerprint: 'first',
    });
    const second = createVisionPagePlan({
      analysis: { pageIndex: 1, layout: 'double', regions: [{
        type: 'table', bbox: [300, 0, 400, 100], column: 'full', confidence: 0.9,
        crossPageHint: 'ends',
      }] },
      renderFingerprint: 'second',
    });

    const candidates = inferCrossPageAssetCandidates([first, second]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.weakEvidence).toEqual(['page-edge-continuity', 'same-column']);
    expect(candidates[0]?.provenance).toContain('exp-page-continuation-proposal');
    expect(validateCrossPageAssetCandidates([first, second], candidates).groups).toHaveLength(1);
  });

  it('chains adjacent links into one three-page group with continuation roles', () => {
    const plans = [0, 1, 2].map((pageIndex) => createVisionPagePlan({
      analysis: { pageIndex, layout: 'double', regions: [{
        type: 'table', bbox: [100, 50, 800, 900], column: 'full', confidence: 0.95,
        crossPageHint: pageIndex === 0 ? 'starts' : pageIndex === 2 ? 'ends' : 'continues',
      }] },
      renderFingerprint: `chain-${pageIndex}`,
    }));
    const candidates = inferCrossPageAssetCandidates(plans);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.members.map((member) => member.role))
      .toEqual(['head', 'continuation', 'tail']);
    expect(validateCrossPageAssetCandidates(plans, candidates).groups[0]?.members).toHaveLength(3);
  });

  it('rejects member reuse and caption ownership outside the group', () => {
    const plans = [plan(0), plan(1), plan(2)];
    const first = {
      kind: 'table' as const,
      members: [
        { pageIndex: 0, regionId: plans[0]!.regions[0]!.id, role: 'head' as const },
        { pageIndex: 1, regionId: plans[1]!.regions[0]!.id, role: 'tail' as const },
      ],
      strongEvidence: 'continued-label' as const, weakEvidence: [], provenance: ['local'],
    };
    const overlapping = {
      kind: 'table' as const,
      members: [
        { pageIndex: 1, regionId: plans[1]!.regions[0]!.id, role: 'head' as const },
        { pageIndex: 2, regionId: plans[2]!.regions[0]!.id, role: 'tail' as const },
      ],
      strongEvidence: 'continued-label' as const, weakEvidence: [], provenance: ['local'],
    };
    const reused = validateCrossPageAssetCandidates(plans, [first, overlapping]);
    expect(reused.groups).toHaveLength(1);
    expect(reused.issues[0]?.code).toBe('cross-page.multiple-group-membership');
    const invalidCaption = validateCrossPageAssetCandidates(plans, [{ ...first, captionPageIndex: 2 }]);
    expect(invalidCaption.groups).toEqual([]);
    expect(invalidCaption.issues[0]?.code).toBe('cross-page.invalid-caption-owner');
  });

  it('strictly parses a persisted document plan and verifies its digest', () => {
    const plans = [plan(0), plan(1)];
    const validated = validateCrossPageAssetCandidates(plans, [{
      kind: 'table', members: [
        { pageIndex: 0, regionId: plans[0]!.regions[0]!.id, role: 'head' },
        { pageIndex: 1, regionId: plans[1]!.regions[0]!.id, role: 'tail' },
      ], strongEvidence: 'continued-label', weakEvidence: [], provenance: ['local'],
    }]);
    const value = {
      schemaVersion: 1,
      documentPlanDigest: digestAcceptedDocumentPlan(plans, validated.groups),
      pagePlanDigests: plans.map((item) => ({ pageIndex: item.pageIndex, planDigest: item.planDigest })),
      crossPageAssetGroups: validated.groups,
    };
    expect(parseAcceptedDocumentPlan(value)).toEqual(value);
    expect(() => parseAcceptedDocumentPlan({ ...value, hidden: true })).toThrow('未知字段 hidden');
    expect(() => parseAcceptedDocumentPlan({ ...value, documentPlanDigest: 'tampered' })).toThrow('摘要不一致');
  });
});
