import type { Doc, Rect } from '../../types/models';
import type { DetectedAssetRegion } from '../assets/extract';
import { validateImmutableRegion, type ImmutableGeometryIssue } from '../assets/geometryGate';
import { isFigureCaptionText, isTableCaptionText } from '../parser/blocks';
import type { VisionPageAnalysis, VisionRegion, NormalizedVisionBox } from './protocol';

export type VisionReconciliationReason =
  | 'low-confidence'
  | 'caption-unmatched'
  | ImmutableGeometryIssue;

export interface UnresolvedVisionRegion {
  pageIndex: number;
  regionIndex: number;
  type: VisionRegion['type'];
  reason: VisionReconciliationReason;
}

export interface VisionReconciliationResult {
  assetRegions: DetectedAssetRegion[];
  unresolved: UnresolvedVisionRegion[];
}

function sourceRect(box: NormalizedVisionBox, page: { width: number; height: number }): Rect {
  const [x, y, width, height] = box;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    x: round(x / 1000 * page.width),
    y: round(y / 1000 * page.height),
    w: round(width / 1000 * page.width),
    h: round(height / 1000 * page.height),
  };
}

function intersectionArea(left: Rect, right: Rect): number {
  return Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x))
    * Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y));
}

function captionFor(
  doc: Doc,
  pageIndex: number,
  captionRect: Rect | undefined,
  assetType: VisionRegion['type'],
  assetRect: Rect,
): Doc['blocks'][number] | undefined {
  const candidates = doc.blocks.filter((block) => {
    if (block.pageIndex !== pageIndex) return false;
    const text = block.text ?? '';
    if (assetType === 'table') return isTableCaptionText(text);
    if (assetType === 'figure') return isFigureCaptionText(text);
    return block.type === 'caption';
  });
  if (captionRect) {
    const overlapping = candidates
      .map((block) => ({ block, overlap: intersectionArea(block.rect, captionRect) }))
      .filter((candidate) => candidate.overlap / Math.max(1, candidate.block.rect.w * candidate.block.rect.h) >= 0.2)
      .sort((left, right) => right.overlap - left.overlap)[0]?.block;
    if (overlapping) return overlapping;

    const captionCenterX = captionRect.x + captionRect.w / 2;
    const captionCenterY = captionRect.y + captionRect.h / 2;
    const nearby = candidates
      .map((block) => {
        const horizontalOverlap = Math.max(0, Math.min(
          block.rect.x + block.rect.w,
          captionRect.x + captionRect.w,
        ) - Math.max(block.rect.x, captionRect.x));
        const horizontalRatio = horizontalOverlap / Math.max(1, Math.min(block.rect.w, captionRect.w));
        const dx = Math.abs(block.rect.x + block.rect.w / 2 - captionCenterX);
        const dy = Math.abs(block.rect.y + block.rect.h / 2 - captionCenterY);
        return { block, horizontalRatio, distance: Math.hypot(dx, dy), dy };
      })
      .filter((candidate) => (
        candidate.horizontalRatio >= 0.25
        && candidate.dy <= Math.max(48, captionRect.h * 4, candidate.block.rect.h * 4)
      ))
      .sort((left, right) => left.distance - right.distance)[0]?.block;
    if (nearby) return nearby;
  }

  if (assetType !== 'figure' && assetType !== 'table') return undefined;
  return candidates
    .map((block) => {
      const horizontalOverlap = Math.max(0, Math.min(
        block.rect.x + block.rect.w,
        assetRect.x + assetRect.w,
      ) - Math.max(block.rect.x, assetRect.x));
      const horizontalRatio = horizontalOverlap / Math.max(1, Math.min(block.rect.w, assetRect.w));
      const gap = assetType === 'figure'
        ? block.rect.y - (assetRect.y + assetRect.h)
        : assetRect.y - (block.rect.y + block.rect.h);
      return { block, horizontalRatio, gap };
    })
    .filter((candidate) => candidate.horizontalRatio >= 0.2 && candidate.gap >= -20 && candidate.gap <= 80)
    .sort((left, right) => Math.abs(left.gap) - Math.abs(right.gap))[0]?.block;
}

