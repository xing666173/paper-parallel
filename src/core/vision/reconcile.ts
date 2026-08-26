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
        && candidate.dy <= Math.max(144, captionRect.h * 4, candidate.block.rect.h * 4)
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

function withoutCaption(
  rect: Rect,
  captionRects: readonly (Rect | undefined)[],
  type: VisionRegion['type'],
): Rect {
  const applicable = captionRects.filter((candidate): candidate is Rect => Boolean(
    candidate && intersectionArea(rect, candidate) > 0,
  ));
  if (!applicable.length) return rect;
  const bottom = rect.y + rect.h;
  const assetCenter = rect.y + rect.h / 2;
  const below = applicable.filter((candidate) => candidate.y + candidate.h / 2 >= assetCenter);
  if (type === 'figure' && below.length) {
    const trimmedBottom = Math.max(rect.y, Math.min(...below.map((candidate) => candidate.y)) - 2);
    return { ...rect, h: trimmedBottom - rect.y };
  }
  const above = applicable.filter((candidate) => candidate.y + candidate.h / 2 <= assetCenter);
  if (type === 'table' && above.length) {
    const trimmedTop = Math.min(bottom, Math.max(...above.map((candidate) => candidate.y + candidate.h)) + 2);
    return { ...rect, y: trimmedTop, h: bottom - trimmedTop };
  }
  return rect;
}

function withAdjacentCaptionClearance(rect: Rect, caption: Rect | undefined, type: VisionRegion['type']): Rect {
  if (!caption) return rect;
  const bottom = rect.y + rect.h;
  if (type === 'table') {
    const captionBottom = caption.y + caption.h;
    const top = captionBottom + 4;
    if (rect.y >= captionBottom - 1 && rect.y < top && top < bottom - 12) {
      return { ...rect, y: top, h: bottom - top };
    }
  }
  if (type === 'figure') {
    const trimmedBottom = caption.y - 4;
    if (bottom <= caption.y + 1 && bottom > trimmedBottom && trimmedBottom > rect.y + 12) {
      return { ...rect, h: trimmedBottom - rect.y };
    }
  }
  return rect;
}

interface CharacterLine {
  y: number;
  bottom: number;
  text: string;
}

function characterLines(doc: Doc, pageIndex: number, rect: Rect): CharacterLine[] {
  const characters = doc.blocks
    .flatMap((block) => block.characterRects ?? [])
    .filter((character) => (
      character.pageIndex === pageIndex
      && intersectionArea(character.rect, rect) > 0
    ))
    .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
  const lines: Array<{ characters: typeof characters }> = [];
  for (const character of characters) {
    const line = lines.find((candidate) => (
      Math.abs(candidate.characters[0]!.rect.y - character.rect.y) <= 2
    ));
    if (line) line.characters.push(character);
    else lines.push({ characters: [character] });
  }
  return lines.map((line) => {
    line.characters.sort((left, right) => left.rect.x - right.rect.x);
    return {
      y: Math.min(...line.characters.map((character) => character.rect.y)),
      bottom: Math.max(...line.characters.map((character) => character.rect.y + character.rect.h)),
      text: line.characters.map((character) => character.ch).join(''),
    };
  }).sort((left, right) => left.y - right.y);
}

function withoutTopMarginFurniture(doc: Doc, pageIndex: number, rect: Rect, type: VisionRegion['type']): Rect {
  if ((type !== 'figure' && type !== 'table') || rect.y > doc.pages[pageIndex]!.height * 0.12) return rect;
  const page = doc.pages[pageIndex]!;
  const furniture = characterLines(doc, pageIndex, rect).filter((line) => {
    const naturalWords = line.text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    return line.y < page.height * 0.1
      && line.y < rect.y + 40
      && naturalWords >= 4
      && line.text.trim().length >= 24;
  });
  if (!furniture.length) return rect;
  const bottom = rect.y + rect.h;
  const top = Math.max(...furniture.map((line) => line.bottom)) + 4;
  return top < bottom - 12 ? { ...rect, y: top, h: bottom - top } : rect;
}

