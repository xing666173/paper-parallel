import type { Doc, Rect } from '../../types/models';
import type { DetectedAssetRegion } from '../assets/extract';
import { validateImmutableRegion, type ImmutableGeometryIssue } from '../assets/geometryGate';
import { isFigureCaptionText, isTableCaptionText } from '../parser/blocks';
import type { VisionPageAnalysis, VisionRegion, NormalizedVisionBox } from './protocol';

export type VisionReconciliationReason =
  | 'low-confidence'
  | 'caption-unmatched'
  | 'implausible-formula-cluster'
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

function withoutFollowingTableCaption(
  doc: Doc,
  pageIndex: number,
  rect: Rect,
  ownCaptionId: string | undefined,
  type: VisionRegion['type'],
): Rect {
  if (type !== 'table') return rect;
  const bottom = rect.y + rect.h;
  const nextCaption = doc.blocks
    .filter((block) => {
      if (block.id === ownCaptionId || block.pageIndex !== pageIndex || block.type !== 'caption') return false;
      const horizontalOverlap = Math.max(0, Math.min(
        block.rect.x + block.rect.w,
        rect.x + rect.w,
      ) - Math.max(block.rect.x, rect.x));
      return horizontalOverlap > 0
        && block.rect.y > rect.y + 12
        && block.rect.y < bottom;
    })
    .sort((left, right) => left.rect.y - right.rect.y)[0];
  if (!nextCaption) return rect;
  const trimmedBottom = nextCaption.rect.y - 3;
  return trimmedBottom > rect.y + 12 ? { ...rect, h: trimmedBottom - rect.y } : rect;
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
  if (type !== 'table' && type !== 'code') return rect;
  const lines = characterLines(doc, pageIndex, rect);
  if (lines.length < 4) return rect;
  for (let index = 3; index < lines.length; index += 1) {
    const previous = lines[index - 1]!;
    const current = lines[index]!;
    const whitespace = current.y - previous.bottom;
    const proseWords = current.text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    const proseLike = type === 'table'
      ? proseWords >= 7 || (proseWords >= 3 && /[.!?]\s*$/.test(current.text))
      : proseWords >= 4 || (proseWords >= 3 && /[.!?]\s*$/.test(current.text));
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

function withoutNestedFormulaRegions(regions: readonly DetectedAssetRegion[]): DetectedAssetRegion[] {
  return regions.filter((region) => {
    if (region.kind !== 'formula') return true;
    const formulaArea = Math.max(1, regionArea(region));
    return !regions.some((container) => (
      container !== region
      && container.pageIndex === region.pageIndex
      && (container.kind === 'figure' || container.kind === 'table' || container.kind === 'code')
      && intersectionArea(region.rect, container.rect) / formulaArea >= 0.75
    ));
  });
}

const ASSET_KIND = {
  figure: 'figure', table: 'table', display_formula: 'formula', code: 'code',
} as const;

function implausibleFormulaClusterIndices(analysis: VisionPageAnalysis): Set<number> {
  const candidates = analysis.regions
    .map((region, index) => ({ region, index }))
    .filter(({ region }) => (
      region.type === 'display_formula'
      && region.bbox[2] >= 650
      && region.bbox[3] <= 24
    ))
    .sort((left, right) => left.region.bbox[1] - right.region.bbox[1]);
  const rejected = new Set<number>(candidates.map(({ index }) => index));
  let cluster: typeof candidates = [];
  const flush = () => {
    if (cluster.length >= 6) cluster.forEach(({ index }) => rejected.add(index));
    cluster = [];
  };
  for (const candidate of candidates) {
    const previous = cluster.at(-1);
    if (!previous) {
      cluster.push(candidate);
      continue;
    }
    const [x, y, width, height] = candidate.region.bbox;
    const [previousX, previousY, previousWidth, previousHeight] = previous.region.bbox;
    const sameThinRowShape = Math.abs(x - previousX) <= 20
      && Math.abs(width - previousWidth) <= 30
      && Math.abs(height - previousHeight) <= 8;
    const verticalStep = y - previousY;
    if (sameThinRowShape && verticalStep > 0 && verticalStep <= Math.max(34, height * 2.2)) {
      cluster.push(candidate);
    } else {
      flush();
      cluster.push(candidate);
    }
  }
  flush();
  return rejected;
}

function withAssetPadding(
  rect: Rect,
  type: VisionRegion['type'],
  page: { width: number; height: number },
): Rect {
  if (type !== 'table' && type !== 'display_formula') return rect;
  const horizontal = type === 'table' ? 4 : 5;
  const topPadding = type === 'table' ? 12 : 4;
  const bottomPadding = type === 'table'
    ? 6
    : Math.min(16, Math.max(6, rect.h * 0.18));
  const left = Math.max(0, rect.x - horizontal);
  const top = Math.max(0, rect.y - topPadding);
  const right = Math.min(page.width, rect.x + rect.w + horizontal);
  const bottom = Math.min(page.height, rect.y + rect.h + bottomPadding);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function withSingleColumnFormulaWidth(
  doc: Doc,
  pageIndex: number,
  rect: Rect,
  analysis: VisionPageAnalysis,
  vision: VisionRegion,
): Rect {
  if (vision.type !== 'display_formula' || vision.column !== 'full' || analysis.layout !== 'single') {
    return rect;
  }
  const centerY = rect.y + rect.h / 2;
  const region = doc.layoutRegions
    .filter((candidate) => (
      candidate.sourcePage === pageIndex
      && candidate.mode === 'full-width'
      && centerY >= candidate.bounds.y - 24
      && centerY <= candidate.bounds.y + candidate.bounds.h + 24
    ))
    .sort((left, right) => left.bounds.w - right.bounds.w)[0];
  if (!region) return rect;
  const left = Math.min(rect.x, region.bounds.x);
  const right = Math.max(rect.x + rect.w, region.bounds.x + region.bounds.w);
  return { ...rect, x: left, w: right - left };
}

function formulaProseLike(block: Doc['blocks'][number]): boolean {
  if (block.type !== 'paragraph') return false;
  const text = block.text?.replace(/\s+/g, ' ').trim() ?? '';
  const words = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  return text.length >= 45 && words >= 6;
}

function withoutAdjacentFormulaProse(
  doc: Doc,
  pageIndex: number,
  padded: Rect,
  unpadded: Rect,
  type: VisionRegion['type'],
): Rect {
  if (type !== 'display_formula') return padded;
  let top = padded.y;
  let bottom = padded.y + padded.h;
  const horizontalOverlap = (rect: Rect) => Math.max(0, Math.min(
    rect.x + rect.w,
    padded.x + padded.w,
  ) - Math.max(rect.x, padded.x));
  const prose = doc.blocks.filter((block) => (
    block.pageIndex === pageIndex
    && formulaProseLike(block)
    && horizontalOverlap(block.rect) > 0
  ));
  const previousBottom = Math.max(-Infinity, ...prose
    .map((block) => block.rect.y + block.rect.h)
    .filter((candidate) => candidate <= unpadded.y + 1));
  if (Number.isFinite(previousBottom)) top = Math.max(top, previousBottom + 2);
  const nextTop = Math.min(Infinity, ...prose
    .map((block) => block.rect.y)
    .filter((candidate) => candidate >= unpadded.y + unpadded.h - 1));
  if (Number.isFinite(nextTop)) bottom = Math.min(bottom, nextTop - 2);
  return bottom > top + 8 ? { ...padded, y: top, h: bottom - top } : padded;
}

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
    const implausibleFormulaIndices = implausibleFormulaClusterIndices(analysis);
    analysis.regions.forEach((vision, regionIndex) => {
      if (!(vision.type in ASSET_KIND)) return;
      if (implausibleFormulaIndices.has(regionIndex)) {
        unresolved.push({
          pageIndex: page.pageIndex,
          regionIndex,
          type: vision.type,
          reason: 'implausible-formula-cluster',
        });
        return;
      }
      if (vision.confidence < minimumConfidence) {
        unresolved.push({ pageIndex: page.pageIndex, regionIndex, type: vision.type, reason: 'low-confidence' });
        return;
      }
      const sourceVisionRect = sourceRect(vision.bbox, page);
      let rect = withAssetPadding(sourceVisionRect, vision.type, page);
      rect = withSingleColumnFormulaWidth(doc, page.pageIndex, rect, analysis, vision);
      rect = withoutAdjacentFormulaProse(doc, page.pageIndex, rect, sourceVisionRect, vision.type);
      const captionRect = vision.captionBBox ? sourceRect(vision.captionBBox, page) : undefined;
      const caption = captionFor(doc, page.pageIndex, captionRect, vision.type, rect);
      if (captionRect && !caption) {
        unresolved.push({ pageIndex: page.pageIndex, regionIndex, type: vision.type, reason: 'caption-unmatched' });
        return;
      }
      const captionBoundaries = vision.type === 'table' && caption
        ? [caption.rect]
        : [caption?.rect, captionRect];
      rect = withoutCaption(rect, captionBoundaries, vision.type);
      rect = withAdjacentCaptionClearance(rect, caption?.rect, vision.type);
      rect = withoutFollowingTableCaption(doc, page.pageIndex, rect, caption?.id, vision.type);
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
  return {
    assetRegions: withoutNestedFormulaRegions(deduplicateRegions(assetRegions)),
    unresolved,
  };
}
