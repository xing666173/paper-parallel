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

function looksLikeVisualLabels(text: string | undefined): boolean {
  const lines = (text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const labelLike = lines.filter((line) => (
    line.length <= 32 || /^[-+]?\d[\d.,%‰+\- ]*$/.test(line)
  )).length;
  return labelLike / lines.length >= 0.6;
}

function proseCharacterCount(block: Block, rect: Rect): number | undefined {
  if (!block.characterRects?.length) return undefined;
  const intersecting = block.characterRects.filter((character) => (
    /[A-Za-z\u3400-\u9fff]/.test(character.ch)
    && intersectionArea(rect, character.rect) > 0
  ));
  if (!intersecting.length) return 0;
  const indexes = intersecting.map((character) => character.sourceIndex);
  const snippet = (block.text ?? '').slice(Math.min(...indexes), Math.max(...indexes) + 1);
  // PDF.js may merge the prose above a diagram with labels inside the diagram.
  // Judge only the characters that actually intersect the crop so a label-only
  // tail does not inherit the prose classification of the aggregate block.
  if (looksLikeVisualLabels(snippet)) return 0;
  const chineseCount = snippet.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const englishWords = snippet.match(/[A-Za-z]{2,}/g) ?? [];
  const functionWords = snippet.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/g) ?? [];
  const sentenceLike = chineseCount >= 12 || (englishWords.length >= 6 && functionWords.length >= 2);
  return sentenceLike ? intersecting.length : 0;
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

  // Tables and algorithm/code environments legitimately contain dense natural-language
  // labels and comments. Their page-bounds and coverage checks still protect against an
  // accidentally oversized crop; prose-density is only meaningful for figures/formulas.
  if (region.kind !== 'table' && region.kind !== 'code') {
    const longProse = intersectingBlocks.map((block) => ({
      block,
      characterCount: proseCharacterCount(block, rect),
    })).filter(({ block, characterCount }) => (
      block.type === 'paragraph'
      && (block.text?.replace(/\s+/g, ' ').trim().length ?? 0) >= 45
      && !looksLikeVisualLabels(block.text)
      && ((block.text?.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 8
        || (block.text?.match(/[\u3400-\u9fff]/g)?.length ?? 0) >= 24)
      && (characterCount === undefined
        ? intersectionArea(rect, block.rect) > 0
        : characterCount > 0)
    ));
    const proseArea = longProse.reduce((total, { block, characterCount }) => (
      total + (characterCount === undefined ? intersectionArea(rect, block.rect) : 0)
    ), 0);
    const characterIntrusion = longProse.reduce((total, candidate) => (
      total + (candidate.characterCount ?? 0)
    ), 0);
    const proseRatio = proseArea / Math.max(1, rect.w * rect.h);
    if (characterIntrusion >= 24
      || (longProse.length >= 3 && proseRatio >= 0.25)
      || proseRatio >= 0.16) {
      issues.push('body-prose-density');
    }
  }

  return { pass: issues.length === 0, issues };
}
