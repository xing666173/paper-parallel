import type { VisionRegionType } from './protocol';
import type { VisionPagePlan } from './pagePlan';

export type CrossPageMemberRole = 'head' | 'continuation' | 'tail';
export type WeakCrossPageEvidence =
  | 'page-edge-continuity'
  | 'repeated-table-header'
  | 'same-column'
  | 'text-anchor-continuity'
  | 'graphic-continuity';

export interface CrossPageAssetCandidateMember {
  pageIndex: number;
  regionId: string;
  role: CrossPageMemberRole;
}

export interface CrossPageAssetCandidate {
  kind: Extract<VisionRegionType, 'figure' | 'table' | 'code'>;
  members: CrossPageAssetCandidateMember[];
  captionPageIndex?: number;
  captionAnchor?: string;
  strongEvidence?: 'continued-label' | 'same-numbered-caption';
  weakEvidence: WeakCrossPageEvidence[];
  provenance: string[];
}

export interface CrossPageAssetGroup extends CrossPageAssetCandidate {
  id: string;
  status: 'validated';
}

export interface CrossPageRelationIssue {
  code: 'cross-page.insufficient-evidence' | 'cross-page.invalid-members' | 'cross-page.unknown-region';
  candidateIndex: number;
  message: string;
}

function normalizedLabel(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  return normalized || undefined;
}

