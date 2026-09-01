import type {
  NormalizedVisionBox,
  VisionColumn,
  VisionCrossPageHint,
  VisionPageAnalysis,
  VisionRegionType,
} from './protocol';

export const VISION_PAGE_PLAN_SCHEMA_VERSION = 1 as const;
export const VISION_PLAN_CANONICALIZATION_VERSION = 'vision-plan-c14n-v2';

export type VisionPlanOrigin = 'initial' | 'correction-1' | 'correction-2';
export type VisionCaptionPosition = 'above' | 'below' | 'none' | 'unknown';

export interface VisionTextAnchor {
  blockId: string;
  textDigest: string;
  edge: 'before' | 'after';
}

export interface VisionOrderCandidate {
  beforeRegionId: string;
  afterRegionId: string;
  confidence: number;
  evidence: string;
}

export interface VisionPlanRegion {
  /** Local plan ID. Model-provided temporary IDs are never used as semantic IDs. */
  id: string;
  modelTemporaryId?: string;
  type: VisionRegionType;
  bbox: NormalizedVisionBox;
  column: VisionColumn;
  captionBBox?: NormalizedVisionBox;
  visibleLabel?: string;
  captionPosition: VisionCaptionPosition;
  crossPageHint?: VisionCrossPageHint;
  beforeAnchor?: VisionTextAnchor;
  afterAnchor?: VisionTextAnchor;
  confidence: number;
  evidence: string;
  locked: boolean;
}

