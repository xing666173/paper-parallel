import type {
  Doc,
  LayoutRegion,
  Rect,
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
  /** Vision page layout is authoritative when the parser is confused by formula/figure text fragments. */
  pageLayouts?: ReadonlyMap<number, 'single' | 'double' | 'mixed'>;
}

function intersectionArea(left: { x: number; y: number; w: number; h: number }, right: { x: number; y: number; w: number; h: number }): number {
  return Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x))
    * Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y));
}

function materiallyCovered(block: Doc['blocks'][number], asset: DetectedAssetRegion): boolean {
  if (block.characterRects?.length) {
    const visible = block.characterRects.filter((character) => character.ch.trim().length > 0);
    if (visible.length) {
      const covered = visible.filter((character) => {
        if (character.pageIndex !== asset.pageIndex) return false;
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
  if (block.pageIndex !== asset.pageIndex) return false;
  return intersectionArea(block.rect, asset.rect) / Math.max(1, block.rect.w * block.rect.h) >= 0.5;
}

function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function physicalRectOnPage(block: Doc['blocks'][number], pageIndex: number): Rect | undefined {
  const characters = (block.characterRects ?? []).filter((character) => (
    character.pageIndex === pageIndex && character.ch.trim().length > 0
  ));
  const characterRect = unionRects(characters.map((character) => character.rect));
  if (characterRect) return characterRect;
  const fragments = (block.fragments ?? []).filter((fragment) => fragment.pageIndex === pageIndex);
  const fragmentRect = unionRects(fragments.map((fragment) => fragment.rect));
  if (fragmentRect) return fragmentRect;
  return block.pageIndex === pageIndex ? block.rect : undefined;
}

function physicalPages(block: Doc['blocks'][number]): number[] {
  return [...new Set([
    block.pageIndex,
    ...(block.fragments ?? []).map((fragment) => fragment.pageIndex),
    ...(block.characterRects ?? []).map((character) => character.pageIndex),
  ])];
}

function proseHeavyFormulaRegion(doc: Doc, asset: DetectedAssetRegion): boolean {
  if (asset.kind !== 'formula') return false;
  const text = doc.blocks
    .flatMap((block) => (block.characterRects ?? [])
      .filter((character) => {
        if (character.pageIndex !== asset.pageIndex) return false;
        const centerX = character.rect.x + character.rect.w / 2;
        const centerY = character.rect.y + character.rect.h / 2;
        return centerX >= asset.rect.x && centerX <= asset.rect.x + asset.rect.w
          && centerY >= asset.rect.y && centerY <= asset.rect.y + asset.rect.h;
      })
      .map((character) => ({
        blockOrder: block.order,
        sourceIndex: character.sourceIndex,
        ch: character.ch,
      })))
    .sort((left, right) => left.blockOrder - right.blockOrder || left.sourceIndex - right.sourceIndex)
    .map((character) => character.ch)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  const functionWords = text.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi) ?? [];
  // Vision often encloses an entire prose line merely because it contains an
  // inline equation. Keeping that wide rectangle as pixels leaves the prose
  // untranslated. Reject only regions whose inside text is clearly prose;
  // the inline-formula geometry pass below will preserve the mathematical
  // substring instead.
  return words.length >= 6 && functionWords.length >= 2;
}

function trimTableBeforeFollowingProse(
  doc: Doc,
  asset: DetectedAssetRegion,
): DetectedAssetRegion {
  if (asset.kind !== 'table') return asset;
  const assetBottom = asset.rect.y + asset.rect.h;
  const naturalLanguageLine = (value: string): boolean => {
    const words = value.match(/[A-Za-z]{3,}/g) ?? [];
    const functionWords = value.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|while)\b/gi) ?? [];
    return words.length >= 8 && functionWords.length >= 2;
  };
  const firstProseLineTop = (block: Doc['blocks'][number], fallbackRect: Rect): number | undefined => {
    const source = block.text ?? '';
    const lines = source.split(/\r?\n/);
    let sourceOffset = 0;
    for (const line of lines) {
      const start = sourceOffset;
      const end = start + line.length;
      sourceOffset = end + 1;
      if (!naturalLanguageLine(line)) continue;
      const characters = (block.characterRects ?? []).filter((character) => (
        character.pageIndex === asset.pageIndex
        && character.sourceIndex >= start
        && character.sourceIndex < end
        && character.ch.trim().length > 0
      ));
      const lineRect = unionRects(characters.map((character) => character.rect));
      if (lineRect) return lineRect.y;
      // A multi-line aggregate can begin with table rows and end in prose.
      // Without character geometry there is no safe line-level cut point.
      if (lines.length > 1) return undefined;
      return fallbackRect.y;
    }
    return undefined;
  };
  const proseTop = doc.blocks
    .map((block) => {
      const rect = physicalRectOnPage(block, asset.pageIndex);
      return rect ? { block, rect, proseTop: firstProseLineTop(block, rect) } : undefined;
    })
    .filter((candidate): candidate is {
      block: Doc['blocks'][number]; rect: Rect; proseTop: number;
    } => candidate !== undefined && candidate.proseTop !== undefined)
    .filter(({ block, rect, proseTop: candidateProseTop }) => {
      if (block.type !== 'paragraph') return false;
      const horizontalOverlap = Math.max(0, Math.min(
        rect.x + rect.w,
        asset.rect.x + asset.rect.w,
      ) - Math.max(rect.x, asset.rect.x));
      return horizontalOverlap >= Math.min(rect.w, asset.rect.w) * 0.25
        && candidateProseTop > asset.rect.y + Math.min(24, asset.rect.h * 0.35)
        && candidateProseTop < assetBottom - 2;
    })
    .map(({ proseTop: candidateProseTop }) => candidateProseTop)
    .sort((left, right) => left - right)[0];
  if (proseTop === undefined) return asset;
  const trimmedHeight = proseTop - asset.rect.y - 2;
  if (trimmedHeight < 12 || trimmedHeight < asset.rect.h * 0.45) return asset;
  return { ...asset, rect: { ...asset.rect, h: trimmedHeight } };
}

function normalizedFragmentText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, '').replace(/[.,;:()[\]{}]/g, '');
}

