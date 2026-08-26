import type {
  Doc,
  LayoutRegion,
  SemanticUnit,
  SemanticUnitKind,
} from '../../types/models';
import type { DetectedAssetRegion } from '../assets/extract';
import { validateImmutableRegion } from '../assets/geometryGate';
import { buildSourceSentenceCandidates } from '../align/sourceSentences';
import { extractProtectedTokens } from '../translate/protected';
import { isFigureCaptionText, isTableCaptionText } from '../parser/blocks';
import type {
  TranslationBlockKind,
  TranslationBlockRequest,
  TranslationResponse,
} from '../translate/protocol';

const IMMUTABLE_KINDS = new Set<SemanticUnitKind>([
  'figure', 'table', 'formula', 'code', 'page-furniture',
]);

function translationKind(kind: SemanticUnitKind): TranslationBlockKind {
  if (kind === 'author') return 'author';
  if (kind === 'affiliation') return 'affiliation';
  if (kind === 'abstract') return 'abstract';
  if (kind === 'heading') return 'heading';
  if (kind === 'list-item') return 'list-item';
  if (kind === 'caption') return 'caption';
  if (kind === 'table-title') return 'table-title';
  if (kind === 'title') return 'title';
  return 'paragraph';
}

export function buildTranslationRequestsFromDoc(doc: Doc): TranslationBlockRequest[] {
  return [...doc.semanticUnits]
    .sort((left, right) => left.order - right.order)
    .filter((unit) => unit.kind !== 'reference' && !IMMUTABLE_KINDS.has(unit.kind) && Boolean(unit.sourceText?.trim()))
    .map((unit) => {
      const candidates = buildSourceSentenceCandidates(unit.id, unit.sourceText!);
      return {
        blockId: unit.id,
        kind: translationKind(unit.kind),
        source: unit.sourceText!,
        alignmentMode: candidates.mode,
        sourceSentences: candidates.sentences,
        protectedTokens: extractProtectedTokens(unit.sourceText!),
      };
    });
}

export class DeepSeekProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekProtocolError';
  }
}

export function parseDeepSeekTranslationJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    throw new DeepSeekProtocolError('DeepSeek 返回的 JSON 无法解析');
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeepSeekProtocolError(`DeepSeek JSON ${path} 必须为对象`);
  }
  return value as Record<string, unknown>;
}

function objectArray(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  throw new DeepSeekProtocolError(`DeepSeek JSON ${path} 必须为数组或对象`);
}

function stringArray(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  throw new DeepSeekProtocolError(`DeepSeek JSON ${path} 必须为数组或字符串`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new DeepSeekProtocolError(`DeepSeek JSON 缺少 ${field}`);
  return value;
}

export function normalizeDeepSeekTranslationResponse(input: unknown): TranslationResponse {
  if (!input || typeof input !== 'object') throw new DeepSeekProtocolError('DeepSeek 未返回 JSON 对象');
  const root = input as Record<string, unknown>;
  return {
    blocks: objectArray(root.blocks, 'blocks').map((raw, blockIndex) => {
      const blockPath = `blocks[${blockIndex}]`;
      const block = object(raw, blockPath);
      const groups = block.alignmentGroups ?? block.alignment_groups;
      const terms = block.newTerms ?? block.new_terms ?? [];
      return {
        blockId: text(block.blockId ?? block.block_id, `${blockPath}.block_id`),
        translation: text(block.translation, `${blockPath}.translation`),
        alignmentGroups: objectArray(groups, `${blockPath}.alignment_groups`).map((rawGroup, groupIndex) => {
          const groupPath = `${blockPath}.alignment_groups[${groupIndex}]`;
          const group = object(rawGroup, groupPath);
          return {
            sourceSentenceIds: stringArray(
              group.sourceSentenceIds ?? group.source_sentence_ids,
              `${groupPath}.source_sentence_ids`,
            ).map((id, index) => text(id, `${groupPath}.source_sentence_ids[${index}]`)),
            targetSegments: stringArray(
              group.targetSegments ?? group.target_segments,
              `${groupPath}.target_segments`,
            ).map((segment, index) => text(segment, `${groupPath}.target_segments[${index}]`)),
          };
        }),
        newTerms: objectArray(terms, `${blockPath}.new_terms`).map((rawTerm, termIndex) => {
          const termPath = `${blockPath}.new_terms[${termIndex}]`;
          const term = object(rawTerm, termPath);
          return {
            source: text(term.source, `${termPath}.source`),
            target: text(term.target, `${termPath}.target`),
            abbreviation: typeof term.abbreviation === 'string' ? term.abbreviation : undefined,
          };
        }),
        warnings: stringArray(block.warnings ?? [], `${blockPath}.warnings`)
          .map((warning, index) => text(warning, `${blockPath}.warnings[${index}]`)),
      };
    }),
  };
}

export interface PreparedImmutableStructure {
  regions: LayoutRegion[];
  units: SemanticUnit[];
  assetRegions: DetectedAssetRegion[];
}

export interface PrepareImmutableOptions {
  /** Vision regions after protocol, confidence, coordinate and geometry reconciliation. */
  verifiedAssetRegions?: readonly DetectedAssetRegion[];
}

function intersectionArea(left: { x: number; y: number; w: number; h: number }, right: { x: number; y: number; w: number; h: number }): number {
  return Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x))
    * Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y));
}