/** Produces candidates only from adjacent page-edge regions; validation remains authoritative. */
export function inferCrossPageAssetCandidates(
  plans: readonly VisionPagePlan[],
): CrossPageAssetCandidate[] {
  const byPage = new Map(plans.map((plan) => [plan.pageIndex, plan]));
  const candidates: CrossPageAssetCandidate[] = [];
  const used = new Set<string>();
  for (const plan of [...plans].sort((left, right) => left.pageIndex - right.pageIndex)) {
    const next = byPage.get(plan.pageIndex + 1);
    if (!next) continue;
    const tails = plan.regions.filter((region) => (
      ['figure', 'table', 'code'].includes(region.type) && region.bbox[1] + region.bbox[3] >= 900
    ));
    const heads = next.regions.filter((region) => (
      ['figure', 'table', 'code'].includes(region.type) && region.bbox[1] <= 120
    ));
    for (const tail of tails) {
      const compatible = heads
        .filter((head) => head.type === tail.type && !used.has(`${next.pageIndex}:${head.id}`))
        .map((head) => {
          const sameColumn = head.column === tail.column;
          const geometryDistance = Math.abs(head.bbox[0] - tail.bbox[0])
            + Math.abs(head.bbox[2] - tail.bbox[2]);
          const tailLabel = normalizedLabel(tail.visibleLabel);
          const headLabel = normalizedLabel(head.visibleLabel);
          const sameLabel = Boolean(tailLabel && headLabel && tailLabel === headLabel);
          const continued = /\bcont(?:inued|\.)?\b/i.test(`${tail.visibleLabel ?? ''} ${head.visibleLabel ?? ''}`);
          const hintCompatible = ['starts', 'continues'].includes(tail.crossPageHint ?? '')
            && ['continues', 'ends'].includes(head.crossPageHint ?? '');
          const weakEvidence: WeakCrossPageEvidence[] = ['page-edge-continuity'];
          if (sameColumn) weakEvidence.push('same-column');
          if (geometryDistance <= 100) weakEvidence.push('graphic-continuity');
          if (tail.type === 'table' && sameLabel) weakEvidence.push('repeated-table-header');
          return {
            head,
            geometryDistance,
            hintCompatible,
            weakEvidence,
            strongEvidence: continued
              ? 'continued-label' as const
              : sameLabel
                ? 'same-numbered-caption' as const
                : undefined,
          };
        })
        // Automatic inference is deliberately stricter than validating an
        // explicit Exp candidate: without a visible continued label, require
        // page-edge, column and graphic continuity together.
        .filter((candidate) => candidate.strongEvidence
          || new Set(candidate.weakEvidence).size >= (candidate.hintCompatible ? 2 : 3))
        .sort((left, right) => (
          Number(right.hintCompatible) - Number(left.hintCompatible)
          || left.geometryDistance - right.geometryDistance
        ))[0];
      if (!compatible) continue;
      used.add(`${plan.pageIndex}:${tail.id}`);
      used.add(`${next.pageIndex}:${compatible.head.id}`);
      candidates.push({
        kind: tail.type as CrossPageAssetCandidate['kind'],
        members: [
          { pageIndex: plan.pageIndex, regionId: tail.id, role: 'head' },
          { pageIndex: next.pageIndex, regionId: compatible.head.id, role: 'tail' },
        ],
        ...(compatible.strongEvidence ? { strongEvidence: compatible.strongEvidence } : {}),
        weakEvidence: compatible.weakEvidence,
        provenance: [
          'local-page-edge-inference',
          ...(compatible.hintCompatible ? ['exp-page-continuation-proposal'] : []),
        ],
      });
    }
  }
  return candidates;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function digestAcceptedDocumentPlan(
  plans: readonly VisionPagePlan[],
  groups: readonly CrossPageAssetGroup[],
): string {
  const normalized = {
    pages: [...plans]
      .sort((left, right) => left.pageIndex - right.pageIndex)
      .map((plan) => ({ pageIndex: plan.pageIndex, planDigest: plan.planDigest })),
    crossPageAssetGroups: [...groups]
      .map((group) => ({
        id: group.id,
        kind: group.kind,
        members: [...group.members].sort((left, right) => left.pageIndex - right.pageIndex),
        captionPageIndex: group.captionPageIndex,
        captionAnchor: group.captionAnchor,
        strongEvidence: group.strongEvidence,
        weakEvidence: [...group.weakEvidence].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return stableHash(JSON.stringify(normalized));
}

export function validateCrossPageAssetCandidates(
  plans: readonly VisionPagePlan[],
  candidates: readonly CrossPageAssetCandidate[],
): { groups: CrossPageAssetGroup[]; issues: CrossPageRelationIssue[] } {
  const regionByKey = new Map(plans.flatMap((plan) => plan.regions.map((region) => [
    `${plan.pageIndex}:${region.id}`,
    region,
  ] as const)));
  const groups: CrossPageAssetGroup[] = [];
  const issues: CrossPageRelationIssue[] = [];
  candidates.forEach((candidate, candidateIndex) => {
    const members = [...candidate.members].sort((left, right) => left.pageIndex - right.pageIndex);
    const uniquePages = new Set(members.map((member) => member.pageIndex));
    const adjacent = members.every((member, index) => (
      index === 0 || member.pageIndex === members[index - 1]!.pageIndex + 1
    ));
    const rolesValid = members.length >= 2
      && members[0]?.role === 'head'
      && members[members.length - 1]?.role === 'tail'
      && members.slice(1, -1).every((member) => member.role === 'continuation')
      && uniquePages.size === members.length
      && adjacent;
    if (!rolesValid) {
      issues.push({
        code: 'cross-page.invalid-members', candidateIndex,
        message: '跨页资产成员必须位于连续页面，并按 head/continuation/tail 排列',
      });
      return;
    }
    const unknown = members.find((member) => {
      const region = regionByKey.get(`${member.pageIndex}:${member.regionId}`);
      return !region || region.type !== candidate.kind;
    });
    if (unknown) {
      issues.push({
        code: 'cross-page.unknown-region', candidateIndex,
        message: `跨页资产引用未知或类型不一致的区域 ${unknown.regionId}`,
      });
      return;
    }
    const independentWeakEvidence = new Set(candidate.weakEvidence);
    if (!candidate.strongEvidence && independentWeakEvidence.size < 2) {
      issues.push({
        code: 'cross-page.insufficient-evidence', candidateIndex,
        message: '跨页资产缺少强证据或至少两项独立弱证据',
      });
      return;
    }
    const identity = [candidate.kind, ...members.map((member) => `${member.pageIndex}:${member.regionId}:${member.role}`)]
      .join('|');
    groups.push({
      ...candidate,
      members,
      weakEvidence: [...independentWeakEvidence].sort(),
      provenance: [...candidate.provenance],
      id: `cross-page-${candidate.kind}-${stableHash(identity)}`,
      status: 'validated',
    });
  });
  return { groups, issues };
}
