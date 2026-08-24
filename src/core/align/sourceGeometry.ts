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

function findTextRange(text: string, needle: string, from: number): [number, number] | null {
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

function withSource(
  unit: AlignmentUnit,
  source: AlignmentRectSet[],
  confidence = 1,
): AlignmentUnit {
  return source.length
    ? { ...unit, source, confidence, status: 'aligned' }
    : { ...unit, source: [], confidence: 0, status: 'unmatched' };
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

    const block = blocks.get(unit.parentId ?? '')
      ?? unit.sourceUnitIds.map((id) => blocks.get(id)).find(Boolean)
      ?? blocks.get(unit.id);
    if (!block) return withSource(unit, []);

    if (unit.kind !== 'semantic-group' || !unit.sourceText) {
      return withSource(unit, geometryForBlock(block));
    }

    const chars = indexedChars(block);
    const range = findTextRange(block.text ?? '', unit.sourceText, cursorByBlock.get(block.id) ?? 0);
    if (!range || chars.length === 0) return withSource(unit, []);
    cursorByBlock.set(block.id, range[1]);
    return withSource(unit, resolveTextRangeRects({
      start: range[0],
      end: range[1],
      page: block.pageIndex,
      charRects: chars,
    }));
  });
}