function withoutTrailingProse(doc: Doc, pageIndex: number, rect: Rect, type: VisionRegion['type']): Rect {
  if (type !== 'table') return rect;
  const lines = characterLines(doc, pageIndex, rect);
  if (lines.length < 4) return rect;
  for (let index = 3; index < lines.length; index += 1) {
    const previous = lines[index - 1]!;
    const current = lines[index]!;
    const whitespace = current.y - previous.bottom;
    const proseWords = current.text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    const proseLike = proseWords >= 4
      || (proseWords >= 3 && /[.!?]\s*$/.test(current.text));
    if (whitespace < 4 || !proseLike) continue;
    const bottom = Math.min(rect.y + rect.h, previous.bottom + 2);
    if (bottom > rect.y + 12) return { ...rect, h: bottom - rect.y };
  }
  return rect;
}

function withPrecedingTextClearance(
  doc: Doc,
  pageIndex: number,
  rect: Rect,
  type: VisionRegion['type'],
): Rect {
  if (type !== 'figure') return rect;
  const bottom = rect.y + rect.h;
  const touching = doc.blocks
    .filter((block) => {
      if (block.pageIndex !== pageIndex || block.type === 'caption' || looksLikeVisualText(block)) return false;
      const blockBottom = block.rect.y + block.rect.h;
      const horizontalOverlap = Math.max(0, Math.min(
        block.rect.x + block.rect.w,
        rect.x + rect.w,
      ) - Math.max(block.rect.x, rect.x));
      return horizontalOverlap > 0 && blockBottom >= rect.y - 4 && blockBottom <= rect.y + 2;
    })
    .sort((left, right) => right.rect.y + right.rect.h - (left.rect.y + left.rect.h))[0];
  if (!touching) return rect;
  const top = touching.rect.y + touching.rect.h + 6;
  return top < bottom - 12 ? { ...rect, y: top, h: bottom - top } : rect;
}

function looksLikeVisualText(block: Doc['blocks'][number]): boolean {
  const text = block.text?.trim() ?? '';
  if (!text) return true;
  const shortLines = text.split(/\r?\n/).filter(Boolean).filter((line) => line.trim().length <= 32).length;
  return shortLines >= 4 || block.type === 'figure' || block.type === 'table' || block.type === 'equation';
}

function regionArea(region: DetectedAssetRegion): number {
  return region.rect.w * region.rect.h;
}

function preferredRegion(left: DetectedAssetRegion, right: DetectedAssetRegion): DetectedAssetRegion {
  if (Boolean(left.captionUnitId) !== Boolean(right.captionUnitId)) return left.captionUnitId ? left : right;
  return regionArea(left) >= regionArea(right) ? left : right;
}

function deduplicateRegions(regions: readonly DetectedAssetRegion[]): DetectedAssetRegion[] {
  const kept: DetectedAssetRegion[] = [];
  for (const region of regions) {
    const duplicateIndex = kept.findIndex((candidate) => {
      if (candidate.pageIndex !== region.pageIndex || candidate.kind !== region.kind) return false;
      const overlap = intersectionArea(candidate.rect, region.rect);
      const containment = overlap / Math.max(1, Math.min(regionArea(candidate), regionArea(region)));
      return containment >= 0.8 || (
        Boolean(candidate.captionUnitId)
        && candidate.captionUnitId === region.captionUnitId
        && overlap / Math.max(1, Math.max(regionArea(candidate), regionArea(region))) >= 0.45
      );
    });
    if (duplicateIndex < 0) kept.push(region);
    else kept[duplicateIndex] = preferredRegion(kept[duplicateIndex]!, region);
  }
  return kept;
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
      rect = withoutCaption(rect, [caption?.rect, captionRect], vision.type);
      rect = withAdjacentCaptionClearance(rect, caption?.rect, vision.type);
      rect = withoutTopMarginFurniture(doc, page.pageIndex, rect, vision.type);
      rect = withoutTrailingProse(doc, page.pageIndex, rect, vision.type);
      rect = withPrecedingTextClearance(doc, page.pageIndex, rect, vision.type);
      const asset: DetectedAssetRegion = {
        id: `vision-p${page.pageIndex + 1}-${vision.type.replace('display_', '')}-${regionIndex + 1}`,
        kind: ASSET_KIND[vision.type as keyof typeof ASSET_KIND],
        pageIndex: page.pageIndex,
        rect,
        // Some multimodal responses call a centered panel "full" even when
        // it occupies only one source column. Physical width is the reliable
        // signal for whether it must span the target columns.
        widthMode: rect.w >= page.width * 0.55 ? 'span' : 'column',
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
  return { assetRegions: deduplicateRegions(assetRegions), unresolved };
}
