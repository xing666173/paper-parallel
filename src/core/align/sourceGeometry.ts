import type { ImmutableAsset } from '../assets/types';
import type { CharRect } from '../parser/charRects';
import type {
  AlignmentRectSet,
  AlignmentUnit,
  Block,
  Doc,
  Rect,
} from '../../types/models';

export interface TextRangeRectInput {
  page?: number;
  start: number;
  end: number;
  charRects: CharRect[];
}

function asRect(char: CharRect): Rect {
  return { x: char.x, y: char.y, w: char.w, h: char.h };
}

function mergeLineRects(chars: CharRect[]): Rect[] {
  const lines: Array<{ rect: Rect; widths: number[] }> = [];
  for (const char of chars) {
    const rect = asRect(char);
    const current = lines[lines.length - 1];
    if (!current) {
      lines.push({ rect, widths: [rect.w] });
      continue;
    }
    const currentCenter = current.rect.y + current.rect.h / 2;
    const nextCenter = rect.y + rect.h / 2;
    const verticalTolerance = Math.max(current.rect.h, rect.h) * 0.35;
    const averageWidth = [...current.widths, rect.w]
      .reduce((sum, width) => sum + width, 0) / (current.widths.length + 1);
    const currentRight = current.rect.x + current.rect.w;
    const horizontalGap = rect.x - currentRight;
    const followsLine = rect.x >= current.rect.x - averageWidth
      && horizontalGap <= averageWidth * 2;

    if (Math.abs(currentCenter - nextCenter) <= verticalTolerance && followsLine) {
      const x1 = Math.min(current.rect.x, rect.x);
      const y1 = Math.min(current.rect.y, rect.y);
      const x2 = Math.max(currentRight, rect.x + rect.w);
      const y2 = Math.max(current.rect.y + current.rect.h, rect.y + rect.h);
      current.rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      current.widths.push(rect.w);
    } else {
      lines.push({ rect, widths: [rect.w] });
    }
  }
  return lines.map((line) => line.rect);
}

export function resolveTextRangeRects(input: TextRangeRectInput): AlignmentRectSet[] {
  const byPage = new Map<number, CharRect[]>();
  input.charRects.forEach((char, arrayIndex) => {
    const sourceIndex = char.sourceIndex ?? arrayIndex;
    if (sourceIndex < input.start || sourceIndex >= input.end) return;
    const page = char.pageIndex ?? input.page ?? 0;
    const entries = byPage.get(page) ?? [];
    entries.push(char);
    byPage.set(page, entries);
  });
  return [...byPage.entries()]
    .sort(([left], [right]) => left - right)
    .map(([page, chars]) => ({ page, rects: mergeLineRects(chars) }));
}

function geometryForBlock(block: Block): AlignmentRectSet[] {
  if (block.fragments?.length) {
    return block.fragments.map((fragment) => ({ page: fragment.pageIndex, rects: [{ ...fragment.rect }] }));
  }
  return [{ page: block.pageIndex, rects: [{ ...block.rect }] }];
}

function indexedChars(block: Block): CharRect[] {
  if (block.characterRects?.length) {
    return block.characterRects.map((char) => ({
      ch: char.ch,
      sourceIndex: char.sourceIndex,
      pageIndex: char.pageIndex,
      ...char.rect,
    }));
  }
  return (block.charRects ?? []).map((rect, sourceIndex) => ({
    ch: block.text?.[sourceIndex] ?? '',
    sourceIndex,
    pageIndex: block.pageIndex,
    ...rect,
  }));
}

function normalizeWithSourceIndices(text: string): { normalized: string; sourceIndices: number[] } {
  let normalized = '';
  const sourceIndices: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const expanded = text[index].normalize('NFKC');
    for (const char of expanded) {
      if (/\s/u.test(char)) continue;
      normalized += char;
      sourceIndices.push(index);
    }
  }
  return { normalized, sourceIndices };
}

function findExactTextRange(text: string, needle: string, from: number): [number, number] | null {
  const exactStart = text.indexOf(needle, from);
  if (exactStart >= 0) return [exactStart, exactStart + needle.length];

  const source = normalizeWithSourceIndices(text);
  const target = normalizeWithSourceIndices(needle).normalized;
  const normalizedFrom = source.sourceIndices.findIndex((index) => index >= from);
  const matchAt = source.normalized.indexOf(target, Math.max(0, normalizedFrom));
  if (matchAt < 0 || target.length === 0) return null;
  const start = source.sourceIndices[matchAt];
  const finalIndex = source.sourceIndices[matchAt + target.length - 1];
  return [start, finalIndex + 1];
}

function normalizedLength(text: string): number {
  return normalizeWithSourceIndices(text).normalized.length;
}