function nestedPdfFragmentIds(doc: Doc): Set<string> {
  const result = new Set<string>();
  for (const candidate of doc.blocks) {
    // A short caption such as "TABLE IV" can geometrically sit inside a
    // larger PDF text aggregate for the table body.  It is still structural
    // content and may be the only stable caption anchor returned by Vision.
    if (candidate.type === 'caption') continue;
    const text = candidate.text?.trim() ?? '';
    const naturalWords = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    const fragmentLike = naturalWords <= 2
      && (text.length <= 16 || /[=+\-*/∑∫√≤≥≈≠⌈⌉λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(text));
    if (!fragmentLike) continue;
    const candidateText = normalizedFragmentText(text);
    const nested = physicalPages(candidate).some((pageIndex) => {
      const physicalCandidateRect = physicalRectOnPage(candidate, pageIndex);
      const candidateRects = [
        physicalCandidateRect,
        candidate.pageIndex === pageIndex ? candidate.rect : undefined,
      ].filter((rect): rect is Rect => Boolean(rect));
      if (!candidateRects.length) return false;
      return doc.blocks.some((other) => {
        if (other.id === candidate.id) return false;
        const otherRects = [
          physicalRectOnPage(other, pageIndex),
          other.pageIndex === pageIndex ? other.rect : undefined,
        ].filter((rect): rect is Rect => Boolean(rect));
        if (!otherRects.length) return false;
        const otherText = other.text ?? '';
        const otherWords = otherText.match(/[A-Za-z]{3,}/g)?.length ?? 0;
        if (otherWords < 3) return false;
        if (candidate.type === 'equation') {
          const otherHasMath = /[=+\-*/∑∫√≤≥≈≠⌈⌉λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(otherText);
          const otherContainsCandidate = candidateText.length >= 2
            && normalizedFragmentText(otherText).includes(candidateText);
          if (!otherHasMath && !otherContainsCandidate) return false;
        }
        return candidateRects.some((candidateRect) => {
          const area = Math.max(1, candidateRect.w * candidateRect.h);
          return otherRects.some((otherRect) => (
            otherRect.w * otherRect.h >= area * 2
            && intersectionArea(candidateRect, otherRect) / area >= 0.65
          ));
        });
      });
    });
    if (nested) result.add(candidate.id);
  }
  return result;
}

function withoutScatteredMathLines(source: string): string {
  const lines = source.split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, ' ').trim());
  const naturalWordCount = (line: string) => line.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  if (!lines.some((line) => naturalWordCount(line) >= 2)) return source.trim();
  const cleaned = lines
    .filter((line) => {
      if (!line) return false;
      if (naturalWordCount(line) >= 2) return true;
      if (line.length > 40) return true;
      return !(/[=+\-*/∑∫√≤≥≈≠⌈⌉λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(line)
        || /^(?:[A-Za-z]\s*){1,4}$/u.test(line));
    })
    .map((line) => {
      const firstWord = line.match(/[A-Za-z]{3,}/);
      if (!firstWord?.index) return line;
      const prefix = line.slice(0, firstWord.index);
      if (prefix.length > 20 || /^\s*\d+[.)]\s*$/.test(prefix)) return line;
      const fragmentPrefix = prefix.trim();
      if (!fragmentPrefix || /[A-Za-z]{3,}/.test(fragmentPrefix)) return line;
      return line.slice(firstWord.index);
    });
  return cleaned.join('\n').trim();
}

function nearVerifiedFormula(
  block: Doc['blocks'][number],
  assets: readonly DetectedAssetRegion[],
): boolean {
  return assets.some((asset) => {
    if (asset.kind !== 'formula') return false;
    const rect = physicalRectOnPage(block, asset.pageIndex);
    if (!rect) return false;
    const horizontalOverlap = Math.max(0, Math.min(
      rect.x + rect.w,
      asset.rect.x + asset.rect.w,
    ) - Math.max(rect.x, asset.rect.x));
    const verticalGap = Math.max(
      0,
      rect.y - (asset.rect.y + asset.rect.h),
      asset.rect.y - (rect.y + rect.h),
    );
    return horizontalOverlap >= Math.min(rect.w, asset.rect.w) * 0.1 && verticalGap <= 48;
  });
}