function withoutCaption(rect: Rect, captionRect: Rect | undefined, type: VisionRegion['type']): Rect {
  if (!captionRect || intersectionArea(rect, captionRect) <= 0) return rect;
  const bottom = rect.y + rect.h;
  const captionCenter = captionRect.y + captionRect.h / 2;
  const assetCenter = rect.y + rect.h / 2;
  if (type === 'figure' && captionCenter >= assetCenter) {
    const trimmedBottom = Math.max(rect.y, captionRect.y - 2);
    return { ...rect, h: trimmedBottom - rect.y };
  }
  if (type === 'table' && captionCenter <= assetCenter) {
    const trimmedTop = Math.min(bottom, captionRect.y + captionRect.h + 2);
    return { ...rect, y: trimmedTop, h: bottom - trimmedTop };
  }
  return rect;
}

const ASSET_KIND = {
  figure: 'figure', table: 'table', display_formula: 'formula', code: 'code',
} as const;

export function reconcileVisionLayout(
  doc: Doc,
  analyses: readonly VisionPageAnalysis[],
  minimumConfidence = 0.8,
): VisionReconciliationResult {
  const byPage = new Map<number, VisionPageAnalysis>();
  for (const analysis of analyses) {
    if (byPage.has(analysis.pageIndex)) throw new Error(`Vision 版式分析包含重复的第 ${analysis.pageIndex + 1} 页`);
    byPage.set(analysis.pageIndex, analysis);
  }
  for (const page of doc.pages) {
    if (!byPage.has(page.pageIndex)) throw new Error(`Vision 版式分析缺少第 ${page.pageIndex + 1} 页`);
  }

  const assetRegions: DetectedAssetRegion[] = [];
  const unresolved: UnresolvedVisionRegion[] = [];
  for (const page of doc.pages) {
    const analysis = byPage.get(page.pageIndex)!;
    analysis.regions.forEach((vision, regionIndex) => {
      if (!(vision.type in ASSET_KIND)) return;
      if (vision.confidence < minimumConfidence) {
        unresolved.push({ pageIndex: page.pageIndex, regionIndex, type: vision.type, reason: 'low-confidence' });
        return;
      }
      let rect = sourceRect(vision.bbox, page);
      const captionRect = vision.captionBBox ? sourceRect(vision.captionBBox, page) : undefined;
      const caption = captionFor(doc, page.pageIndex, captionRect, vision.type, rect);
      if (captionRect && !caption) {
        unresolved.push({ pageIndex: page.pageIndex, regionIndex, type: vision.type, reason: 'caption-unmatched' });
        return;
      }
      rect = withoutCaption(rect, caption?.rect, vision.type);
      const asset: DetectedAssetRegion = {
        id: `vision-p${page.pageIndex + 1}-${vision.type.replace('display_', '')}-${regionIndex + 1}`,
        kind: ASSET_KIND[vision.type as keyof typeof ASSET_KIND],
        pageIndex: page.pageIndex,
        rect,
        widthMode: vision.column === 'full' ? 'span' : 'column',
        captionUnitId: caption?.id,
      };
      const intersecting = doc.blocks.filter((block) => (
        block.pageIndex === page.pageIndex && intersectionArea(block.rect, rect) > 0
      ));
      const geometry = validateImmutableRegion(asset, page, intersecting, caption?.rect);
      if (!geometry.pass) {
        unresolved.push({ pageIndex: page.pageIndex, regionIndex, type: vision.type, reason: geometry.issues[0]! });
        return;
      }
      assetRegions.push(asset);
    });
  }
  return { assetRegions, unresolved };
}
