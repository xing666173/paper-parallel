import type { Block, Rect } from '../../types/models';
import type { DetectedAssetRegion } from './extract';

export type ImmutableGeometryIssue =
  | 'page-edge-touch'
  | 'page-coverage-excessive'
  | 'caption-overlap'
  | 'body-prose-density';

export interface ImmutableGeometryResult {
  pass: boolean;
  issues: ImmutableGeometryIssue[];
}

function intersectionArea(left: Rect, right: Rect): number {
  const width = Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y));
  return width * height;
}

export function validateImmutableRegion(
  region: DetectedAssetRegion,
  page: { width: number; height: number },
  intersectingBlocks: readonly Block[],
  captionRect?: Rect,
): ImmutableGeometryResult {
  const issues: ImmutableGeometryIssue[] = [];
  const { rect } = region;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  if (rect.x < 0 || rect.y <= 0 || right > page.width || bottom > page.height) {
    issues.push('page-edge-touch');
  }

  const pageArea = page.width * page.height;
  if (rect.w <= 0 || rect.h <= 0 || rect.w * rect.h / pageArea > 0.5 || rect.h / page.height > 0.78) {
    issues.push('page-coverage-excessive');
  }

  if (captionRect && intersectionArea(rect, captionRect) > 0) issues.push('caption-overlap');

  if (region.kind !== 'table') {
    const longProse = intersectingBlocks.filter((block) => (
      block.type === 'paragraph'
      && (block.text?.replace(/\s+/g, ' ').trim().length ?? 0) >= 45
      && intersectionArea(rect, block.rect) > 0
    ));
    const proseArea = longProse.reduce((total, block) => total + intersectionArea(rect, block.rect), 0);
    if (longProse.length >= 3 && proseArea / Math.max(1, rect.w * rect.h) >= 0.25) {
      issues.push('body-prose-density');
    }
  }

  return { pass: issues.length === 0, issues };
}