export interface VisionPagePlan {
  schemaVersion: typeof VISION_PAGE_PLAN_SCHEMA_VERSION;
  canonicalizationVersion: typeof VISION_PLAN_CANONICALIZATION_VERSION;
  pageIndex: number;
  layout: VisionPageAnalysis['layout'];
  planVersion: string;
  basePlanVersion?: string;
  renderFingerprint: string;
  renderScale: number;
  origin: VisionPlanOrigin;
  regions: VisionPlanRegion[];
  orderCandidates: VisionOrderCandidate[];
  recoveryActions: Array<{ type: 'remove-rejected-region' | 'geometry-snap'; regionId: string; reason: string }>;
  appliedPatchIds: string[];
  planDigest: string;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function quantizedBox(box: NormalizedVisionBox): NormalizedVisionBox {
  return box.map((value) => Math.round(value * 10) / 10) as NormalizedVisionBox;
}

function regionAnchor(region: Pick<VisionPlanRegion, 'type' | 'bbox' | 'visibleLabel'>): string {
  return [region.type, region.visibleLabel?.trim().toLocaleLowerCase() ?? '', ...quantizedBox(region.bbox)]
    .join('|');
}

function stableRegionIds(
  pageIndex: number,
  regions: readonly Omit<VisionPlanRegion, 'id'>[],
): VisionPlanRegion[] {
  const collisions = new Map<string, number>();
  return regions.map((region) => {
    const anchor = regionAnchor(region);
    const base = `vp-p${pageIndex + 1}-${region.type.replace('display_', '')}-${fnv1a(anchor)}`;
    const collision = (collisions.get(base) ?? 0) + 1;
    collisions.set(base, collision);
    return { ...region, id: collision === 1 ? base : `${base}-${collision}` };
  });
}

export function createVisionPagePlan(input: {
  analysis: VisionPageAnalysis;
  renderFingerprint: string;
  renderScale?: number;
  origin?: VisionPlanOrigin;
}): VisionPagePlan {
  const regions = stableRegionIds(input.analysis.pageIndex, input.analysis.regions.map((region) => {
    // An equation number belongs inside the immutable formula crop; it is not
    // a separately translated caption. Vision providers regularly report it
    // as caption_bbox, which otherwise creates a permanent unmatched-caption
    // correction loop.
    const captionBBox = region.type === 'display_formula' ? undefined : region.captionBBox;
    return {
      modelTemporaryId: region.temporaryId,
      type: region.type,
      bbox: [...region.bbox] as NormalizedVisionBox,
      column: region.column,
      ...(captionBBox ? { captionBBox: [...captionBBox] as NormalizedVisionBox } : {}),
      visibleLabel: region.visibleLabel,
      captionPosition: region.type === 'display_formula'
        ? 'none' as const
        : region.captionPosition ?? (captionBBox ? 'unknown' : 'none'),
      crossPageHint: region.crossPageHint,
      confidence: region.confidence,
      evidence: region.evidence ?? '',
      locked: false,
    };
  }));
  const draft: Omit<VisionPagePlan, 'planDigest' | 'planVersion'> = {
    schemaVersion: VISION_PAGE_PLAN_SCHEMA_VERSION,
    canonicalizationVersion: VISION_PLAN_CANONICALIZATION_VERSION,
    pageIndex: input.analysis.pageIndex,
    layout: input.analysis.layout,
    renderFingerprint: input.renderFingerprint,
    renderScale: input.renderScale ?? 2,
    origin: input.origin ?? 'initial',
    regions,
    orderCandidates: [],
    recoveryActions: [],
    appliedPatchIds: [],
  };
  const planDigest = digestVisionPagePlan(draft);
  return { ...draft, planDigest, planVersion: `plan-${versionVisionPagePlan(draft)}` };
}

function normalizedPlanValue(
  plan: Omit<VisionPagePlan, 'planDigest' | 'planVersion'> | VisionPagePlan,
): unknown {
  return {
    schemaVersion: plan.schemaVersion,
    canonicalizationVersion: plan.canonicalizationVersion,
    pageIndex: plan.pageIndex,
    layout: plan.layout,
    regions: [...plan.regions]
      .map((region) => ({
        id: region.id,
        type: region.type,
        bbox: quantizedBox(region.bbox),
        column: region.column,
        captionBBox: region.captionBBox ? quantizedBox(region.captionBBox) : undefined,
        visibleLabel: region.visibleLabel?.trim() || undefined,
        captionPosition: region.captionPosition,
        crossPageHint: region.crossPageHint,
        beforeAnchor: region.beforeAnchor,
        afterAnchor: region.afterAnchor,
        confidence: Math.round(region.confidence * 100) / 100,
      }))
      .sort((left, right) => (
        left.type.localeCompare(right.type)
        || left.bbox[1] - right.bbox[1]
        || left.bbox[0] - right.bbox[0]
        || left.id.localeCompare(right.id)
      )),
    orderCandidates: [...plan.orderCandidates]
      .map((edge) => ({
        ...edge,
        confidence: Math.round(edge.confidence * 100) / 100,
      }))
      .sort((left, right) => (
        left.beforeRegionId.localeCompare(right.beforeRegionId)
        || left.afterRegionId.localeCompare(right.afterRegionId)
      )),
    recoveryActions: [...plan.recoveryActions]
      .map((action) => ({ ...action }))
      .sort((left, right) => left.regionId.localeCompare(right.regionId) || left.type.localeCompare(right.type)),
  };
}

export function digestVisionPagePlan(
  plan: Omit<VisionPagePlan, 'planDigest' | 'planVersion'> | VisionPagePlan,
): string {
  return fnv1a(JSON.stringify(normalizedPlanValue(plan)));
}

function versionVisionPagePlan(
  plan: Omit<VisionPagePlan, 'planDigest' | 'planVersion'> | VisionPagePlan,
): string {
  return fnv1a(JSON.stringify({
    structural: normalizedPlanValue(plan),
    renderFingerprint: plan.renderFingerprint,
    renderScale: plan.renderScale,
    origin: plan.origin,
    basePlanVersion: plan.basePlanVersion,
    locks: [...plan.regions].map((region) => [region.id, region.locked]).sort(),
    regionEvidence: [...plan.regions]
      .map((region) => [region.id, region.modelTemporaryId ?? '', region.evidence.trim()])
      .sort(),
    orderEvidence: [...plan.orderCandidates]
      .map((edge) => [edge.beforeRegionId, edge.afterRegionId, edge.evidence.trim()])
      .sort(),
    appliedPatchIds: [...plan.appliedPatchIds].sort(),
    recoveryActions: [...plan.recoveryActions]
      .map((action) => ({ ...action }))
      .sort((left, right) => left.regionId.localeCompare(right.regionId) || left.type.localeCompare(right.type)),
  }));
}

export function planToVisionAnalysis(plan: VisionPagePlan): VisionPageAnalysis {
  return {
    pageIndex: plan.pageIndex,
    layout: plan.layout,
    regions: plan.regions.map((region) => ({
      type: region.type,
      bbox: [...region.bbox] as NormalizedVisionBox,
      column: region.column,
      ...(region.captionBBox ? { captionBBox: [...region.captionBBox] as NormalizedVisionBox } : {}),
      confidence: region.confidence,
      temporaryId: region.modelTemporaryId,
      localId: region.id,
      visibleLabel: region.visibleLabel,
      captionPosition: region.captionPosition,
      crossPageHint: region.crossPageHint,
      evidence: region.evidence,
    })),
  };
}

export function withRecomputedPlanVersion(
  plan: Omit<VisionPagePlan, 'planDigest' | 'planVersion'>,
): VisionPagePlan {
  const planDigest = digestVisionPagePlan(plan);
  return { ...plan, planDigest, planVersion: `plan-${versionVisionPagePlan(plan)}` };
}

export function parseCachedVisionPagePlan(value: unknown, expectedPageIndex: number): VisionPagePlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('缓存页面计划必须为对象');
  const plan = value as Partial<VisionPagePlan>;
  if (plan.schemaVersion !== VISION_PAGE_PLAN_SCHEMA_VERSION
    || plan.canonicalizationVersion !== VISION_PLAN_CANONICALIZATION_VERSION
    || plan.pageIndex !== expectedPageIndex
    || typeof plan.planVersion !== 'string'
    || typeof plan.planDigest !== 'string'
    || typeof plan.renderFingerprint !== 'string'
    || typeof plan.renderScale !== 'number'
    || !Number.isFinite(plan.renderScale)
    || plan.renderScale <= 0
    || !Array.isArray(plan.regions)
    || !Array.isArray(plan.orderCandidates)
    || !Array.isArray(plan.recoveryActions)
    || !Array.isArray(plan.appliedPatchIds)) {
    throw new Error('缓存页面计划版本或字段无效');
  }
  const candidate = plan as VisionPagePlan;
  if (digestVisionPagePlan(candidate) !== candidate.planDigest
    || candidate.planVersion !== `plan-${versionVisionPagePlan(candidate)}`) {
    throw new Error('缓存页面计划摘要不一致');
  }
  return candidate;
}