function findSplitTextRanges(
  designatedBlock: Block,
  candidates: Block[],
  needle: string,
  from: number,
): Array<{ block: Block; range: [number, number] }> | null {
  const normalizedNeedle = normalizeWithSourceIndices(needle).normalized;
  const minimumPartLength = 16;
  if (normalizedNeedle.length < minimumPartLength * 2) return null;
  for (
    let split = normalizedNeedle.length - minimumPartLength;
    split >= minimumPartLength;
    split -= 1
  ) {
    const prefixRange = findExactTextRange(
      designatedBlock.text ?? '',
      normalizedNeedle.slice(0, split),
      from,
    );
    if (!prefixRange) continue;
    const suffix = normalizedNeedle.slice(split);
    const suffixMatch = candidates
      .filter((candidate) => candidate.id !== designatedBlock.id && indexedChars(candidate).length > 0)
      .map((candidate) => ({
        block: candidate,
        range: findExactTextRange(candidate.text ?? '', suffix, 0),
      }))
      .filter((candidate): candidate is { block: Block; range: [number, number] } => Boolean(candidate.range))
      .sort((left, right) => (
        Math.abs(left.block.pageIndex - designatedBlock.pageIndex)
        - Math.abs(right.block.pageIndex - designatedBlock.pageIndex)
      ))[0];
    if (suffixMatch) {
      return [
        { block: designatedBlock, range: prefixRange },
        suffixMatch,
      ];
    }
  }
  return null;
}

interface WordToken {
  value: string;
  start: number;
  end: number;
}

function wordTokens(text: string): WordToken[] {
  return [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => ({
    value: match[0].normalize('NFKC').toLocaleLowerCase(),
    start: match.index!,
    end: match.index! + match[0].length,
  }));
}

/**
 * Semi-global token alignment: match the complete sentence against the best
 * substring of one source block while tolerating a small number of inserted
 * diagram labels or missing function words. The threshold is deliberately
 * strict so an unrelated repeated sentence cannot acquire plausible geometry.
 */
function findApproximateTokenRange(text: string, needle: string, from: number): {
  range: [number, number];
  confidence: number;
} | null {
  const target = wordTokens(needle);
  const source = wordTokens(text).filter((token) => token.end > from);
  if (target.length < 4 || source.length < target.length * 0.5) return null;

  let previousCosts = Array.from({ length: source.length + 1 }, () => 0);
  let previousStarts = Array.from({ length: source.length + 1 }, (_, index) => index);
  for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
    const costs = Array.from({ length: source.length + 1 }, () => 0);
    const starts = Array.from({ length: source.length + 1 }, () => 0);
    costs[0] = targetIndex;
    for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
      const substitutionCost = previousCosts[sourceIndex - 1]!
        + (target[targetIndex - 1]!.value === source[sourceIndex - 1]!.value ? 0 : 1);
      const missingSourceCost = previousCosts[sourceIndex]! + 1;
      const insertedSourceCost = costs[sourceIndex - 1]! + 1;
      const best = Math.min(substitutionCost, missingSourceCost, insertedSourceCost);
      costs[sourceIndex] = best;
      starts[sourceIndex] = best === substitutionCost
        ? previousStarts[sourceIndex - 1]!
        : best === missingSourceCost
          ? previousStarts[sourceIndex]!
          : starts[sourceIndex - 1]!;
    }
    previousCosts = costs;
    previousStarts = starts;
  }

  let endIndex = 1;
  for (let index = 2; index <= source.length; index += 1) {
    if (previousCosts[index]! < previousCosts[endIndex]!) endIndex = index;
  }
  const edits = previousCosts[endIndex]!;
  const startIndex = previousStarts[endIndex]!;
  const confidence = 1 - edits / target.length;
  if (startIndex >= endIndex || confidence < 0.82) return null;
  return {
    range: [source[startIndex]!.start, source[endIndex - 1]!.end],
    confidence: Math.min(0.95, confidence),
  };
}

function withSource(
  unit: AlignmentUnit,
  source: AlignmentRectSet[],
  confidence = 1,
  fallbackReason?: string,
): AlignmentUnit {
  if (!source.length) {
    return {
      ...unit, source: [], confidence: 0, status: 'unmatched',
      fallbackReason: fallbackReason ?? 'source-geometry-missing',
    };
  }
  return {
    ...unit,
    source,
    confidence,
    status: confidence >= 0.9 ? 'aligned' : 'low-confidence',
    fallbackReason: fallbackReason ?? unit.fallbackReason,
  };
}