function materiallyCovered(block: Doc['blocks'][number], asset: DetectedAssetRegion): boolean {
  if (block.pageIndex !== asset.pageIndex) return false;
  if (block.characterRects?.length) {
    const visible = block.characterRects.filter((character) => character.ch.trim().length > 0);
    if (visible.length) {
      const covered = visible.filter((character) => {
        const center = {
          x: character.rect.x + character.rect.w / 2,
          y: character.rect.y + character.rect.h / 2,
        };
        return center.x >= asset.rect.x && center.x <= asset.rect.x + asset.rect.w
          && center.y >= asset.rect.y && center.y <= asset.rect.y + asset.rect.h;
      }).length;
      return covered / visible.length >= 0.8;
    }
  }
  return intersectionArea(block.rect, asset.rect) / Math.max(1, block.rect.w * block.rect.h) >= 0.5;
}

function withoutAssetTextLines(
  block: Doc['blocks'][number],
  source: string,
  assets: readonly DetectedAssetRegion[],
): string {
  if (!block.characterRects?.length || !assets.length) return source;
  let offset = 0;
  const kept: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    const characters = block.characterRects.filter((character) => (
      character.sourceIndex >= start
      && character.sourceIndex < end
      && character.ch.trim().length > 0
    ));
    if (!characters.length) {
      kept.push(line);
      continue;
    }
    const inside = characters.filter((character) => assets.some((asset) => {
      const centerX = character.rect.x + character.rect.w / 2;
      const centerY = character.rect.y + character.rect.h / 2;
      return centerX >= asset.rect.x && centerX <= asset.rect.x + asset.rect.w
        && centerY >= asset.rect.y && centerY <= asset.rect.y + asset.rect.h;
    })).length;
    if (inside / characters.length < 0.6) kept.push(line);
  }
  return kept.join('\n').trim();
}

function separateOverlappingArxivMetadata(doc: Doc, units: SemanticUnit[]): void {
  for (const block of doc.blocks) {
    const match = block.text?.match(/^(arXiv:\S+\s+\[[^\]]+\]\s+\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+(.+)$/);
    if (!match || !block.characterRects?.length) continue;
    const metadata = match[1]!;
    const suffix = match[2]!;
    const suffixStart = block.text!.indexOf(suffix);
    const suffixCharacters = block.characterRects.filter((character) => character.sourceIndex >= suffixStart);
    if (!suffixCharacters.length) continue;
    const centerX = (Math.min(...suffixCharacters.map((character) => character.rect.x))
      + Math.max(...suffixCharacters.map((character) => character.rect.x + character.rect.w))) / 2;
    const centerY = (Math.min(...suffixCharacters.map((character) => character.rect.y))
      + Math.max(...suffixCharacters.map((character) => character.rect.y + character.rect.h))) / 2;
    const targetBlock = doc.blocks
      .filter((candidate) => (
        candidate.id !== block.id
        && candidate.pageIndex === block.pageIndex
        && candidate.type === 'paragraph'
        && centerX >= candidate.rect.x && centerX <= candidate.rect.x + candidate.rect.w
        && centerY >= candidate.rect.y && centerY <= candidate.rect.y + candidate.rect.h
      ))
      .sort((left, right) => left.rect.w * left.rect.h - right.rect.w * right.rect.h)[0];
    const metadataUnit = units.find((unit) => unit.id === block.id);
    const targetUnit = targetBlock ? units.find((unit) => unit.id === targetBlock.id) : undefined;
    if (!metadataUnit || !targetBlock || !targetUnit?.sourceText) continue;
    const nextCharacter = (targetBlock.characterRects ?? [])
      .filter((character) => character.rect.y > centerY + 2)
      .sort((left, right) => left.rect.y - right.rect.y || left.sourceIndex - right.sourceIndex)[0];
    const insertion = Math.min(targetUnit.sourceText.length, nextCharacter?.sourceIndex ?? targetUnit.sourceText.length);
    targetUnit.sourceText = [
      targetUnit.sourceText.slice(0, insertion).trimEnd(),
      suffix,
      targetUnit.sourceText.slice(insertion).trimStart(),
    ].filter(Boolean).join('\n');
    metadataUnit.sourceText = metadata;
    metadataUnit.kind = 'reference';
    metadataUnit.protectedTokens = extractProtectedTokens(metadata);
  }
}

function withoutEmbeddedMarginFurniture(doc: Doc, block: Doc['blocks'][number], source: string): string {
  if (!block.characterRects?.length || !/\r?\n/.test(source)) return source;
  let offset = 0;
  const lines = source.split(/\r?\n/).map((line) => {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    const characters = block.characterRects!.filter((character) => (
      character.sourceIndex >= start
      && character.sourceIndex < end
      && character.ch.trim().length > 0
    ));
    const nearMargin = characters.filter((character) => {
      const page = doc.pages[character.pageIndex];
      if (!page) return false;
      const centerY = character.rect.y + character.rect.h / 2;
      return centerY < page.height * 0.1 || centerY > page.height * 0.92;
    }).length;
    return { line, furniture: characters.length > 0 && nearMargin / characters.length >= 0.8 };
  });
  if (!lines.some((line) => line.furniture) || !lines.some((line) => !line.furniture && line.line.trim())) {
    return source;
  }
  return lines.filter((line) => !line.furniture).map((line) => line.line).join('\n').trim();
}

function normalizedFurnitureLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function repeatedEmbeddedFurnitureLines(doc: Doc): Set<string> {
  const occurrences = new Map<string, Array<{ standalone: boolean; nearMargin: boolean }>>();
  for (const block of doc.blocks) {
    const lines = (block.text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const finalLine = lines.at(-1);
    if (!finalLine || finalLine.length < 6 || finalLine.length > 180) continue;
    const pageHeight = doc.pages[block.pageIndex]?.height ?? doc.meta.paperHeight;
    const nearMargin = block.rect.y < pageHeight * 0.12
      || block.rect.y + block.rect.h > pageHeight * 0.92;
    const key = normalizedFurnitureLine(finalLine);
    const records = occurrences.get(key) ?? [];
    records.push({ standalone: lines.length === 1, nearMargin });
    occurrences.set(key, records);
  }

  const result = new Set<string>();
  for (const [key, records] of occurrences) {
    if (records.length < 2) continue;
    const looksLikeAuthor = /\bet\s+al\.?$/i.test(key);
    const looksLikeRunningTitle = key.length >= 45 && /[a-z]/i.test(key);
    const repeatedlyObserved = records.length >= 3;
    const hasStandaloneMarginCopy = records.some((record) => record.standalone && record.nearMargin);
    if ((looksLikeAuthor || looksLikeRunningTitle || repeatedlyObserved) && (hasStandaloneMarginCopy || repeatedlyObserved)) {
      result.add(key);
    }
  }
  return result;
}

function withoutRepeatedEmbeddedFurniture(
  doc: Doc,
  block: Doc['blocks'][number],
  source: string,
  repeatedLines: ReadonlySet<string>,
): string {
  if (!repeatedLines.size || !source.trim()) return source;
  const lines = source.split(/\r?\n/);
  if (lines.length === 1) {
    const pageHeight = doc.pages[block.pageIndex]?.height ?? doc.meta.paperHeight;
    const nearMargin = block.rect.y < pageHeight * 0.12
      || block.rect.y + block.rect.h > pageHeight * 0.92;
    // Keep the real document title on the first page. Repeated standalone
    // copies on later page margins are running furniture.
    return block.pageIndex > 0 && nearMargin && repeatedLines.has(normalizedFurnitureLine(source))
      ? ''
      : source;
  }
  return lines
    .filter((line) => !repeatedLines.has(normalizedFurnitureLine(line)))
    .join('\n')
    .trim();
}

function withoutTrailingVisualLabelCluster(source: string): string {
  const lines = source.split(/\r?\n/);
  if (lines.length < 7) return source;
  let start = lines.length;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const line = lines[index]!.trim();
    const words = line.match(/[A-Za-z][A-Za-z0-9_.-]*/g)?.length ?? 0;
    const labelLike = line.length > 0
      && line.length <= 42
      && !/[.!?;:]\s*$/.test(line)
      && (words <= 5 || /^[\d\s.,%+\-×]+$/.test(line));
    if (!labelLike) break;
    start = index;
  }
  const suffix = lines.slice(start).map((line) => line.trim()).filter(Boolean);
  if (suffix.length < 6) return source;
  const numericLines = suffix.filter((line) => /\d/.test(line)).length;
  const chartTerms = suffix.filter((line) => (
    /\b(?:proportion|speedup|benchmark|mod(?:add|reduce|exp|inv)|mmac|rsa|json|tendermint|trace generation)\b/i.test(line)
  )).length;
  if (numericLines < 3 || chartTerms < 1) return source;
  return lines.slice(0, start).join('\n').trim();
}

function unionRect(left: Doc['blocks'][number]['rect'], right: Doc['blocks'][number]['rect']) {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const r = Math.max(left.x + left.w, right.x + right.w);
  const b = Math.max(left.y + left.h, right.y + right.h);
  return { x, y, w: r - x, h: b - y };
}