function isFormulaExtractionFragment(block: Doc['blocks'][number], asset: DetectedAssetRegion): boolean {
  if (asset.kind !== 'formula') return false;
  const rect = physicalRectOnPage(block, asset.pageIndex);
  if (!rect) return false;
  const text = block.text?.trim() ?? '';
  const naturalWords = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  if (naturalWords > 2 || !/[=+\-*/∑∫√≤≥≈≠⌈⌉λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(text)) return false;
  return intersectionArea(rect, asset.rect) / Math.max(1, rect.w * rect.h) >= 0.05;
}

function withoutAssetTextLines(
  block: Doc['blocks'][number],
  source: string,
  assets: readonly DetectedAssetRegion[],
): string {
  if (!block.characterRects?.length || !assets.length) return source;
  const blockText = block.text ?? '';
  const sourceOffset = blockText.indexOf(source);
  if (sourceOffset >= 0) {
    const masked = new Uint8Array(source.length);
    for (const character of block.characterRects) {
      const centerX = character.rect.x + character.rect.w / 2;
      const centerY = character.rect.y + character.rect.h / 2;
      const insideAsset = assets.some((asset) => (
        character.pageIndex === asset.pageIndex
        && centerX >= asset.rect.x && centerX <= asset.rect.x + asset.rect.w
        && centerY >= asset.rect.y && centerY <= asset.rect.y + asset.rect.h
      ));
      if (!insideAsset) continue;
      const localStart = character.sourceIndex - sourceOffset;
      const localEnd = localStart + character.ch.length;
      for (let index = Math.max(0, localStart); index < Math.min(source.length, localEnd); index += 1) {
        masked[index] = 1;
      }
    }
    if (masked.some((value) => value === 1)) {
      let cleaned = '';
      for (let index = 0; index < source.length; index += 1) {
        cleaned += masked[index] ? ' ' : source[index];
      }
      return cleaned
        .split(/\r?\n/)
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    // The source can be a cleaned suffix of the raw block.  When its exact
    // offset is known and no character in that suffix intersects an asset,
    // the coordinate mask is complete; falling through would compare local
    // line offsets with raw-block indexes and could delete valid prose.
    return source;
  }
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
      if (character.pageIndex !== asset.pageIndex) return false;
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
  // Symbol-font text embedded in figures is occasionally decoded by PDF.js as
  // Syriac/Arabic-extension or Indic glyphs.  Once such a line appears near
  // the end of an otherwise English prose block, remove it together with the
  // immediately preceding short diagram labels.  The pixels remain available
  // through the immutable figure asset; only the duplicate text layer is
  // discarded here.
  const suspiciousGlyph = /[\u0700-\u08ff\u0a80-\u0bff]/u;
  const firstSuspicious = lines.findIndex((line) => suspiciousGlyph.test(line));
  if (firstSuspicious > 0) {
    const diagramLabel = (value: string): boolean => {
      const line = value.trim();
      if (!line || line.length > 64 || /[.!?;:]\s*$/.test(line)) return false;
      if (/^(?:def\s+\w+\s*\(|return\b|pre-?processing\b)/i.test(line)) return true;
      if (/^(?:[A-Z][A-Z0-9-]*)(?:\s+[A-Z][A-Z0-9-]*){0,5}$/.test(line)) return true;
      return /^(?:POLY|MSM|INTT|NTT|PMULT|PADD|PDBL|MUX)(?:\s+.*)?$/i.test(line);
    };
    let cut = firstSuspicious;
    while (cut > 0 && diagramLabel(lines[cut - 1]!)) cut -= 1;
    return lines.slice(0, cut).join('\n').trim();
  }

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
  if (candidate.rect.h > Math.max(36, anchor.rect.h * 4)) return false;
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

interface FormulaGlyphCluster {
  rect: Rect;
  fragmentIds: Set<string>;
}

function formulaGlyphCluster(
  doc: Doc,
  anchor: Doc['blocks'][number],
  unitIds: ReadonlySet<string>,
): FormulaGlyphCluster | undefined {
  if (!anchor.characterRects?.length) return undefined;
  const verticalPad = Math.max(18, anchor.rect.h * 1.8);
  const bandTop = anchor.rect.y - verticalPad;
  const bandBottom = anchor.rect.y + anchor.rect.h + verticalPad;
  const candidates = doc.blocks.flatMap((candidate) => {
    if (
      candidate.pageIndex !== anchor.pageIndex
      || !['paragraph', 'equation'].includes(candidate.type)
    ) return [];
    const text = candidate.text?.trim() ?? '';
    const naturalWords = text.match(/[A-Za-z]{3,}/g) ?? [];
    if (!text || text.length > 500 || naturalWords.length > 4) return [];
    if (!/[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(text)) return [];
    const characters = (candidate.characterRects ?? []).filter((character) => (
      character.pageIndex === anchor.pageIndex
      && character.ch.trim().length > 0
      && character.rect.y < bandBottom
      && character.rect.y + character.rect.h > bandTop
    ));
    const characterRect = unionRects(characters.map((character) => character.rect));
    const clipped = characterRect ?? (
      candidate.rect.y < bandBottom && candidate.rect.y + candidate.rect.h > bandTop
        ? {
            x: candidate.rect.x,
            y: Math.max(candidate.rect.y, bandTop),
            w: candidate.rect.w,
            h: Math.min(candidate.rect.y + candidate.rect.h, bandBottom) - Math.max(candidate.rect.y, bandTop),
          }
        : undefined
    );
    return clipped ? [{ block: candidate, rect: clipped }] : [];
  });
  if (candidates.length < 2) return undefined;

  let combined = { ...anchor.rect };
  const fragmentIds = new Set<string>();
  const remaining = [...candidates];
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index]!;
      const horizontalGap = Math.max(
        0,
        candidate.rect.x - (combined.x + combined.w),
        combined.x - (candidate.rect.x + candidate.rect.w),
      );
      const verticalGap = Math.max(
        0,
        candidate.rect.y - (combined.y + combined.h),
        combined.y - (candidate.rect.y + candidate.rect.h),
      );
      if (horizontalGap > 36 || verticalGap > 18) continue;
      combined = unionRect(combined, candidate.rect);
      if (candidate.block.id !== anchor.id && unitIds.has(candidate.block.id)) {
        fragmentIds.add(candidate.block.id);
      }
      remaining.splice(index, 1);
      expanded = true;
    }
  }
  if (!fragmentIds.size || combined.w > doc.pages[anchor.pageIndex]!.width * 0.8 || combined.h > 64) {
    return undefined;
  }
  return {
    rect: {
      x: Math.max(0, combined.x - 3),
      y: Math.max(0, combined.y - 2),
      w: combined.w + 6,
      h: combined.h + 4,
    },
    fragmentIds,
  };
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

function isNaturalLanguageFormulaBlock(source: string | undefined): boolean {
  const text = source?.replace(/\s+/g, ' ').trim() ?? '';
  if (text.length < 45) return false;
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  const functionWords = text.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi) ?? [];
  return words.length >= 5 && functionWords.length >= 2;
}

interface InlineFormulaFragment {
  start: number;
  end: number;
  before: string;
  after: string;
  pageIndex: number;
  rect: Rect;
}

function inlineFormulaFragment(
  block: Doc['blocks'][number],
  source: string,
): InlineFormulaFragment | undefined {
  if (!block.characterRects?.length) return undefined;
  const equalsIndex = source.indexOf('=');
  if (equalsIndex < 1) return undefined;
  const left = source.slice(0, equalsIndex).match(
    /\b([A-Za-z](?:\s+[A-Za-z]){1,2}|[A-Za-z][A-Za-z0-9_]*(?:\s*[′'])?(?:\s+def)?(?:\s+[23])?)\s*$/,
  );
  if (!left?.index && left?.index !== 0) return undefined;
  const formulaStart = left.index;
  const delimiter = source.slice(equalsIndex + 1).match(
    /\s*(?:[,;]\s*(?=(?:where|with|which|for|respectively|and)\b)|(?=(?:where|with|which|whose|into|from|using|through|under|over|is|are|was|were|can|could|will|would|shall|should|may|might|must|represents?|denotes?|equals?)\b)|[.]\s*(?=[A-Z]|$))/,
  );
  if (!delimiter?.index && delimiter?.index !== 0) return undefined;
  const formulaEnd = equalsIndex + 1 + delimiter.index;
  const formulaText = source.slice(formulaStart, formulaEnd).trim();
  if (formulaText.length < 5 || formulaText.length > 100) return undefined;
  const rawFormula = source.slice(formulaStart, formulaEnd);
  const leadingWhitespace = rawFormula.length - rawFormula.trimStart().length;
  const formulaSourceStart = formulaStart + leadingWhitespace;
  const formulaSourceText = rawFormula.trim();
  const sourceOffset = (block.text ?? '').indexOf(source);
  // Source cleaners can remove scattered PDF fragments before this pass. In
  // that case the whole cleaned paragraph no longer has a direct offset in the
  // raw block, while the mathematical substring itself still does. Resolve the
  // exact formula against raw text as a guarded fallback so its character
  // geometry remains usable after cleaning.
  const absoluteFormulaStart = sourceOffset >= 0
    ? sourceOffset + formulaSourceStart
    : (block.text ?? '').indexOf(formulaSourceText);
  if (absoluteFormulaStart < 0) return undefined;
  const absoluteFormulaEnd = absoluteFormulaStart + formulaSourceText.length;
  const characters = block.characterRects.filter((character) => (
    character.sourceIndex >= absoluteFormulaStart
    && character.sourceIndex < absoluteFormulaEnd
    && character.ch.trim().length > 0
  ));
  const physical = unionRects(characters.map((character) => character.rect));
  if (!physical) return undefined;
  const page = characters[0]?.pageIndex;
  if (page === undefined || characters.some((character) => character.pageIndex !== page)) return undefined;
  const physicalBottom = physical.y + physical.h;
  const nextLineTop = Math.min(
    ...(block.characterRects ?? [])
      .filter((character) => (
        character.pageIndex === page
        && character.sourceIndex >= absoluteFormulaEnd
        && character.ch.trim().length > 0
        && character.rect.y >= physicalBottom + 0.5
        && character.rect.x < physical.x + physical.w + 3
        && character.rect.x + character.rect.w > physical.x - 3
      ))
      .map((character) => character.rect.y),
  );
  const bottomPad = Number.isFinite(nextLineTop)
    ? Math.max(0, Math.min(7, nextLineTop - physicalBottom - 1))
    : 7;
  return {
    start: formulaStart,
    end: formulaEnd,
    before: source.slice(0, formulaStart).trim().replace(/[,;:]\s*$/, ''),
    after: source.slice(formulaEnd).trim().replace(/^[,;:]\s*/, ''),
    pageIndex: page,
    // Subscripts and large operators can be assigned to a neighbouring PDF
    // text block even when their visible ink belongs to this equation line.
    // Do not add an upper pad: the preceding prose baseline is often only one
    // line above and even two PDF points can capture its descenders.
    // Most detached mathematical glyphs (limits/subscripts) sit below the main
    // formula baseline, so reserve the larger allowance on the bottom instead.
    rect: {
      x: Math.max(0, physical.x - 3),
      y: Math.max(0, physical.y),
      w: physical.w + 6,
      h: physical.h + bottomPad,
    },
  };
}

function normalizePdfNumericSpacing(source: string): string {
  return source
    // PDF.js may emit a decimal point and its digits as separate glyph runs.
    // Canonicalizing only digit-surrounded punctuation keeps prose and formula
    // punctuation intact while preventing `2 . 08` from becoming four
    // independent protected tokens that are later appended to `2.08`.
    .replace(/(?<=\d)\s*[.]\s*(?=\d)/g, '.')
    .replace(/(?<=\d)\s*([%‰×])\s*/g, '$1');
}

const MAX_TRANSLATION_UNIT_CHARACTERS = 1_800;

function splitOversizedSourceText(source: string): string[] {
  const parts: string[] = [];
  let remaining = source.trim();
  while (remaining.length > MAX_TRANSLATION_UNIT_CHARACTERS) {
    const window = remaining.slice(0, MAX_TRANSLATION_UNIT_CHARACTERS + 1);
    let cut = -1;
    const boundary = /(?:[.!?。！？](?:["')\]]*)\s+|\n+)/g;
    for (const match of window.matchAll(boundary)) {
      const end = (match.index ?? 0) + match[0].length;
      if (end >= MAX_TRANSLATION_UNIT_CHARACTERS * 0.5) cut = end;
    }
    if (cut < 0) cut = window.lastIndexOf(' ', MAX_TRANSLATION_UNIT_CHARACTERS);
    if (cut < MAX_TRANSLATION_UNIT_CHARACTERS * 0.5) cut = MAX_TRANSLATION_UNIT_CHARACTERS;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
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

function isAlgorithmCaptionText(source: string | undefined): boolean {
  return /^\s*(?:algorithm|算法)\s*\d+[A-Za-z]?\b/i.test(source ?? '');
}

function looksLikeAlgorithmBodyBlock(block: Doc['blocks'][number]): boolean {
  if (block.type === 'equation') return true;
  const text = block.text?.trim() ?? '';
  if (!text) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numberedLines = lines.filter((line) => /^\d+\s*:/.test(line)).length;
  const algorithmKeywords = lines.filter((line) => (
    /^(?:require|ensure|input|output|return|for\b|while\b|if\b|else\b|end\b|\/\/)/i.test(line)
  )).length;
  const mathematicalLines = lines.filter((line) => /[←→∑≫≪⌈⌉]|\b(?:do|then|end for|end if)\b/i.test(line)).length;
  return numberedLines + algorithmKeywords + mathematicalLines >= Math.max(1, Math.ceil(lines.length * 0.25));
}

function isAlgorithmProseBoundary(block: Doc['blocks'][number]): boolean {
  if (block.type === 'caption' || block.type === 'section' || block.type === 'title') return true;
  const text = block.text?.trim() ?? '';
  if (text.length < 80) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';
  const firstLineIsAlgorithm = /^\d+\s*:|^(?:require|ensure|input|output|return|for\b|while\b|if\b|else\b|end\b|\/\/)/i.test(firstLine);
  const firstLineWords = firstLine.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  const firstLineFunctionWords = firstLine.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|while)\b/gi)?.length ?? 0;
  // PDF.js can merge the prose immediately after an algorithm with numbered
  // instructions that physically continue on the next page. The current-page
  // leading line is authoritative: do not let later instruction lines turn
  // already-started prose back into an algorithm crop.
  if (!firstLineIsAlgorithm && firstLineWords >= 8 && firstLineFunctionWords >= 2) return true;
  const hasNumberedInstruction = lines.some((line) => /^\d+\s*:/.test(line));
  const hasAlgorithmHeader = /^(?:require|ensure|input|output)\s*:/i.test(lines[0] ?? '');
  if (hasNumberedInstruction || hasAlgorithmHeader) return false;
  const naturalWords = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  const functionWords = text.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi)?.length ?? 0;
  return naturalWords >= 12 && functionWords >= 3;
}

function detectedAlgorithmAssets(doc: Doc): DetectedAssetRegion[] {
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  const assets: DetectedAssetRegion[] = [];
  for (const caption of doc.semanticUnits.filter((unit) => (
    unit.kind === 'caption' && isAlgorithmCaptionText(unit.sourceText)
  ))) {
    const captionBlock = blocks.get(caption.id);
    if (!captionBlock) continue;
    const captionBottom = captionBlock.rect.y + captionBlock.rect.h;
    const candidates = doc.blocks
      .filter((block) => block.pageIndex === captionBlock.pageIndex && block.rect.y >= captionBottom - 1)
      .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
    const firstFollowingBoundary = candidates.find((block) => (
      block.rect.y >= captionBottom + 8
      && isAlgorithmProseBoundary(block)
    ));
    const stopY = firstFollowingBoundary?.rect.y ?? Number.POSITIVE_INFINITY;
    const algorithmLikeBlocks = candidates.filter((block) => (
      block.rect.y < stopY
      && looksLikeAlgorithmBodyBlock(block)
    ));
    const bodyBlocks: typeof algorithmLikeBlocks = [];
    let clusterBottom = captionBottom + 4;
    for (const block of algorithmLikeBlocks) {
      // Formula fragments belonging to a later figure or body section can
      // resemble pseudocode. Algorithm lines themselves form a vertically
      // continuous cluster, so stop before a detached second cluster.
      if (bodyBlocks.length >= 2 && block.rect.y > clusterBottom + 32) break;
      bodyBlocks.push(block);
      clusterBottom = Math.max(clusterBottom, block.rect.y + block.rect.h);
    }
    if (bodyBlocks.length < 2) continue;
    const inkLeft = Math.min(captionBlock.rect.x, ...bodyBlocks.map((block) => block.rect.x));
    const inkRight = Math.max(
      captionBlock.rect.x + captionBlock.rect.w,
      ...bodyBlocks.map((block) => block.rect.x + block.rect.w),
    );
    const bodyBottom = Math.max(...bodyBlocks.map((block) => block.rect.y + block.rect.h));
    const top = captionBottom + 2;
    const bottom = Number.isFinite(stopY)
      ? Math.min(stopY - 3, bodyBottom + 8)
      : bodyBottom + 8;
    if (bottom <= top + 12) continue;
    const pageWidth = doc.pages[captionBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const layoutRegion = doc.layoutRegions.find((region) => region.id === caption.layoutRegionId);
    const wideRegion = Boolean(layoutRegion && layoutRegion.bounds.w >= pageWidth * 0.55);
    const cropLeft = Math.max(0, wideRegion
      ? Math.min(inkLeft - 2, layoutRegion!.bounds.x - 2)
      : inkLeft - 2);
    const cropRight = Math.min(pageWidth, wideRegion
      ? Math.max(inkRight + 2, layoutRegion!.bounds.x + layoutRegion!.bounds.w + 2)
      : inkRight + 2);
    const bodyWidth = cropRight - cropLeft;
    assets.push({
      id: `${caption.id}-body-asset`,
      kind: 'code',
      pageIndex: captionBlock.pageIndex,
      rect: { x: cropLeft, y: top, w: bodyWidth, h: bottom - top },
      // PDF text extraction sometimes labels a page-spanning algorithm
      // caption as a column item. The physical crop is authoritative here:
      // rendering a wide algorithm at column width makes the pseudocode
      // illegible even though all of its pixels were preserved.
      widthMode: wideRegion || bodyWidth >= pageWidth * 0.55 ? 'span' : captionBlock.widthMode,
      captionUnitId: caption.id,
    });
  }
  return assets;
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
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  let units: SemanticUnit[] = doc.semanticUnits.map((unit) => ({
    ...unit,
    sourceBlockId: unit.sourceBlockId ?? (blocks.has(unit.id) ? unit.id : undefined),
    protectedTokens: [...unit.protectedTokens],
  }));
  const assetRegions: DetectedAssetRegion[] = [];
  const algorithmAssets = detectedAlgorithmAssets(doc);
  const algorithmPages = new Set(algorithmAssets.map((asset) => asset.pageIndex));
  const verifiedAssetRegions = (options.verifiedAssetRegions ?? [])
    // Vision occasionally mistakes an ordinary paragraph below an algorithm
    // for code. Once a caption-anchored algorithm body is reconstructed from
    // the PDF text geometry, prefer that deterministic crop for this page.
    .filter((asset) => asset.kind !== 'code' || !algorithmPages.has(asset.pageIndex))
    .filter((asset) => !proseHeavyFormulaRegion(doc, asset))
    .map((asset) => trimTableBeforeFollowingProse(doc, {
      ...asset,
      rect: { ...asset.rect },
    }))
    .concat(algorithmAssets);
  const verifiedCaptionIds = new Set(verifiedAssetRegions
    .map((asset) => asset.captionUnitId)
    .filter((id): id is string => Boolean(id)));
  for (const region of regions) {
    const visionLayout = options.pageLayouts?.get(region.sourcePage);
    if (visionLayout === 'single') region.mode = 'single';
    else if (visionLayout === 'double' && region.mode !== 'full-width') region.mode = 'double';
  }
  const furnitureIds = detectedPageFurnitureIds(doc);
  const repeatedFurnitureLines = repeatedEmbeddedFurnitureLines(doc);
  const nestedFragmentIds = nestedPdfFragmentIds(doc);
  if (nestedFragmentIds.size) {
    units = units.filter((unit) => !nestedFragmentIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !nestedFragmentIds.has(unitId));
    }
  }
  const formulaFragmentIds = new Set(doc.blocks
    .filter((block) => verifiedAssetRegions.some((asset) => isFormulaExtractionFragment(block, asset)))
    .map((block) => block.id));
  if (formulaFragmentIds.size) {
    units = units.filter((unit) => !formulaFragmentIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !formulaFragmentIds.has(unitId));
    }
  }
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
    // Apply the coordinate mask while source offsets still refer to the raw
    // PDF text.  Later cleaners can remove or rearrange lines, after which a
    // sourceIndex can no longer be mapped back reliably.
    const assetCleaned = withoutAssetTextLines(
      block,
      unit.sourceText,
      verifiedAssetRegions.filter((asset) => asset.captionUnitId !== unit.id),
    );
    const geometryCleaned = withoutEmbeddedMarginFurniture(doc, block, assetCleaned);
    const labelsCleaned = withoutTrailingVisualLabelCluster(geometryCleaned);
    const crossesPages = new Set((block.fragments ?? []).map((fragment) => fragment.pageIndex)).size > 1;
    // A numbered heading can sit next to a display formula, but its leading
    // section number is structural content rather than a scattered math
    // fragment (for example, `2.4 Sparse Matrix`). Never run the heuristic
    // formula-line scrubber over headings, otherwise the number is silently
    // removed before it can be protected and translated.
    const fragmentsCleaned = unit.kind !== 'heading'
      && (crossesPages || block.rect.h <= 24 || nearVerifiedFormula(block, verifiedAssetRegions))
      ? withoutScatteredMathLines(labelsCleaned)
      : labelsCleaned;
    const cleaned = withoutRepeatedEmbeddedFurniture(doc, block, fragmentsCleaned, repeatedFurnitureLines);
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

  // A body sentence can continue on a new PDF text line with a citation such
  // as `[34] as the basic building block ...`. The line classifier sees the
  // leading bracket and labels it as a bibliography entry even though it is
  // still ordinary prose. Real bibliography units are parented to the
  // References heading; recover only unparented, sentence-like false matches.
  units = units.map((unit) => {
    if (unit.kind !== 'reference' || unit.parentId || !unit.sourceText) return unit;
    const wordsAfterCitation = unit.sourceText
      .replace(/^\s*\[\d+\]\s*/, '')
      .match(/[A-Za-z]{3,}/g)?.length ?? 0;
    return wordsAfterCitation >= 5 ? { ...unit, kind: 'paragraph' as const } : unit;
  });

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

  // A PDF text block can contain translatable prose around one or more inline
  // formulas. Preserve each expression as source pixels and keep the prose as
  // independent translation units around it. PDF.js frequently classifies the
  // whole paragraph as prose even when subscripts and large operators are
  // emitted out of reading order, so geometry (not only block type) is the
  // deciding evidence here.
  for (const unit of [...units]) {
    if (!['formula', 'paragraph', 'abstract', 'list-item'].includes(unit.kind)
      || !isNaturalLanguageFormulaBlock(unit.sourceText)) continue;
    const block = blocks.get(unit.id);
    if (!block?.characterRects?.length || !unit.sourceText) continue;
    if (verifiedAssetRegions.some((asset) => materiallyCovered(block, asset))) continue;
    const fragments: Array<InlineFormulaFragment & { absoluteStart: number; absoluteEnd: number }> = [];
    let consumed = 0;
    while (consumed < unit.sourceText.length && fragments.length < 8) {
      const remainder = unit.sourceText.slice(consumed);
      const fragment = inlineFormulaFragment(block, remainder);
      if (!fragment) break;
      const absoluteStart = consumed + fragment.start;
      const absoluteEnd = consumed + fragment.end;
      if (absoluteEnd <= absoluteStart || absoluteEnd <= consumed) break;
      fragments.push({ ...fragment, absoluteStart, absoluteEnd });
      consumed = absoluteEnd;
    }
    if (!fragments.length) continue;

    const replacementUnits: SemanticUnit[] = [];
    let cursor = 0;
    const pushText = (text: string, id: string) => {
      const cleaned = text.trim().replace(/^[,;:]\s*/, '').replace(/[,;:]\s*$/, '');
      if (!cleaned) return;
      replacementUnits.push({
        ...unit,
        id,
        kind: unit.kind === 'formula' ? 'paragraph' : unit.kind,
        sourceText: cleaned,
        protectedTokens: extractProtectedTokens(cleaned),
        order: unit.order + replacementUnits.length * 0.0001,
        assetId: undefined,
      });
    };
    for (const [index, fragment] of fragments.entries()) {
      const textId = index === 0
        ? `${unit.id}-inline-before`
        : `${unit.id}-inline-between-${index}`;
      pushText(unit.sourceText.slice(cursor, fragment.absoluteStart), textId);
      const assetId = index === 0
        ? `${unit.id}-inline-formula`
        : `${unit.id}-inline-formula-${index + 1}`;
      replacementUnits.push({
        ...unit,
        id: assetId,
        kind: 'formula',
        sourceText: undefined,
        protectedTokens: [],
        assetId,
        order: unit.order + replacementUnits.length * 0.0001,
      });
      assetRegions.push({
        id: assetId,
        kind: 'formula',
        pageIndex: fragment.pageIndex,
        rect: fragment.rect,
        widthMode: block.widthMode,
      });
      cursor = fragment.absoluteEnd;
    }
    pushText(unit.sourceText.slice(cursor), `${unit.id}-inline-after`);
    const unitIndex = units.indexOf(unit);
    units.splice(unitIndex, 1, ...replacementUnits);
    const region = regions.find((candidate) => candidate.id === unit.layoutRegionId);
    const regionIndex = region?.orderedUnitIds.indexOf(unit.id) ?? -1;
    if (region && regionIndex >= 0) {
      region.orderedUnitIds.splice(regionIndex, 1, ...replacementUnits.map((candidate) => candidate.id));
    }
  }

  // Display formulas are often emitted by PDF.js as one small equation anchor
  // plus several late, out-of-order text blocks for limits and subscripts.
  // Reconstruct the visual row from character geometry and remove those
  // duplicate text-layer fragments before pagination.
  const clusteredFormulaRects = new Map<string, Rect>();
  const clusteredFormulaFragmentIds = new Set<string>();
  const currentUnitIds = new Set(units.map((unit) => unit.id));
  for (const unit of units) {
    if (unit.kind !== 'formula' || clusteredFormulaFragmentIds.has(unit.id)) continue;
    const block = blocks.get(unit.id);
    if (!block || verifiedAssetRegions.some((asset) => materiallyCovered(block, asset))) continue;
    const cluster = formulaGlyphCluster(doc, block, currentUnitIds);
    if (!cluster) continue;
    clusteredFormulaRects.set(unit.id, cluster.rect);
    cluster.fragmentIds.forEach((id) => clusteredFormulaFragmentIds.add(id));
  }
  if (clusteredFormulaFragmentIds.size) {
    units = units.filter((unit) => !clusteredFormulaFragmentIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((id) => !clusteredFormulaFragmentIds.has(id));
    }
  }

  for (const unit of units) {
    if (unit.kind !== 'formula' && unit.kind !== 'code' && unit.kind !== 'page-furniture') continue;
    if (unit.assetId && assetRegions.some((asset) => asset.id === unit.assetId)) continue;
    const block = blocks.get(unit.id);
    if (!block) throw new Error(`不可变资产 ${unit.id} 缺少源坐标`);
    if (verifiedAssetRegions.some((asset) => materiallyCovered(block, asset))) continue;
    if (unit.kind === 'formula' && isNaturalLanguageFormulaBlock(unit.sourceText)) {
      unit.kind = 'paragraph';
      delete unit.assetId;
      continue;
    }
    let rect = unit.kind === 'formula'
      ? clusteredFormulaRects.get(unit.id) ?? doc.blocks
        .filter((candidate) => formulaContinuation(block, candidate))
        .reduce((combined, candidate) => unionRect(combined, candidate.rect), { ...block.rect })
      : { ...block.rect };
    let previousToClean: SemanticUnit | undefined;
    let cleanedPrevious: string | undefined;
    if (unit.kind === 'formula') {
      const pageWidth = doc.pages[block.pageIndex]?.width ?? doc.meta.paperWidth;
      const previousBlock = doc.blocks
        .filter((candidate) => (
          candidate.id !== block.id
          && candidate.pageIndex === block.pageIndex
          && sameVisualColumn(candidate, block, pageWidth)
          && candidate.rect.y + candidate.rect.h <= block.rect.y + 2
          && block.rect.y - (candidate.rect.y + candidate.rect.h) <= 24
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
        if (formulaTail) rect = unionRect(rect, formulaTail);
        previousToClean = previous;
        cleanedPrevious = cleaned;
      }
    }
    const candidateAsset: DetectedAssetRegion = {
      id: unit.assetId ?? unit.id,
      kind: unit.kind,
      pageIndex: block.pageIndex,
      rect,
      widthMode: block.widthMode,
    };
    if (unit.kind === 'formula') {
      const page = doc.pages[block.pageIndex];
      if (!page) throw new Error(`不可变资产 ${unit.id} 缺少页面尺寸`);
      const intersecting = doc.blocks.filter((candidate) => (
        candidate.pageIndex === block.pageIndex
        && candidate.rect.x < rect.x + rect.w
        && candidate.rect.x + candidate.rect.w > rect.x
        && candidate.rect.y < rect.y + rect.h
        && candidate.rect.y + candidate.rect.h > rect.y
      ));
      const geometry = validateImmutableRegion(candidateAsset, page, intersecting);
      if (geometry.issues.includes('body-prose-density')) {
        unit.kind = 'paragraph';
        delete unit.assetId;
        continue;
      }
    }
    assetRegions.push(candidateAsset);
    if (previousToClean && cleanedPrevious !== undefined) previousToClean.sourceText = cleanedPrevious;
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
    let caption = asset.captionUnitId ? units.find((unit) => unit.id === asset.captionUnitId) : undefined;
    if (asset.captionUnitId && !caption) {
      const sourceCaption = doc.semanticUnits.find((unit) => (
        unit.id === asset.captionUnitId && Boolean(unit.sourceText?.trim())
      ));
      if (!sourceCaption) throw new Error(`Vision 资产 ${asset.id} 缺少图表注 ${asset.captionUnitId}`);
      // A neighbouring immutable crop can overlap a caption's PDF glyph box
      // closely enough for an earlier generic cleanup pass to remove it. The
      // source semantic caption remains authoritative, so restore it instead
      // of discarding the translated Figure/Table/Algorithm label.
      caption = {
        ...sourceCaption,
        protectedTokens: extractProtectedTokens(sourceCaption.sourceText!),
      };
      units.push(caption);
      const captionRegion = regions.find((candidate) => candidate.id === caption!.layoutRegionId)
        ?? regions.find((candidate) => candidate.sourcePage === asset.pageIndex);
      if (captionRegion && !captionRegion.orderedUnitIds.includes(caption.id)) {
        captionRegion.orderedUnitIds.push(caption.id);
      }
    }
    const coveredBlocks = doc.blocks.filter((block) => block.id !== asset.captionUnitId && materiallyCovered(block, asset));
    const coveredIds = new Set(coveredBlocks.map((block) => block.id));
    verifiedCaptionIds.forEach((captionId) => coveredIds.delete(captionId));
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
    const spatialRegion = regions
      .filter((candidate) => (
        candidate.sourcePage === asset.pageIndex
        && centerX >= candidate.bounds.x - 8
        && centerX <= candidate.bounds.x + candidate.bounds.w + 8
        && centerY >= candidate.bounds.y - 24
        && centerY <= candidate.bounds.y + candidate.bounds.h + 24
      ))
      .sort((left, right) => (
        right.bounds.w * right.bounds.h - left.bounds.w * left.bounds.h
      ))[0];
    const region = (caption ? regions.find((candidate) => candidate.id === caption.layoutRegionId) : undefined)
      ?? (asset.kind === 'formula' ? spatialRegion : undefined)
      ?? coveredRegion
      ?? memberPageRegion
      ?? spatialRegion
      ?? regions.find((candidate) => candidate.sourcePage === asset.pageIndex);
    if (!region) throw new Error(`Vision 资产 ${asset.id} 缺少版式区域`);

    const coveredOrder = coveredUnits.length ? Math.min(...coveredUnits.map((unit) => unit.order)) : undefined;
    const regionPhysicalUnits = region.orderedUnitIds.flatMap((unitId) => {
      const unit = units.find((candidate) => candidate.id === unitId);
      const block = blocks.get(unitId);
      const rect = block ? physicalRectOnPage(block, asset.pageIndex) : undefined;
      return unit && rect ? [{ unit, rect }] : [];
    });
    const previous = regionPhysicalUnits
      .filter((candidate) => candidate.rect.y + candidate.rect.h <= asset.rect.y + 2)
      .sort((left, right) => right.rect.y + right.rect.h - (left.rect.y + left.rect.h))[0];
    const next = regionPhysicalUnits
      .filter((candidate) => candidate.rect.y >= asset.rect.y + asset.rect.h - 2)
      .sort((left, right) => left.rect.y - right.rect.y)[0];
    const physicalOrder = previous && next
        ? (previous.unit.order + next.unit.order) / 2
        : previous
          ? previous.unit.order + 0.1
          : next
            ? next.unit.order - 0.1
            : undefined;
    const order = caption
      ? caption.order + (asset.kind === 'figure' ? -0.1 : 0.1)
      : physicalOrder ?? coveredOrder ?? Math.max(0, ...units.map((unit) => unit.order)) + 0.1;
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
    const representedPages = new Set([
      block.pageIndex,
      ...(block.characterRects ?? []).map((character) => character.pageIndex),
    ]);
    const pageAssets = assetRegions.filter((asset) => (
      representedPages.has(asset.pageIndex)
      && asset.id !== unit.id
      && asset.captionUnitId !== unit.id
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

  const protectedCaptionIds = new Set(assetRegions
    .map((asset) => asset.captionUnitId)
    .filter((id): id is string => Boolean(id)));
  for (const asset of assetRegions) {
    const coveredIds = new Set(doc.blocks
      .filter((block) => block.id !== asset.captionUnitId && materiallyCovered(block, asset))
      .map((block) => block.id));
    protectedCaptionIds.forEach((captionId) => coveredIds.delete(captionId));
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
      const rect = [asset.rect.x, asset.rect.y, asset.rect.w, asset.rect.h]
        .map((value) => Number(value.toFixed(2))).join(',');
      throw new Error(`不可变资产 ${asset.id} 几何校验失败（第 ${asset.pageIndex + 1} 页：${geometry.issues.join(', ')}；bbox=${rect}）`);
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

  // Numeric normalization must happen after every coordinate-based crop.
  // Earlier normalization changes source offsets and would make the original
  // PDF character rectangles unusable for inline formula extraction.
  for (const unit of units) {
    if (!unit.sourceText || unit.kind === 'reference') continue;
    const normalized = normalizePdfNumericSpacing(unit.sourceText);
    if (normalized === unit.sourceText) continue;
    unit.sourceText = normalized;
    unit.protectedTokens = extractProtectedTokens(normalized);
  }

  for (const unit of [...units]) {
    if (!unit.sourceText || !['paragraph', 'abstract', 'list-item'].includes(unit.kind)) continue;
    const parts = splitOversizedSourceText(unit.sourceText);
    if (parts.length < 2) continue;
    const children = parts.map((sourceText, index): SemanticUnit => ({
      ...unit,
      id: `${unit.id}-part-${index + 1}`,
      parentId: unit.id,
      sourceText,
      protectedTokens: extractProtectedTokens(sourceText),
      order: unit.order + (index + 1) / (parts.length + 1) / 1_000,
    }));
    const unitIndex = units.indexOf(unit);
    units.splice(unitIndex, 1, ...children);
    const region = regions.find((candidate) => candidate.id === unit.layoutRegionId);
    const regionIndex = region?.orderedUnitIds.indexOf(unit.id) ?? -1;
    if (region && regionIndex >= 0) {
      region.orderedUnitIds.splice(regionIndex, 1, ...children.map((child) => child.id));
    }
  }

  return {
    regions,
    units: units.sort((left, right) => left.order - right.order),
    assetRegions,
  };
}
