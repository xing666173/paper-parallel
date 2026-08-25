import type { Doc, Rect } from '../../types/models';
import type { DetectedAssetRegion } from '../assets/extract';
import { validateImmutableRegion, type ImmutableGeometryIssue } from '../assets/geometryGate';
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

function captionFor(doc: Doc, pageIndex: number, captionRect: Rect | undefined): Doc['blocks'][number] | undefined {
  if (!captionRect) return undefined;
  return doc.blocks
    .filter((block) => block.pageIndex === pageIndex && block.type === 'caption')
    .map((block) => ({ block, overlap: intersectionArea(block.rect, captionRect) }))
    .filter((candidate) => candidate.overlap / Math.max(1, candidate.block.rect.w * candidate.block.rect.h) >= 0.2)
    .sort((left, right) => right.overlap - left.overlap)[0]?.block;
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
      const rect = sourceRect(vision.bbox, page);
      const captionRect = vision.captionBBox ? sourceRect(vision.captionBBox, page) : undefined;
      const caption = captionFor(doc, page.pageIndex, captionRect);
      if (captionRect && !caption) {
        unresolved.push({ pageIndex: page.pageIndex, regionIndex, type: vision.type, reason: 'caption-unmatched' });
        return;
      }
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