function formulaContinuation(anchor: Doc['blocks'][number], candidate: Doc['blocks'][number]): boolean {
  if (candidate.id === anchor.id || candidate.pageIndex !== anchor.pageIndex) return false;
  if (candidate.type !== 'paragraph') return false;
  const text = candidate.text?.trim() ?? '';
  if (!text || text.length > 120 || (text.match(/[A-Za-z]{3,}/g)?.length ?? 0) > 4) return false;
  if (!/[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(text)) return false;
  const verticalGap = Math.max(
    0,
    candidate.rect.y - (anchor.rect.y + anchor.rect.h),
    anchor.rect.y - (candidate.rect.y + candidate.rect.h),
  );
  const horizontalOverlap = Math.max(0, Math.min(
    anchor.rect.x + anchor.rect.w,
    candidate.rect.x + candidate.rect.w,
  ) - Math.max(anchor.rect.x, candidate.rect.x));
  return verticalGap <= 18 && horizontalOverlap > 0;
}

function withoutTrailingFormulaFragment(source: string): string {
  const lines = source.split(/\r?\n/);
  let cut = lines.length;
  let containsMath = false;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const tail = lines[index]!.trim();
    const naturalWords = tail.match(/[A-Za-z]{3,}/g) ?? [];
    const mathLike = /[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(tail);
    const numericOnly = /^[\d\s.,()[\]{}]+$/.test(tail);
    if (tail.length > 100 || naturalWords.length > 1 || (!mathLike && !numericOnly)) break;
    cut = index;
    containsMath ||= mathLike;
  }
  return containsMath ? lines.slice(0, cut).join('\n').trim() : source.trim();
}

function trailingFormulaRect(
  block: Doc['blocks'][number],
  cleanedLength: number,
): Doc['blocks'][number]['rect'] | undefined {
  const characters = (block.characterRects ?? []).filter((character) => (
    character.pageIndex === block.pageIndex
    && character.sourceIndex >= cleanedLength
    && /[\d=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(character.ch)
  ));
  if (!characters.length) return undefined;
  const x = Math.min(...characters.map((character) => character.rect.x));
  const y = Math.min(...characters.map((character) => character.rect.y));
  const right = Math.max(...characters.map((character) => character.rect.x + character.rect.w));
  const bottom = Math.max(...characters.map((character) => character.rect.y + character.rect.h));
  return { x: x - 2, y: y - 2, w: right - x + 4, h: bottom - y + 4 };
}

function visualColumn(block: Doc['blocks'][number], pageWidth: number): 'span' | 'left' | 'right' {
  if (block.widthMode === 'span') return 'span';
  return block.rect.x + block.rect.w / 2 < pageWidth / 2 ? 'left' : 'right';
}

function sameVisualColumn(
  left: Doc['blocks'][number],
  right: Doc['blocks'][number],
  pageWidth: number,
): boolean {
  return visualColumn(left, pageWidth) === visualColumn(right, pageWidth);
}

function looksLikeVisualLabels(block: Doc['blocks'][number]): boolean {
  const lines = (block.text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const labelLike = lines.filter((line) => (
    line.length <= 32 || /^[-+]?\d[\d.,%‰+\- ]*$/.test(line)
  )).length;
  return labelLike / lines.length >= 0.7;
}

function visualColumnBounds(doc: Doc, anchor: Doc['blocks'][number]): { x: number; w: number } {
  const pageWidth = doc.pages[anchor.pageIndex]?.width ?? doc.meta.paperWidth;
  const columnBlocks = doc.blocks.filter((block) => (
    block.pageIndex === anchor.pageIndex && sameVisualColumn(block, anchor, pageWidth)
  ));
  if (!columnBlocks.length) return { x: anchor.rect.x, w: anchor.rect.w };
  const x = Math.min(...columnBlocks.map((block) => block.rect.x));
  const right = Math.max(...columnBlocks.map((block) => block.rect.x + block.rect.w));
  if (anchor.widthMode === 'span' && right - x < pageWidth * 0.6) {
    return { x: pageWidth * 0.08, w: pageWidth * 0.84 };
  }
  return { x, w: right - x };
}

function detectedPageFurnitureIds(doc: Doc): Set<string> {
  const ids = new Set<string>();
  const repeatedMargins = new Map<string, Array<{ id: string; pageIndex: number }>>();
  for (const block of doc.blocks) {
    const pageHeight = doc.pages[block.pageIndex]?.height ?? doc.meta.paperHeight;
    const nearMargin = block.rect.y < pageHeight * 0.12
      || block.rect.y + block.rect.h > pageHeight * 0.92;
    if (!nearMargin) continue;
    const normalized = block.text?.trim().replace(/\s+/g, ' ') ?? '';
    if (/^(?:page\s*)?(?:\d+|[ivxlcdm]+)(?:\s*(?:\/|of)\s*\d+)?$/i.test(normalized)) {
      ids.add(block.id);
    }
    if (normalized && normalized.length <= 160) {
      const key = normalized.toLocaleLowerCase();
      const records = repeatedMargins.get(key) ?? [];
      records.push({ id: block.id, pageIndex: block.pageIndex });
      repeatedMargins.set(key, records);
    }
  }
  for (const records of repeatedMargins.values()) {
    if (new Set(records.map((record) => record.pageIndex)).size < 2) continue;
    records.forEach((record) => ids.add(record.id));
  }
  return ids;
}

function splitMergedCaptionText(source: string): Array<{ kind: 'figure' | 'table'; text: string }> {
  const starts = [...source.matchAll(/\b(Figure|Table)\s+\d+[A-Za-z]?\s*[:.]\s*/gi)];
  if (starts.length < 2) return [];
  return starts.map((match, index) => ({
    kind: match[1]!.toLocaleLowerCase() as 'figure' | 'table',
    text: source.slice(match.index!, starts[index + 1]?.index ?? source.length).trim(),
  })).filter((segment) => segment.text.length > 0);
}

export function prepareImmutableStructure(doc: Doc, options: PrepareImmutableOptions = {}): PreparedImmutableStructure {
  const regions = doc.layoutRegions.map((region) => ({ ...region, orderedUnitIds: [...region.orderedUnitIds] }));
  let units = doc.semanticUnits.map((unit) => ({ ...unit, protectedTokens: [...unit.protectedTokens] }));
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  const assetRegions: DetectedAssetRegion[] = [];
  const verifiedAssetRegions = (options.verifiedAssetRegions ?? []).map((asset) => ({
    ...asset, rect: { ...asset.rect },
  }));
  const furnitureIds = detectedPageFurnitureIds(doc);
  const repeatedFurnitureLines = repeatedEmbeddedFurnitureLines(doc);
  if (furnitureIds.size) {
    units = units.filter((unit) => !furnitureIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !furnitureIds.has(unitId));
    }
  }

  separateOverlappingArxivMetadata(doc, units);
  const emptiedFurnitureIds = new Set<string>();
  for (const unit of units) {
    if (!unit.sourceText) continue;
    const block = blocks.get(unit.id);
    if (!block) continue;
    const geometryCleaned = withoutEmbeddedMarginFurniture(doc, block, unit.sourceText);
    const labelsCleaned = withoutTrailingVisualLabelCluster(geometryCleaned);
    const cleaned = withoutRepeatedEmbeddedFurniture(doc, block, labelsCleaned, repeatedFurnitureLines);
    if (cleaned !== unit.sourceText) {
      unit.sourceText = cleaned;
      unit.protectedTokens = extractProtectedTokens(cleaned);
      if (!cleaned) emptiedFurnitureIds.add(unit.id);
    }
  }
  if (emptiedFurnitureIds.size) {
    units = units.filter((unit) => !emptiedFurnitureIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !emptiedFurnitureIds.has(unitId));
    }
  }

  const bibliographySectionIds = new Set(units
    .filter((unit) => unit.kind === 'heading' && /^(references|bibliography|参考文献)\s*$/i.test(unit.sourceText?.trim() ?? ''))
    .map((unit) => unit.id));
  if (bibliographySectionIds.size) {
    units = units.map((unit) => unit.id !== unit.parentId && bibliographySectionIds.has(unit.parentId ?? '')
      ? { ...unit, kind: 'reference' as const }
      : unit);
  }

  // PDF text extraction can merge adjacent captions from multiple visual
  // objects into one block (for example Figure 9 + Figure 10, or Figure 9 +
  // Table 2). Keep the crops separate and create one semantic caption per
  // visual object, preserving the source left-to-right order within each kind.
  const assetsByCaption = new Map<string, DetectedAssetRegion[]>();
  for (const asset of verifiedAssetRegions) {
    if (!asset.captionUnitId) continue;
    const group = assetsByCaption.get(asset.captionUnitId) ?? [];
    group.push(asset);
    assetsByCaption.set(asset.captionUnitId, group);
  }
  for (const [captionId, assets] of assetsByCaption) {
    const original = units.find((unit) => unit.id === captionId);
    if (!original?.sourceText) continue;
    const segments = splitMergedCaptionText(original.sourceText);
    if (segments.length < 2) continue;
    const supportedAssets = assets.filter((asset) => asset.kind === 'figure' || asset.kind === 'table');
    const countsMatch = supportedAssets.length === assets.length
      && (['figure', 'table'] as const).every((kind) => (
        supportedAssets.filter((asset) => asset.kind === kind).length
        === segments.filter((segment) => segment.kind === kind).length
      ));
    if (!countsMatch) continue;

    const segmentTotals = new Map<'figure' | 'table', number>();
    const segmentOrdinals = new Map<'figure' | 'table', number>();
    for (const kind of ['figure', 'table'] as const) {
      segmentTotals.set(kind, segments.filter((segment) => segment.kind === kind).length);
    }
    const replacements: SemanticUnit[] = segments.map((segment, index) => {
      const ordinal = (segmentOrdinals.get(segment.kind) ?? 0) + 1;
      segmentOrdinals.set(segment.kind, ordinal);
      const suffix = (segmentTotals.get(segment.kind) ?? 0) > 1
        ? `${segment.kind}-${ordinal}`
        : segment.kind;
      return {
        ...original,
        id: `${captionId}-${suffix}`,
        kind: segment.kind === 'table' ? 'table-title' : 'caption',
        sourceText: segment.text,
        protectedTokens: extractProtectedTokens(segment.text),
        order: original.order + (index - (segments.length - 1) / 2) * 0.01,
      };
    });
    units = units.filter((unit) => unit.id !== captionId).concat(replacements);
    for (const region of regions) {
      const index = region.orderedUnitIds.indexOf(captionId);
      if (index >= 0) region.orderedUnitIds.splice(index, 1, ...replacements.map((unit) => unit.id));
    }
    for (const kind of ['figure', 'table'] as const) {
      const kindAssets = supportedAssets
        .filter((asset) => asset.kind === kind)
        .sort((left, right) => left.rect.x - right.rect.x || left.rect.y - right.rect.y);
      const kindReplacements = replacements.filter((replacement) => (
        replacement.kind === (kind === 'table' ? 'table-title' : 'caption')
      ));
      kindAssets.forEach((asset, index) => {
        asset.captionUnitId = kindReplacements[index]!.id;
      });
    }
  }

  for (const asset of verifiedAssetRegions) {
    if (asset.kind !== 'table') continue;
    const numericRows = doc.blocks.filter((block) => {
      if (block.pageIndex !== asset.pageIndex || block.id === asset.captionUnitId) return false;
      const horizontalOverlap = Math.max(0, Math.min(
        block.rect.x + block.rect.w,
        asset.rect.x + asset.rect.w,
      ) - Math.max(block.rect.x, asset.rect.x));
      const overlap = Math.max(0, Math.min(
        block.rect.y + block.rect.h,
        asset.rect.y + asset.rect.h,
      ) - Math.max(block.rect.y, asset.rect.y));
      const numericTokens = block.text?.match(/\d+(?:[.,]\d+)?/g) ?? [];
      return horizontalOverlap / Math.max(1, Math.min(block.rect.w, asset.rect.w)) >= 0.2
        && overlap / Math.max(1, block.rect.h) >= 0.6
        && numericTokens.length >= 2;
    });
    if (!numericRows.length) continue;
    const left = Math.min(asset.rect.x, ...numericRows.map((block) => block.rect.x));
    const right = Math.max(asset.rect.x + asset.rect.w, ...numericRows.map((block) => block.rect.x + block.rect.w));
    const assetBottom = asset.rect.y + asset.rect.h;
    const numericBottom = Math.max(...numericRows.map((block) => block.rect.y + block.rect.h)) + 2;
    const bottom = Math.min(assetBottom, numericBottom);
    asset.rect = {
      ...asset.rect,
      x: left,
      w: right - left,
      h: bottom > asset.rect.y + 12 ? bottom - asset.rect.y : asset.rect.h,
    };
  }

  for (const unit of units) {
    if (unit.kind !== 'formula' && unit.kind !== 'code' && unit.kind !== 'page-furniture') continue;
    const block = blocks.get(unit.id);
    if (!block) throw new Error(`不可变资产 ${unit.id} 缺少源坐标`);
    if (verifiedAssetRegions.some((asset) => materiallyCovered(block, asset))) continue;
    let rect = unit.kind === 'formula'
      ? doc.blocks
        .filter((candidate) => formulaContinuation(block, candidate))
        .reduce((combined, candidate) => unionRect(combined, candidate.rect), { ...block.rect })
      : { ...block.rect };
    assetRegions.push({
      id: unit.assetId ?? unit.id,
      kind: unit.kind,
      pageIndex: block.pageIndex,
      rect,
      widthMode: block.widthMode,
    });
    if (unit.kind === 'formula') {
      const previousBlock = doc.blocks
        .filter((candidate) => (
          candidate.id !== block.id
          && candidate.pageIndex === block.pageIndex
          && candidate.rect.y + candidate.rect.h <= block.rect.y + 2
        ))
        .sort((left, right) => (
          right.rect.y + right.rect.h - (left.rect.y + left.rect.h)
        ))[0];
      const previous = previousBlock
        ? units.find((candidate) => candidate.id === previousBlock.id)
        : undefined;
      if (previous?.sourceText && previousBlock) {
        const cleaned = withoutTrailingFormulaFragment(previous.sourceText);
        const formulaTail = cleaned.length < previous.sourceText.trim().length
          ? trailingFormulaRect(previousBlock, cleaned.length)
          : undefined;
        if (formulaTail) {
          rect = unionRect(rect, formulaTail);
          assetRegions[assetRegions.length - 1]!.rect = rect;
        }
        previous.sourceText = cleaned;
      }
    }
  }

  for (const caption of units.filter((unit) => (
    unit.kind === 'caption'
    && isFigureCaptionText(unit.sourceText ?? '')
    && !verifiedAssetRegions.some((asset) => asset.kind === 'figure' && asset.captionUnitId === unit.id)
  ))) {
    const captionBlock = blocks.get(caption.id);
    const region = regions.find((candidate) => candidate.id === caption.layoutRegionId);
    if (!captionBlock || !region) throw new Error(`图注 ${caption.id} 缺少版式坐标`);
    const captionIndex = region.orderedUnitIds.indexOf(caption.id);
    const pageWidth = doc.pages[captionBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const previousBlock = [...region.orderedUnitIds.slice(0, captionIndex)]
      .reverse().map((id) => blocks.get(id)).find((block) => (
        block?.pageIndex === captionBlock.pageIndex
        && sameVisualColumn(block, captionBlock, pageWidth)
      ));
    const bottom = captionBlock.rect.y - 6;
    const furnitureBoundary = doc.blocks
      .filter((block) => (
        block.pageIndex === captionBlock.pageIndex
        && furnitureIds.has(block.id)
        && block.rect.y + block.rect.h <= bottom
        && block.rect.x < captionBlock.rect.x + captionBlock.rect.w
        && block.rect.x + block.rect.w > captionBlock.rect.x
      ))
      .reduce((boundary, block) => Math.max(boundary, block.rect.y + block.rect.h + 6), 0);
    const previousBoundary = previousBlock ? previousBlock.rect.y + previousBlock.rect.h + 6 : 0;
    const visualLabelTop = doc.blocks
      .filter((block) => (
        block.pageIndex === captionBlock.pageIndex
        && block.id !== caption.id
        && block.rect.y < bottom
        && block.rect.x < captionBlock.rect.x + captionBlock.rect.w
        && block.rect.x + block.rect.w > captionBlock.rect.x
        && looksLikeVisualLabels(block)
      ))
      .reduce((boundary, block) => Math.min(boundary, Math.max(1, block.rect.y - 6)), Number.POSITIVE_INFINITY);
    const inferredTop = Math.max(
      furnitureBoundary,
      Number.isFinite(visualLabelTop)
        ? visualLabelTop
        : (doc.pages[captionBlock.pageIndex]?.height ?? doc.meta.paperHeight) * 0.1,
    );
    const top = previousBlock && previousBoundary < bottom - 24 ? previousBoundary : inferredTop;
    if (bottom - top < 24) {
      const previousId = previousBlock?.id ?? 'none';
      const previousText = previousBlock?.text?.replace(/\s+/g, ' ').slice(0, 48) ?? 'none';
      throw new Error(
        `无法可靠确定图 ${caption.id} 的不可变区域（前块 ${previousId}“${previousText}”，可用高度 ${Math.round(bottom - top)}pt）`,
      );
    }
    const id = `${caption.id}-asset`;
    const widthMode = captionBlock.widthMode;
    const column = visualColumnBounds(doc, captionBlock);
    assetRegions.push({
      id, kind: 'figure', pageIndex: captionBlock.pageIndex,
      rect: { x: column.x, y: top, w: column.w, h: bottom - top },
      widthMode, captionUnitId: caption.id,
    });
    units.push({
      id, kind: 'figure', protectedTokens: [], assetId: id,
      layoutRegionId: caption.layoutRegionId, order: caption.order - 0.1,
    });
    region.orderedUnitIds.splice(captionIndex, 0, id);
  }

  for (const caption of units.filter((unit) => (
    unit.kind === 'caption'
    && isTableCaptionText(unit.sourceText ?? '')
    && !verifiedAssetRegions.some((asset) => asset.kind === 'table' && asset.captionUnitId === unit.id)
  ))) {
    const captionBlock = blocks.get(caption.id);
    const region = regions.find((candidate) => candidate.id === caption.layoutRegionId);
    if (!captionBlock || !region) throw new Error(`表题 ${caption.id} 缺少版式坐标`);
    const pageWidth = doc.pages[captionBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const captionBottom = captionBlock.rect.y + captionBlock.rect.h;
    const following = doc.blocks
      .filter((block) => (
        block.id !== caption.id
        && block.pageIndex === captionBlock.pageIndex
        && sameVisualColumn(block, captionBlock, pageWidth)
        && block.rect.y >= captionBottom - 2
      ))
      .sort((left, right) => left.rect.y - right.rect.y || left.order - right.order);
    const first = following[0];
    if (!first) throw new Error(`无法可靠确定表 ${caption.id} 的不可变区域（缺少后续边界）`);

    const bodyIds: string[] = [];
    let top = captionBottom + 6;
    let bottom: number;
    const initialGap = first.rect.y - captionBottom;
    if (initialGap >= 24) {
      bottom = first.rect.y - 6;
    } else {
      if (initialGap > 20) throw new Error(`无法可靠确定表 ${caption.id} 的不可变区域（表题后间距不明确）`);
      let previousBottom = captionBottom;
      let boundaryFound = false;
      for (const candidate of following) {
        const gap = candidate.rect.y - previousBottom;
        if (bodyIds.length && (
          gap > 20
          || candidate.type === 'section'
          || candidate.type === 'caption'
          || candidate.type === 'equation'
        )) {
          boundaryFound = true;
          break;
        }
        bodyIds.push(candidate.id);
        previousBottom = Math.max(previousBottom, candidate.rect.y + candidate.rect.h);
      }
      if (!bodyIds.length || !boundaryFound) {
        throw new Error(`无法可靠确定表 ${caption.id} 的不可变区域（未检测到表后边界）`);
      }
      const lastBody = blocks.get(bodyIds.at(-1)!)!;
      bottom = lastBody.rect.y + lastBody.rect.h + 6;
    }
    if (bottom - top < 18) throw new Error(`无法可靠确定表 ${caption.id} 的不可变区域（高度不足）`);

    const id = `${caption.id}-asset`;
    const column = visualColumnBounds(doc, captionBlock);
    assetRegions.push({
      id, kind: 'table', pageIndex: captionBlock.pageIndex,
      rect: { x: column.x, y: top, w: column.w, h: bottom - top },
      widthMode: captionBlock.widthMode, captionUnitId: caption.id,
    });
    units = units.filter((unit) => !bodyIds.includes(unit.id));
    for (const candidateRegion of regions) {
      candidateRegion.orderedUnitIds = candidateRegion.orderedUnitIds.filter((unitId) => !bodyIds.includes(unitId));
    }
    units.push({
      id, kind: 'table', protectedTokens: [], assetId: id,
      layoutRegionId: caption.layoutRegionId, order: caption.order + 0.1,
    });
    const captionIndex = region.orderedUnitIds.indexOf(caption.id);
    region.orderedUnitIds.splice(captionIndex + 1, 0, id);
  }

  for (const asset of verifiedAssetRegions) {
    const caption = asset.captionUnitId ? units.find((unit) => unit.id === asset.captionUnitId) : undefined;
    if (asset.captionUnitId && !caption) throw new Error(`Vision 资产 ${asset.id} 缺少图表注 ${asset.captionUnitId}`);
    const coveredBlocks = doc.blocks.filter((block) => block.id !== asset.captionUnitId && materiallyCovered(block, asset));
    const coveredIds = new Set(coveredBlocks.map((block) => block.id));
    const coveredUnits = units.filter((unit) => coveredIds.has(unit.id));
    units = units.filter((unit) => !coveredIds.has(unit.id) && unit.id !== asset.id);
    for (const candidateRegion of regions) {
      candidateRegion.orderedUnitIds = candidateRegion.orderedUnitIds.filter((unitId) => (
        !coveredIds.has(unitId) && unitId !== asset.id
      ));
    }

    const page = doc.pages[asset.pageIndex];
    if (!page) throw new Error(`Vision 资产 ${asset.id} 缺少页面尺寸`);
    const centerX = asset.rect.x + asset.rect.w / 2;
    const centerY = asset.rect.y + asset.rect.h / 2;
    const coveredRegion = coveredUnits
      .map((unit) => regions.find((candidate) => candidate.id === unit.layoutRegionId))
      .find((candidate): candidate is LayoutRegion => Boolean(candidate));
    const memberPageRegion = regions.find((candidate) => candidate.orderedUnitIds.some((unitId) => (
      blocks.get(unitId)?.pageIndex === asset.pageIndex
    )));
    const region = (caption ? regions.find((candidate) => candidate.id === caption.layoutRegionId) : undefined)
      ?? coveredRegion
      ?? memberPageRegion
      ?? regions.find((candidate) => (
        candidate.sourcePage === asset.pageIndex
        && centerX >= candidate.bounds.x && centerX <= candidate.bounds.x + candidate.bounds.w
        && centerY >= candidate.bounds.y && centerY <= candidate.bounds.y + candidate.bounds.h
      ))
      ?? regions.find((candidate) => candidate.sourcePage === asset.pageIndex);
    if (!region) throw new Error(`Vision 资产 ${asset.id} 缺少版式区域`);

    const coveredOrder = coveredUnits.length ? Math.min(...coveredUnits.map((unit) => unit.order)) : undefined;
    const order = caption
      ? caption.order + (asset.kind === 'figure' ? -0.1 : 0.1)
      : coveredOrder ?? Math.max(0, ...units.map((unit) => unit.order)) + 0.1;
    units.push({
      id: asset.id, kind: asset.kind, protectedTokens: [], assetId: asset.id,
      layoutRegionId: region.id, order,
    });
    const captionIndex = caption ? region.orderedUnitIds.indexOf(caption.id) : -1;
    if (captionIndex >= 0) {
      region.orderedUnitIds.splice(captionIndex + (asset.kind === 'figure' ? 0 : 1), 0, asset.id);
    } else {
      const nextIndex = region.orderedUnitIds.findIndex((unitId) => {
        const unit = units.find((candidate) => candidate.id === unitId);
        return unit ? unit.order > order : false;
      });
      region.orderedUnitIds.splice(nextIndex < 0 ? region.orderedUnitIds.length : nextIndex, 0, asset.id);
    }
    assetRegions.push(asset);
  }

  const emptyAfterAssetMask = new Set<string>();
  for (const unit of units) {
    if (!unit.sourceText || unit.kind === 'caption' || unit.kind === 'table-title') continue;
    const block = blocks.get(unit.id);
    if (!block) continue;
    const pageAssets = assetRegions.filter((asset) => (
      asset.pageIndex === block.pageIndex && asset.id !== unit.id
    ));
    if (!pageAssets.length) continue;
    unit.sourceText = withoutAssetTextLines(block, unit.sourceText, pageAssets);
    if (!unit.sourceText) emptyAfterAssetMask.add(unit.id);
  }
  if (emptyAfterAssetMask.size) {
    units = units.filter((unit) => !emptyAfterAssetMask.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !emptyAfterAssetMask.has(unitId));
    }
  }

  for (const asset of assetRegions) {
    const coveredIds = new Set(doc.blocks
      .filter((block) => block.id !== asset.captionUnitId && materiallyCovered(block, asset))
      .map((block) => block.id));
    if (coveredIds.size) {
      units = units.filter((unit) => unit.id === asset.id || !coveredIds.has(unit.id));
      for (const region of regions) {
        region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => (
          unitId === asset.id || !coveredIds.has(unitId)
        ));
      }
    }
    const page = doc.pages[asset.pageIndex];
    if (!page) throw new Error(`不可变资产 ${asset.id} 缺少页面尺寸`);
    const intersecting = doc.blocks.filter((block) => (
      block.pageIndex === asset.pageIndex
      && block.rect.x < asset.rect.x + asset.rect.w
      && block.rect.x + block.rect.w > asset.rect.x
      && block.rect.y < asset.rect.y + asset.rect.h
      && block.rect.y + block.rect.h > asset.rect.y
    ));
    const captionRect = asset.captionUnitId ? blocks.get(asset.captionUnitId)?.rect : undefined;
    const geometry = validateImmutableRegion(asset, page, intersecting, captionRect);
    if (!geometry.pass) {
      throw new Error(`不可变资产 ${asset.id} 几何校验失败（第 ${asset.pageIndex + 1} 页：${geometry.issues.join(', ')}）`);
    }
  }

  const horizontalRows: LayoutRegion[] = [];
  const pageKindGroups = new Map<string, DetectedAssetRegion[]>();
  for (const asset of assetRegions) {
    if (asset.kind !== 'figure' && asset.kind !== 'table') continue;
    const key = `${asset.pageIndex}:${asset.kind}`;
    const group = pageKindGroups.get(key) ?? [];
    group.push(asset);
    pageKindGroups.set(key, group);
  }
  for (const [key, candidates] of pageKindGroups) {
    const pending = [...candidates].sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
    let rowNumber = 0;
    while (pending.length) {
      const anchor = pending.shift()!;
      const band = [anchor];
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const candidate = pending[index]!;
        const overlap = Math.max(0, Math.min(
          anchor.rect.y + anchor.rect.h,
          candidate.rect.y + candidate.rect.h,
        ) - Math.max(anchor.rect.y, candidate.rect.y));
        if (Math.abs(candidate.rect.y - anchor.rect.y) <= 12
          && overlap / Math.max(1, Math.min(anchor.rect.h, candidate.rect.h)) >= 0.6) {
          band.push(candidate);
          pending.splice(index, 1);
        }
      }
      if (band.length < 2) continue;
      band.sort((left, right) => left.rect.x - right.rect.x);
      const grouped = new Map<string, DetectedAssetRegion[]>();
      for (const asset of band) {
        const captionKey = asset.captionUnitId ?? `asset:${asset.id}`;
        const members = grouped.get(captionKey) ?? [];
        members.push(asset);
        grouped.set(captionKey, members);
      }
      const orderedUnitIds: string[] = [];
      for (const members of grouped.values()) {
        const captionId = members[0]?.captionUnitId;
        if (members[0]?.kind === 'table' && captionId) orderedUnitIds.push(captionId);
        orderedUnitIds.push(...members.map((asset) => asset.id));
        if (members[0]?.kind === 'figure' && captionId) orderedUnitIds.push(captionId);
      }
      const uniqueUnitIds = [...new Set(orderedUnitIds)];
      const left = Math.min(...band.map((asset) => asset.rect.x));
      const top = Math.min(...band.map((asset) => asset.rect.y));
      const right = Math.max(...band.map((asset) => asset.rect.x + asset.rect.w));
      const bottom = Math.max(...band.map((asset) => asset.rect.y + asset.rect.h));
      const [pageText, kind] = key.split(':');
      const rowId = `asset-row-p${Number(pageText) + 1}-${kind}-${++rowNumber}`;
      for (const region of regions) {
        region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !uniqueUnitIds.includes(unitId));
      }
      for (const unit of units) {
        if (uniqueUnitIds.includes(unit.id)) unit.layoutRegionId = rowId;
      }
      horizontalRows.push({
        id: rowId,
        mode: 'full-width',
        presentation: 'horizontal',
        sourcePage: anchor.pageIndex,
        bounds: { x: left, y: top, w: right - left, h: bottom - top },
        orderedUnitIds: uniqueUnitIds,
      });
    }
  }
  if (horizontalRows.length) {
    for (const pageIndex of [...new Set(horizontalRows.map((row) => row.sourcePage))]) {
      const rows = horizontalRows
        .filter((row) => row.sourcePage === pageIndex)
        .sort((left, right) => left.bounds.y - right.bounds.y);
      const firstPageRegion = regions.findIndex((region) => region.sourcePage === pageIndex);
      regions.splice(firstPageRegion < 0 ? regions.length : firstPageRegion, 0, ...rows);
    }
    for (let index = regions.length - 1; index >= 0; index -= 1) {
      if (!regions[index]!.orderedUnitIds.length) regions.splice(index, 1);
    }
  }

  return {
    regions,
    units: units.sort((left, right) => left.order - right.order),
    assetRegions,
  };
}