export function resolveSourceGeometry(
  units: AlignmentUnit[],
  doc: Doc,
  assets: ImmutableAsset[],
): AlignmentUnit[] {
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const cursorByBlock = new Map<string, number>();

  return units.map((unit) => {
    if (unit.kind === 'asset') {
      const asset = assetsById.get(unit.id)
        ?? assets.find((candidate) => unit.sourceUnitIds.includes(candidate.id));
      return asset
        ? withSource(unit, [{ page: asset.sourcePage, rects: [{ ...asset.sourceRect }] }])
        : withSource(unit, []);
    }

    let block = blocks.get(unit.sourceBlockId ?? '')
      ?? blocks.get(unit.parentId ?? '')
      ?? unit.sourceUnitIds.map((id) => blocks.get(id)).find(Boolean)
      ?? blocks.get(unit.id);
    if (!block) return withSource(unit, []);

    const requiresTextRange = unit.kind === 'semantic-group'
      || unit.relation === 'paragraph-fallback';
    if (!requiresTextRange || !unit.sourceText) {
      return withSource(unit, geometryForBlock(block));
    }

    const designatedBlock = block;
    let range = findExactTextRange(
      block.text ?? '',
      unit.sourceText,
      cursorByBlock.get(block.id) ?? 0,
    );
    let sourceConfidence = 1;
    let fallbackReason: string | undefined;

    // PDF.js can splice a visually ordinary sentence into a separate margin
    // metadata block. Preparation restores its reading order, but its glyph
    // coordinates remain in that original block. Search for an exact copy
    // across blocks before attempting any fuzzy match.
    if (!range && normalizedLength(unit.sourceText) >= 20) {
      const relocated = doc.blocks
        .filter((candidate) => candidate.id !== designatedBlock.id && indexedChars(candidate).length > 0)
        .map((candidate) => ({
          block: candidate,
          range: findExactTextRange(candidate.text ?? '', unit.sourceText!, cursorByBlock.get(candidate.id) ?? 0),
        }))
        .filter((candidate): candidate is { block: Block; range: [number, number] } => Boolean(candidate.range))
        .sort((left, right) => (
          Math.abs(left.block.pageIndex - designatedBlock.pageIndex)
          - Math.abs(right.block.pageIndex - designatedBlock.pageIndex)
        ))[0];
      if (relocated) {
        block = relocated.block;
        range = relocated.range;
        sourceConfidence = 0.95;
        fallbackReason = 'source-sentence-relocated-to-origin-block';
      }
    }

    if (!range) {
      const splitLocations = findSplitTextRanges(
        designatedBlock,
        doc.blocks,
        unit.sourceText,
        cursorByBlock.get(designatedBlock.id) ?? 0,
      );
      if (splitLocations) {
        const source = splitLocations.flatMap((location) => {
          const chars = indexedChars(location.block);
          cursorByBlock.set(location.block.id, location.range[1]);
          return resolveTextRangeRects({
            start: location.range[0],
            end: location.range[1],
            page: location.block.pageIndex,
            charRects: chars,
          });
        });
        if (source.length) {
          return withSource(unit, source, 0.95, 'source-sentence-split-across-origin-blocks');
        }
      }
    }

    if (!range) {
      const approximate = findApproximateTokenRange(
        designatedBlock.text ?? '',
        unit.sourceText,
        cursorByBlock.get(designatedBlock.id) ?? 0,
      );
      if (approximate) {
        block = designatedBlock;
        range = approximate.range;
        sourceConfidence = approximate.confidence;
        fallbackReason = 'source-sentence-fuzzy-token-match';
      }
    }

    const chars = indexedChars(block);
    if (!range || chars.length === 0) {
      // A text-range unit must never highlight an entire multi-paragraph PDF
      // aggregate. This includes paragraph fallbacks created from one split
      // translation unit: their sourceBlockId still points at the unsplit PDF
      // block, whose rectangle can cover most of a column. Only use that block
      // rectangle when the requested text itself covers nearly the whole block;
      // otherwise fail closed and let the quality gate report the unresolved
      // source geometry.
      const coverage = normalizedLength(unit.sourceText)
        / Math.max(1, normalizedLength(block.text ?? ''));
      return coverage >= 0.8
        ? withSource(unit, geometryForBlock(block), 0.75, 'source-sentence-fell-back-to-block')
        : withSource(unit, [], 0, 'source-sentence-range-unresolved');
    }
    cursorByBlock.set(block.id, range[1]);
    const sentenceGeometry = resolveTextRangeRects({
      start: range[0],
      end: range[1],
      page: block.pageIndex,
      charRects: chars,
    });
    return sentenceGeometry.length
      ? withSource(unit, sentenceGeometry, sourceConfidence, fallbackReason)
      : withSource(unit, geometryForBlock(block), 0.75, 'source-sentence-fell-back-to-block');
  });
}
