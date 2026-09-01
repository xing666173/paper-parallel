import { describe, expect, it } from 'vitest';
import {
  digestAcceptedDocumentPlan,
  inferCrossPageAssetCandidates,
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
});
