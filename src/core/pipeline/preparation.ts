import type {
  CharacterRect,
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

function isAuthorBiographyPage(doc: Doc, pageIndex: number): boolean {
  const text = doc.blocks
    .filter((block) => block.pageIndex === pageIndex)
    .map((block) => block.text ?? '')
    .join('\n');
  return (text.match(/\breceived\b[\s\S]{0,160}?\bdegree\b/gi) ?? []).length >= 3;
}

function isPortraitAsset(doc: Doc, asset: DetectedAssetRegion): boolean {
  if (asset.kind !== 'figure' || asset.captionUnitId) return false;
  const page = doc.pages[asset.pageIndex];
  if (!page) return false;
  const widthRatio = asset.rect.w / page.width;
  const heightRatio = asset.rect.h / page.height;
  const aspect = asset.rect.w / Math.max(1, asset.rect.h);
  return widthRatio >= 0.08 && widthRatio <= 0.22
    && heightRatio >= 0.08 && heightRatio <= 0.22
    && aspect >= 0.55 && aspect <= 1.5;
}

function authorPortraitPages(doc: Doc, assets: readonly DetectedAssetRegion[]): Set<number> {
  const counts = new Map<number, number>();
  for (const asset of assets) {
    if (!isPortraitAsset(doc, asset) || !isAuthorBiographyPage(doc, asset.pageIndex)) continue;
    counts.set(asset.pageIndex, (counts.get(asset.pageIndex) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count >= 3).map(([pageIndex]) => pageIndex));
}

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
      const titleTerms = unit.kind === 'title'
        ? [
            unit.sourceText!.match(/^\s*([A-Z][A-Za-z0-9-]{2,})\s*:/)?.[1],
            ...(unit.sourceText!.match(/\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]{2,})*\b/g) ?? []),
          ].filter((term): term is string => Boolean(term))
        : [];
      return {
        blockId: unit.id,
        kind: translationKind(unit.kind),
        source: unit.sourceText!,
        alignmentMode: candidates.mode,
        sourceSentences: candidates.sentences,
        protectedTokens: [...new Set([
          ...extractProtectedTokens(unit.sourceText!),
          ...titleTerms,
        ])],
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

function mergeFirstPageTitleContinuations(
  doc: Doc,
  units: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  const title = units.find((unit) => unit.kind === 'title' && Boolean(unit.sourceText));
  const titleBlock = title ? blocks.get(title.sourceBlockId ?? title.id) : undefined;
  if (!title?.sourceText || !titleBlock || titleBlock.pageIndex !== 0) return units;
  const titleBottom = titleBlock.rect.y + titleBlock.rect.h;
  const pageWidth = doc.pages[0]?.width ?? doc.meta.paperWidth;
  const continuations = units.filter((unit) => {
    if (unit.id === title.id || unit.kind !== 'paragraph' || !unit.sourceText || unit.parentId) return false;
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    if (!block || block.pageIndex !== 0) return false;
    const gap = block.rect.y - titleBottom;
    if (gap < -1 || gap > 20 || block.rect.h > titleBlock.rect.h) return false;
    const centerDistance = Math.abs(
      block.rect.x + block.rect.w / 2 - (titleBlock.rect.x + titleBlock.rect.w / 2),
    );
    if (centerDistance > pageWidth * 0.08) return false;
    const text = unit.sourceText.replace(/\s+/g, ' ').trim();
    const words = text.match(/[A-Za-z]{2,}/g) ?? [];
    return text.length >= 5
      && text.length <= 120
      && words.length >= 2
      && words.length <= 14
      && !/[.!?;:]$/.test(text)
      && !/@|\b(?:abstract|keywords?)\b/i.test(text);
  }).sort((left, right) => (
    blocks.get(left.sourceBlockId ?? left.id)!.rect.y
    - blocks.get(right.sourceBlockId ?? right.id)!.rect.y
  ));
  if (!continuations.length) return units;
  title.sourceText = [title.sourceText.trim(), ...continuations.map((unit) => unit.sourceText!.trim())].join('\n');
  title.protectedTokens = extractProtectedTokens(title.sourceText);
  const continuationIds = new Set(continuations.map((unit) => unit.id));
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !continuationIds.has(unitId));
  }
  return units.filter((unit) => !continuationIds.has(unit.id));
}

function visualCharacterRowText(characters: readonly CharacterRect[]): string {
  const ordered = [...characters]
    .filter((character) => character.ch.trim().length > 0)
    .sort((left, right) => left.rect.x - right.rect.x || left.sourceIndex - right.sourceIndex);
  const seen = new Set<string>();
  let result = '';
  let previous: CharacterRect | undefined;
  for (const character of ordered) {
    const key = [
      Math.round(character.rect.x * 10), Math.round(character.rect.y * 10),
      Math.round(character.rect.w * 10), character.ch,
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    if (previous) {
      const gap = character.rect.x - (previous.rect.x + previous.rect.w);
      if (gap > Math.max(1.5, Math.min(previous.rect.h, character.rect.h) * 0.18)) result += ' ';
    }
    result += character.ch;
    previous = character;
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * Small-caps IEEE headings are occasionally emitted as several overlapping
 * text blocks on the same visual baseline. Reconstruct that baseline from
 * character geometry and remove only those heading glyphs from the following
 * prose block, leaving its body lines translatable.
 */
function repairSplitHeadingRows(
  doc: Doc,
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  let units = inputUnits;
  const emptied = new Set<string>();
  for (const heading of [...units].filter((unit) => unit.kind === 'heading' && Boolean(unit.sourceText))) {
    const headingBlock = blocks.get(heading.sourceBlockId ?? heading.id);
    if (!headingBlock || !/^\s*(?:\d{1,2}(?:\.\d+)*|[IVXLCDM]+)\./.test(heading.sourceText!)) continue;
    const headingCharacters = (headingBlock.characterRects ?? [])
      .filter((character) => character.pageIndex === headingBlock.pageIndex && character.ch.trim());
    if (!headingCharacters.length) continue;
    const rowTop = Math.min(...headingCharacters.map((character) => character.rect.y));
    const rowBottom = Math.max(...headingCharacters.map((character) => character.rect.y + character.rect.h));
    const rowCenter = (rowTop + rowBottom) / 2;
    const pageWidth = doc.pages[headingBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const candidates = [...blocks.values()].filter((candidate) => (
      candidate.pageIndex === headingBlock.pageIndex
      && ['section', 'paragraph'].includes(candidate.type)
      && sameVisualColumn(candidate, headingBlock, pageWidth)
      && (candidate.characterRects ?? []).some((character) => {
        const center = character.rect.y + character.rect.h / 2;
        return character.pageIndex === headingBlock.pageIndex && Math.abs(center - rowCenter) <= 3.5;
      })
    ));
    const rowCharacters = candidates.flatMap((candidate) => (
      (candidate.characterRects ?? []).filter((character) => {
        const center = character.rect.y + character.rect.h / 2;
        return character.pageIndex === headingBlock.pageIndex && Math.abs(center - rowCenter) <= 3.5;
      })
    ));
    const reconstructed = visualCharacterRowText(rowCharacters);
    const headingWords = reconstructed.match(/[A-Za-z\u3400-\u9fff]{2,}/g) ?? [];
    if (!/^\s*(?:\d{1,2}(?:\.\d+)*|[IVXLCDM]+)\./.test(reconstructed)
      || headingWords.length < 2 || reconstructed.length > 120) continue;
    heading.sourceText = reconstructed;
    heading.protectedTokens = extractProtectedTokens(reconstructed);

    for (const candidate of candidates) {
      if (candidate.id === headingBlock.id || !candidate.text || !candidate.characterRects?.length) continue;
      const unit = units.find((item) => (item.sourceBlockId ?? item.id) === candidate.id);
      if (!unit?.sourceText || unit.sourceText !== candidate.text) continue;
      const masked = new Uint8Array(candidate.text.length);
      for (const character of candidate.characterRects) {
        const center = character.rect.y + character.rect.h / 2;
        if (character.pageIndex !== headingBlock.pageIndex || Math.abs(center - rowCenter) > 3.5) continue;
        for (let index = Math.max(0, character.sourceIndex);
          index < Math.min(candidate.text.length, character.sourceIndex + character.ch.length);
          index += 1) masked[index] = 1;
      }
      const cleaned = [...candidate.text]
        .map((character, index) => masked[index] ? ' ' : character)
        .join('')
        .split(/\r?\n/)
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
      if (!cleaned) emptied.add(unit.id);
      else {
        unit.sourceText = cleaned;
        unit.protectedTokens = extractProtectedTokens(cleaned);
      }
    }
  }
  if (!emptied.size) return units;
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !emptied.has(unitId));
  }
  units = units.filter((unit) => !emptied.has(unit.id));
  return units;
}

function repairHeadingRegionOrder(
  doc: Doc,
  units: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): void {
  for (const heading of units.filter((unit) => unit.kind === 'heading')) {
    const headingBlock = blocks.get(heading.sourceBlockId ?? heading.id);
    if (!headingBlock) continue;
    const pageWidth = doc.pages[headingBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const headingBottom = headingBlock.rect.y + headingBlock.rect.h;
    const following = units
      .filter((unit) => (
        unit.id !== heading.id
        && !['title', 'author', 'page-furniture'].includes(unit.kind)
        && Boolean(unit.layoutRegionId)
      ))
      .map((unit) => ({ unit, block: blocks.get(unit.sourceBlockId ?? unit.id) }))
      .filter((candidate): candidate is { unit: SemanticUnit; block: Doc['blocks'][number] } => (
        Boolean(candidate.block)
        && candidate.block!.pageIndex === headingBlock.pageIndex
        && candidate.block!.rect.y >= headingBottom - 2
        // PDF parsers commonly mark a one-column prose block as `span` while
        // marking its short heading as `column`, even though their left edges
        // and physical reading lane are identical.  Requiring equal widthMode
        // in that transition leaves the heading in a later layout region.
        && (
          sameVisualColumn(candidate.block!, headingBlock, pageWidth)
          || Math.abs(candidate.block!.rect.x - headingBlock.rect.x) <= pageWidth * 0.12
        )
      ))
      .sort((left, right) => (
        left.block.rect.y - right.block.rect.y
        || left.block.rect.x - right.block.rect.x
        || left.unit.order - right.unit.order
      ))[0];
    if (!following || following.block.rect.y - headingBottom > 90) continue;
    const targetRegion = regions.find((region) => region.id === following.unit.layoutRegionId);
    if (!targetRegion) continue;
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => unitId !== heading.id);
    }
    const targetIndex = targetRegion.orderedUnitIds.indexOf(following.unit.id);
    targetRegion.orderedUnitIds.splice(targetIndex < 0 ? 0 : targetIndex, 0, heading.id);
    heading.layoutRegionId = targetRegion.id;
    heading.order = Math.min(heading.order, following.unit.order - 0.01);
  }
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
  const alphabeticCharacters = text.match(/[A-Za-z]/g)?.length ?? 0;
  const hasStrongMath = /[=+*/∑∫√≤≥≈≠×÷\d]|(?:^|\s)-(?:\s|$)/u.test(text);
  // Vision often encloses an entire prose line merely because it contains an
  // inline equation. Keeping that wide rectangle as pixels leaves the prose
  // untranslated. Reject only regions whose inside text is clearly prose;
  // the inline-formula geometry pass below will preserve the mathematical
  // substring instead.
  return (words.length >= 6 && functionWords.length >= 2)
    // A hallucinated Vision formula box is sometimes only one short prose
    // continuation line (for example, "architecture to accelerate it").
    // Four natural words plus a function word are already incompatible with
    // a tight display-formula crop. Formula symbols embedded in a sentence
    // are reconstructed later from their character geometry.
    || (words.length >= 3 && functionWords.length >= 1 && alphabeticCharacters >= 18)
    // Short IEEE headings and prose tails are another recurring false
    // positive: Vision encloses a whole column-width line because an inline
    // footnote marker or italic heading resembles mathematics. A true formula
    // crop of this width still carries an operator or a digit.
    || (!hasStrongMath && (words.length >= 3 || alphabeticCharacters >= 14));
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

function extendTableThroughClippedTailLine(
  doc: Doc,
  asset: DetectedAssetRegion,
): DetectedAssetRegion {
  if (asset.kind !== 'table') return asset;
  const assetBottom = asset.rect.y + asset.rect.h;
  const clippedBottom = doc.blocks
    .map((block) => physicalRectOnPage(block, asset.pageIndex))
    .filter((rect): rect is Rect => Boolean(rect))
    .filter((rect) => {
      const horizontalOverlap = Math.max(0, Math.min(
        rect.x + rect.w,
        asset.rect.x + asset.rect.w,
      ) - Math.max(rect.x, asset.rect.x));
      const overflow = rect.y + rect.h - assetBottom;
      return horizontalOverlap >= Math.min(rect.w, asset.rect.w) * 0.25
        // A Vision boundary may land through the final table-note baseline.
        // Extend only that short crossing line; a following prose paragraph
        // starts below the boundary and must remain translatable text.
        && rect.y < assetBottom
        && rect.y >= assetBottom - 18
        && overflow > 0
        && overflow <= 12;
    })
    .map((rect) => rect.y + rect.h + 2)
    .sort((left, right) => right - left)[0];
  if (clippedBottom === undefined || clippedBottom <= assetBottom) return asset;
  return { ...asset, rect: { ...asset.rect, h: clippedBottom - asset.rect.y } };
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
    if (candidate.type === 'caption' || candidate.type === 'section' || candidate.type === 'title') continue;
    const text = candidate.text?.trim() ?? '';
    const naturalWords = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    const fragmentLike = naturalWords <= 2
      && (text.length <= 16 || /[=+\-*/∑∫√≤≥≈≠⌈⌉λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(text));
    if (!fragmentLike) continue;
    const candidateText = normalizedFragmentText(text);
    const belongsToFormulaCluster = physicalPages(candidate).some((pageIndex) => {
      const candidateRect = physicalRectOnPage(candidate, pageIndex);
      const page = doc.pages[pageIndex];
      if (!candidateRect || !page) return false;
      return doc.blocks.some((other) => {
        if (other.id === candidate.id || !['paragraph', 'equation'].includes(other.type)) return false;
        const otherText = other.text?.trim() ?? '';
        const otherWords = otherText.match(/[A-Za-z]{3,}/g)?.length ?? 0;
        if (
          otherWords > 4
          || !/[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(otherText)
        ) return false;
        const otherRect = physicalRectOnPage(other, pageIndex);
        if (!otherRect) return false;
        const horizontalGap = Math.max(
          0,
          otherRect.x - (candidateRect.x + candidateRect.w),
          candidateRect.x - (otherRect.x + otherRect.w),
        );
        const verticalGap = Math.max(
          0,
          otherRect.y - (candidateRect.y + candidateRect.h),
          candidateRect.y - (otherRect.y + otherRect.h),
        );
        const combined = unionRect(candidateRect, otherRect);
        return horizontalGap <= 36
          && verticalGap <= 24
          && combined.w <= page.width * 0.8
          && combined.h <= 96;
      });
    });
    // A parser equation anchor and its detached limits/labels can each be
    // geometrically nested in another math block. Keep the connected group so
    // the later character-level formula reconstruction can crop it once.
    if (belongsToFormulaCluster) continue;
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
  const ordinaryShortWords = new Set([
    'a', 'an', 'as', 'at', 'be', 'by', 'do', 'for', 'if', 'in', 'is', 'it',
    'no', 'of', 'on', 'or', 'so', 'to', 'up', 'we',
  ]);
  if (!lines.some((line) => naturalWordCount(line) >= 2)) return source.trim();
  const filtered = lines.filter((line) => {
      if (!line) return false;
      if (naturalWordCount(line) >= 2) return true;
      if (line.length > 40) return true;
      return !(/[=+\-*/∑∫√≤≥≈≠⌈⌉⎧⎨⎩⎫⎬⎭λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(line)
        || /^(?:[A-Za-z]\s*){1,4}$/u.test(line));
    });
  const cleaned = filtered.map((line, lineIndex) => {
      const firstWord = line.match(/[A-Za-z]{3,}/);
      if (!firstWord?.index) return line;
      const prefix = line.slice(0, firstWord.index);
      if (prefix.length > 20 || /^\s*\d+[.)]\s*$/.test(prefix)) return line;
      const fragmentPrefix = prefix.trim();
      if (!fragmentPrefix || /[A-Za-z]{3,}/.test(fragmentPrefix)) return line;
      const shortWords = fragmentPrefix.match(/[A-Za-z]+/g) ?? [];
      // Line wrapping legitimately places short English function words before
      // the first 3+ letter word ("in the process", "to the pipeline",
      // "on-chip"). They are prose, not detached equation glyphs. Likewise,
      // an opening bracket belongs to the following word. Strip a prefix only
      // when it carries actual mathematical evidence or consists solely of
      // isolated one-letter variables such as "m P .".
      if (/^[([{'"“‘]+\s*$/.test(fragmentPrefix)) return line;
      if (shortWords.length > 0
        && shortWords.every((word) => ordinaryShortWords.has(word.toLocaleLowerCase()))) return line;
      if (/^[+\-]?\d+(?:[.,]\d+)?%?(?:\s*(?:×|x))?\s*$/i.test(fragmentPrefix)) return line;
      // A display expression may wrap immediately after a binary operator,
      // with its remaining terms followed by explanatory prose on this line.
      // That prefix is part of the equation, not an unrelated PDF glyph run.
      if (/[=+\-*/]\s*$/.test(filtered[lineIndex - 1]?.trim() ?? '')) return line;
      const mathematicalPrefix = /[=+*/∑∫√≤≥≈≠⌈⌉⎧⎨⎩⎫⎬⎭λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(fragmentPrefix)
        || (shortWords.length > 0 && shortWords.every((word) => word.length === 1));
      if (!mathematicalPrefix) return line;
      return line.slice(firstWord.index);
    });
  return cleaned.join('\n').trim();
}

function hasScatteredMathLinesAroundProse(source: string): boolean {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const naturalProseIndex = lines.findIndex((line) => {
    const words = line.match(/[A-Za-z]{3,}/g) ?? [];
    const functionWords = line.match(
      /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|shown)\b/gi,
    ) ?? [];
    return words.length >= 3 && functionWords.length >= 1;
  });
  // A normal paragraph followed by a displayed equation is legitimate. This
  // recovery is for the inverse pattern emitted by PDF.js: detached formula
  // glyph lines first, then one real prose continuation (and often more math).
  if (naturalProseIndex <= 0) return false;
  const isMathFragment = (line: string): boolean => {
    const naturalWords = line.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    if (naturalWords >= 2 || line.length > 40) return false;
    return /[=+\-*/∑∫√≤≥≈≠⌈⌉⎧⎨⎩⎫⎬⎭λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(line)
      || /^(?:[A-Za-z]\s*){1,4}$/u.test(line);
  };
  return lines.slice(0, naturalProseIndex).filter(isMathFragment).length >= 2;
}

function normalizeDetachedSubscriptLines(source: string): string {
  const lines = source.split(/\r?\n/);
  const sentenceWords = new Set([
    'the', 'this', 'that', 'these', 'those', 'when', 'where', 'while', 'although',
    'however', 'therefore', 'because', 'since', 'for', 'from', 'with', 'without',
    'into', 'onto', 'each', 'one', 'we', 'it', 'our',
  ]);
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index + 1]?.trim();
    if (!marker || !/^[A-Za-z]{2,6}$/.test(marker)) {
      result.push(lines[index]!);
      continue;
    }
    let markerCount = 0;
    while (lines[index + markerCount + 1]?.trim().toLocaleLowerCase() === marker.toLocaleLowerCase()) {
      markerCount += 1;
    }
    // Detached subscripts emitted by PDF.js occur as repeated identical rows
    // after the variables on the preceding prose line. Requiring at least two
    // prevents ordinary one-word wrapped lines from being rewritten.
    if (markerCount < 2) {
      result.push(lines[index]!);
      continue;
    }
    const collapsed = lines[index]!.replace(/\b([A-Z])\s+([a-z][A-Za-z]{2,})\b/g, '$1$2');
    const variablePattern = /\b(?:[A-Z][a-zA-Z]{2,}|[a-z]+[A-Z][A-Za-z]*)\b/g;
    const candidates = [...collapsed.matchAll(variablePattern)]
      .filter((match) => !sentenceWords.has(match[0].toLocaleLowerCase()));
    if (candidates.length < markerCount) {
      result.push(lines[index]!);
      continue;
    }
    let candidateIndex = 0;
    const normalized = collapsed.replace(variablePattern, (word) => {
      if (sentenceWords.has(word.toLocaleLowerCase()) || candidateIndex >= markerCount) return word;
      candidateIndex += 1;
      return `${word}_${marker}`;
    });
    result.push(normalized);
    index += markerCount;
  }
  return result.join('\n').trim();
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
  const functionWords = text.match(
    /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi,
  ) ?? [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fragmentedFormula = functionWords.length === 0
    && lines.length >= 3
    && lines.filter((line) => line.length <= 16).length / lines.length >= 0.7;
  if ((naturalWords > 2 && !fragmentedFormula)
    || !/[=+\-*/∑∫√≤≥≈≠⌈⌉⎧⎨⎩λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω\d]/u.test(text)) return false;
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
    const protectedFormulaOverlapIndexes = new Set<number>();
    let lineOffset = 0;
    for (const line of blockText.split(/\r?\n/)) {
      const lineStart = lineOffset;
      const lineEnd = lineStart + line.length;
      lineOffset = lineEnd + 1;
      if ((line.match(/[A-Za-z]{3,}/g)?.length ?? 0) < 5) continue;
      const lineCharacters = block.characterRects.filter((character) => (
        character.sourceIndex >= lineStart
        && character.sourceIndex < lineEnd
        && character.ch.trim().length > 0
      ));
      if (!lineCharacters.length) continue;
      for (const asset of assets) {
        const inlineOwner = asset.id.match(/^(.*)-inline-formula(?:-\d+)?$/)?.[1];
        if (asset.kind !== 'formula' || !inlineOwner || inlineOwner === block.id) continue;
        const overlapping = lineCharacters.filter((character) => {
          if (character.pageIndex !== asset.pageIndex) return false;
          const centerX = character.rect.x + character.rect.w / 2;
          const centerY = character.rect.y + character.rect.h / 2;
          return centerX >= asset.rect.x && centerX <= asset.rect.x + asset.rect.w
            && centerY >= asset.rect.y && centerY <= asset.rect.y + asset.rect.h;
        });
        // Formula crops include a small safety pad for subscripts. If that pad
        // merely clips part of a natural-language line owned by another PDF
        // block, preserve the line instead of deleting a convincing-looking
        // substring from the sentence. Formula assets derived from this block
        // remain authoritative and still mask their exact inline expression.
        if (overlapping.length > 0 && overlapping.length / lineCharacters.length < 0.6) {
          overlapping.forEach((character) => protectedFormulaOverlapIndexes.add(character.sourceIndex));
        }
      }
    }
    const masked = new Uint8Array(source.length);
    for (const character of block.characterRects) {
      const centerX = character.rect.x + character.rect.w / 2;
      const centerY = character.rect.y + character.rect.h / 2;
      const insideAsset = assets.some((asset) => (
        character.pageIndex === asset.pageIndex
        && centerX >= asset.rect.x && centerX <= asset.rect.x + asset.rect.w
        && centerY >= asset.rect.y && centerY <= asset.rect.y + asset.rect.h
        && !protectedFormulaOverlapIndexes.has(character.sourceIndex)
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
  let searchOffset = 0;
  const kept: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    let start = blockText.indexOf(line, searchOffset);
    if (start < 0 && line.trim() !== line) start = blockText.indexOf(line.trim(), searchOffset);
    if (start < 0) {
      kept.push(line);
      continue;
    }
    const end = start + line.length;
    searchOffset = end + 1;
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
  const rawSource = block.text ?? '';
  let searchOffset = 0;
  const lines = source.split(/\r?\n/).map((line) => {
    let start = rawSource.indexOf(line, searchOffset);
    if (start < 0 && line.trim() !== line) start = rawSource.indexOf(line.trim(), searchOffset);
    if (start < 0) start = searchOffset;
    const end = start + line.length;
    searchOffset = Math.min(rawSource.length, end + 1);
    const characters = block.characterRects!.filter((character) => (
      character.sourceIndex >= start
      && character.sourceIndex < end
      && character.ch.trim().length > 0
    ));
    const nearMargin = characters.filter((character) => {
      const page = doc.pages[character.pageIndex];
      if (!page) return false;
      const centerY = character.rect.y + character.rect.h / 2;
      const outsideOwningBlock = character.pageIndex !== block.pageIndex
        || centerY < block.rect.y - 12
        || centerY > block.rect.y + block.rect.h + 12;
      // Ordinary body text in IEEE papers legitimately begins near 8% of the
      // page height. It is furniture only when its geometry is an embedded
      // outlier from this block (typically a next-page running header).
      return outsideOwningBlock && (centerY < page.height * 0.1 || centerY > page.height * 0.92);
    }).length;
    return { line, furniture: characters.length > 0 && nearMargin / characters.length >= 0.8 };
  });
  if (!lines.some((line) => line.furniture) || !lines.some((line) => !line.furniture && line.line.trim())) {
    return source;
  }
  return lines.filter((line) => !line.furniture).map((line) => line.line).join('\n').trim();
}

function withoutPublisherBoilerplate(source: string): string {
  const lines = source.split(/\r?\n/);
  let inPermissionNotice = false;
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (/^Corresponding author\s*:/i.test(trimmed)) return false;
    if (/^Permission to make (?:digital or hard|digital|hard) copies\b/i.test(trimmed)) {
      inPermissionNotice = true;
      return false;
    }
    if (inPermissionNotice) {
      if (/\bdoi\.org\//i.test(trimmed)) inPermissionNotice = false;
      return false;
    }
    return !(
      /^(?:©\s*)?\d{4}\s+Copyright\b/i.test(trimmed)
      || /^ACM ISBN\b/i.test(trimmed)
      || /^https?:\/\/doi\.org\//i.test(trimmed)
      || /^DAC\s*[’']?\d{2}\s*,\s*(?:June|July|August)\b/i.test(trimmed)
    );
  }).join('\n').trim();
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
  prefixIds: Set<string>;
}

interface FormulaGlyphCandidate {
  block: Doc['blocks'][number];
  rect: Rect;
  /** A mathematical prefix cut from a mixed block whose remaining lines are prose. */
  prefixOnly: boolean;
}

function leadingFormulaGlyphRect(
  block: Doc['blocks'][number],
  pageIndex: number,
): Rect | undefined {
  if (!block.characterRects?.length || !/\r?\n/.test(block.text ?? '')) return undefined;
  const source = block.text ?? '';
  let offset = 0;
  let formulaLines = 0;
  let hasStrongMath = false;
  let followedByProse = false;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of source.split(/\r?\n/)) {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const words = trimmed.match(/[A-Za-z]{3,}/g) ?? [];
    const functionWords = trimmed.match(
      /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi,
    ) ?? [];
    if (words.length >= 5 && functionWords.length >= 1) {
      followedByProse = formulaLines > 0;
      break;
    }
    const strongMath = /[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(trimmed);
    const equationLabel = /^\(\s*\d+[a-z]?\s*\)$/i.test(trimmed);
    if (words.length > 4 || (!strongMath && !equationLabel)) break;
    ranges.push({ start, end });
    formulaLines += 1;
    hasStrongMath ||= strongMath;
  }
  if (!followedByProse || !hasStrongMath || !ranges.length) return undefined;
  const characters = block.characterRects.filter((character) => (
    character.pageIndex === pageIndex
    && character.ch.trim().length > 0
    && ranges.some((range) => character.sourceIndex >= range.start && character.sourceIndex < range.end)
  ));
  return unionRects(characters.map((character) => character.rect));
}

function withoutLeadingFormulaLines(source: string): string {
  const lines = source.split(/\r?\n/);
  let formulaLines = 0;
  let hasStrongMath = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (!trimmed) continue;
    const words = trimmed.match(/[A-Za-z]{3,}/g) ?? [];
    const functionWords = trimmed.match(
      /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi,
    ) ?? [];
    if (words.length >= 5 && functionWords.length >= 1) {
      return formulaLines > 0 && hasStrongMath
        ? lines.slice(index).join('\n').trim()
        : source;
    }
    const strongMath = /[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(trimmed);
    const equationLabel = /^\(\s*\d+[a-z]?\s*\)$/i.test(trimmed);
    if (words.length > 4 || (!strongMath && !equationLabel)) return source;
    formulaLines += 1;
    hasStrongMath ||= strongMath;
  }
  return source;
}

function withoutDetachedVariableLines(source: string): string {
  const lines = source.split(/\r?\n/);
  if (lines.length < 2) return source;
  const naturalLine = lines.some((line) => {
    const words = line.match(/[A-Za-z]{3,}/g) ?? [];
    const functionWords = line.match(
      /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|each)\b/gi,
    ) ?? [];
    return words.length >= 3 && functionWords.length >= 1;
  });
  if (!naturalLine) return source;
  return lines
    // PDF symbol-font subscripts are often emitted as late standalone lines
    // such as `i` or `i i`. Their visible glyphs are already inside the
    // neighbouring immutable formula crop; keeping the duplicate text makes
    // them appear as scattered prose.
    .filter((line) => !/^\s*[A-Za-z](?:\s+[A-Za-z]){0,3}\s*$/.test(line))
    .join('\n')
    .trim();
}

function formulaGlyphCluster(
  doc: Doc,
  anchor: Doc['blocks'][number],
  unitIds: ReadonlySet<string>,
): FormulaGlyphCluster | undefined {
  const page = doc.pages[anchor.pageIndex];
  if (!page) return undefined;
  const hasCharacterGeometry = Boolean(anchor.characterRects?.length || anchor.charRects?.length);
  if (!hasCharacterGeometry && (anchor.rect.w > page.width * 0.6 || anchor.rect.h > 72)) {
    return undefined;
  }
  const candidates = doc.blocks.flatMap((candidate): FormulaGlyphCandidate[] => {
    if (
      candidate.pageIndex !== anchor.pageIndex
      || !['paragraph', 'equation'].includes(candidate.type)
    ) return [];
    const text = candidate.text?.trim() ?? '';
    const naturalWords = text.match(/[A-Za-z]{3,}/g) ?? [];
    if (!text) return [];
    const prefixRect = leadingFormulaGlyphRect(candidate, anchor.pageIndex);
    if (prefixRect) return [{ block: candidate, rect: prefixRect, prefixOnly: true }];
    if (
      text.length > 500
      || naturalWords.length > 4
      || !/[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(text)
    ) return [];
    const characterRect = physicalRectOnPage(candidate, anchor.pageIndex);
    return characterRect ? [{ block: candidate, rect: characterRect, prefixOnly: false }] : [];
  });
  if (candidates.length < 2) return undefined;

  let combined = physicalRectOnPage(anchor, anchor.pageIndex) ?? { ...anchor.rect };
  const fragmentIds = new Set<string>();
  const prefixIds = new Set<string>();
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
      // Consecutive display equations commonly keep roughly one text baseline
      // of vertical leading between their PDF glyph boxes.
      if (horizontalGap > 36 || verticalGap > 24) continue;
      const expandedRect = unionRect(combined, candidate.rect);
      if (expandedRect.w > page.width * 0.8 || expandedRect.h > 96) continue;
      combined = expandedRect;
      if (
        !candidate.prefixOnly
        && candidate.block.id !== anchor.id
        && unitIds.has(candidate.block.id)
      ) {
        fragmentIds.add(candidate.block.id);
      }
      if (candidate.prefixOnly && candidate.block.id !== anchor.id) {
        prefixIds.add(candidate.block.id);
      }
      remaining.splice(index, 1);
      expanded = true;
    }
  }
  if (!fragmentIds.size || combined.w > page.width * 0.8 || combined.h > 96) {
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
    prefixIds,
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

function isStandaloneFormulaParagraph(
  unit: SemanticUnit,
  block: Doc['blocks'][number] | undefined,
): boolean {
  if (unit.kind !== 'paragraph' || !block || !unit.sourceText) return false;
  const source = unit.sourceText.trim();
  if (!source || source.length > 80 || block.rect.h > 72) return false;
  const naturalWords = source.match(/[A-Za-z]{3,}/g) ?? [];
  const strongMath = /[=+−∑∏∫√≤≥≈≠⟨⟩λ𝐀-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(source);
  const formulaCharacters = source.match(/[\d=+−∑∏∫√≤≥≈≠⟨⟩λ𝐀-𝑧𝛼-𝜔α-ωΑ-Ω]/gu)?.length ?? 0;
  return naturalWords.length === 0 && strongMath && formulaCharacters >= 2;
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
  const leadingLines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (
    leadingLines.length >= 3
    && /[=+\-*/∑∫√≤≥≈≠𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(leadingLines[0]!)
    && /^\(\s*\d+[a-z]?\s*\)$/i.test(leadingLines[1]!)
  ) return undefined;
  const equalsIndex = source.indexOf('=');
  if (equalsIndex < 1) return undefined;
  const left = source.slice(0, equalsIndex).match(
    /\b([A-Za-z](?:\s+[A-Za-z]){1,2}|[A-Za-z][A-Za-z0-9_]*(?:\s*[′'])?(?:\s+def)?(?:\s+[23])?)\s*$/,
  );
  if (!left?.index && left?.index !== 0) return undefined;
  const formulaStart = left.index;
  const delimiter = source.slice(equalsIndex + 1).match(
    /\s*(?:[,;]\s*(?=(?:where|with|which|for|respectively|and)\b)|(?=(?:where|with|which|whose|into|from|using|through|under|over|is|are|was|were|can|could|will|would|shall|should|may|might|must|represents?|denotes?|equals?)\b)|[.]\s*(?=[A-Z]|$)|$)/,
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
    // line above and even two PDF points can capture its descenders. Detached
    // limits are recovered precisely from nearby formula-only blocks below.
    rect: {
      x: Math.max(0, physical.x - 3),
      y: Math.max(0, physical.y),
      w: physical.w + 6,
      h: physical.h + bottomPad,
    },
  };
}

function absorbDetachedFormulaGlyphs(
  asset: DetectedAssetRegion,
  siblingAssets: readonly DetectedAssetRegion[],
  fragmentGlyphs: readonly CharacterRect[],
  page: Doc['pages'][number],
): void {
  const glyphRows: CharacterRect[][] = [];
  for (const character of fragmentGlyphs
    .filter((candidate) => candidate.pageIndex === asset.pageIndex && candidate.ch.trim())
    .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x)) {
    const row = glyphRows.find((candidate) => (
      candidate.length > 0 && Math.abs(candidate[0]!.rect.y - character.rect.y) <= 1.5
    ));
    if (row) row.push(character);
    else glyphRows.push([character]);
  }
  const proximity = (rect: Rect, candidate: DetectedAssetRegion): {
    horizontalGap: number; verticalGap: number; score: number;
  } => {
    const horizontalGap = Math.max(
      0,
      rect.x - (candidate.rect.x + candidate.rect.w),
      candidate.rect.x - (rect.x + rect.w),
    );
    const verticalGap = Math.max(
      0,
      rect.y - (candidate.rect.y + candidate.rect.h),
      candidate.rect.y - (rect.y + rect.h),
    );
    const centerDistance = Math.abs(
      rect.y + rect.h / 2 - (candidate.rect.y + candidate.rect.h / 2),
    );
    return { horizontalGap, verticalGap, score: verticalGap * 100 + centerDistance + horizontalGap };
  };
  const nearbyGlyphs = glyphRows.flatMap((row) => {
    const rowRect = unionRects(row.map((character) => character.rect));
    if (!rowRect) return [];
    const current = proximity(rowRect, asset);
    if (current.horizontalGap > 8 || current.verticalGap > 8) return [];
    const closest = siblingAssets
      .filter((candidate) => candidate.pageIndex === asset.pageIndex)
      .map((candidate) => ({ candidate, ...proximity(rowRect, candidate) }))
      .sort((left, right) => left.score - right.score || left.candidate.id.localeCompare(right.candidate.id))[0];
    // PDF.js often emits `j + u - 1` as one detached row. Once that row is
    // assigned to this formula, preserve the entire row instead of stopping
    // after the first individually-near glyph and cutting off its tail.
    return closest?.candidate.id === asset.id ? row : [];
  });
  if (!nearbyGlyphs.length) return;
  const existingPreserveRects = asset.preserveRects?.length
    ? [...asset.preserveRects]
    : [{ ...asset.rect }];
  const combined = nearbyGlyphs.reduce(
    (rect, character) => unionRect(rect, character.rect),
    { ...asset.rect },
  );
  const x = Math.max(0, combined.x - 1);
  const y = Math.max(0, combined.y - 0.5);
  const right = Math.min(page.width, combined.x + combined.w + 1);
  // Keep half a point of vertical raster safety. A full point can touch the
  // following prose baseline in tightly led two-column papers.
  const bottom = Math.min(page.height, combined.y + combined.h + 0.5);
  asset.rect = { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
  asset.preserveRects = [
    ...existingPreserveRects,
    ...nearbyGlyphs.map((character) => ({
      x: Math.max(0, character.rect.x - 0.5),
      y: Math.max(0, character.rect.y - 0.5),
      w: character.rect.w + 1,
      h: character.rect.h + 1,
    })),
  ];
  asset.requiresLargeOperator ||= nearbyGlyphs.some((character) => /[∑∏∫]/u.test(character.ch));
}

function detachedFormulaGlyphs(
  block: Doc['blocks'][number],
  pageIndex: number,
): CharacterRect[] {
  if (!block.characterRects?.length || block.pageIndex !== pageIndex) return [];
  const source = block.text ?? '';
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const line of source.split(/\r?\n/)) {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 100) continue;
    const naturalWords = trimmed.match(/[A-Za-z]{3,}/g)?.length ?? 0;
    const strongMath = /[=+\-*/∑∏∫√≤≥≈≠⌈⌉→←↦λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]/u.test(trimmed);
    const compactMathTokens = naturalWords === 0
      && /^[\s\dA-Za-z.,()[\]{}|^ˆ′'_=+\-*/∑∏∫√≤≥≈≠⌈⌉→←↦λ𝑎-𝑧𝛼-𝜔α-ωΑ-Ω]+$/u.test(trimmed);
    if (naturalWords <= 2 && (strongMath || compactMathTokens)) ranges.push({ start, end });
  }
  return block.characterRects.filter((character) => (
    character.pageIndex === pageIndex
    && character.ch.trim()
    && ranges.some((range) => character.sourceIndex >= range.start && character.sourceIndex < range.end)
  ));
}

function normalizePdfNumericSpacing(source: string, allowSingleSmallCaps = false): string {
  const normalized = source
    // Symbol-font vector accents can surface as C0 control codes (notably
    // U+0003) in PDF.js text. They cannot be rendered by Typst and otherwise
    // become visible replacement squares. The surrounding variable and
    // subscript remain readable; immutable source pixels retain decoration.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // PDF.js may emit a decimal point and its digits as separate glyph runs.
    // Canonicalizing only digit-surrounded punctuation keeps prose and formula
    // punctuation intact while preventing `2 . 08` from becoming four
    // independent protected tokens that are later appended to `2.08`.
    .replace(/(?<=\d)\s*[.]\s*(?=\d)/g, '.')
    .replace(/(?<=\d)\s*([%‰×])\s*/g, '$1')
    // Preserve hyphenated technical identifiers across a visual PDF line
    // wrap. Otherwise `MNT4-\n753` becomes two protected-number contexts and
    // a model that correctly emits `MNT4-753` can be "repaired" with a second
    // stray 753 at the end of the sentence.
    .replace(/\b([A-Za-z]+\d*)-[ \t]*\r?\n[ \t]*(\d+)\b/g, '$1-$2');
  return normalized.split(/\r?\n/).map((line) => {
    const splitSmallCaps = line.match(/\b[A-Z]\s+[A-Z]{2,}\b/g) ?? [];
    if (splitSmallCaps.length < (allowSingleSmallCaps ? 1 : 2)) return line;
    // Small-caps fonts are often extracted as `P ERFORMANCE C OMPARISON`.
    // Require two such words on the same line so normal phrases like `A FPGA`
    // are not collapsed into a false identifier.
    return line.replace(/\b([A-Z])\s+([A-Z]{2,})\b/g, '$1$2');
  }).join('\n');
}

const MAX_TRANSLATION_UNIT_CHARACTERS = 1_800;

function splitOversizedSourceText(source: string): string[] {
  const parts: string[] = [];
  let remaining = source.trim();
  while (remaining.length > MAX_TRANSLATION_UNIT_CHARACTERS) {
    const window = remaining.slice(0, MAX_TRANSLATION_UNIT_CHARACTERS + 1);
    let cut = -1;
    // A single PDF newline is normally only a visual line wrap. Treating it as
    // a semantic boundary can leave a request ending in fragments such as
    // "our scheme has a", which invites the model to complete text belonging
    // to the next request and duplicates the following sentence.
    const boundary = /(?:[.!?。！？](?:["')\]]*)\s+|\n{2,})/g;
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

interface RecoveredCaptionLane {
  anchor: Doc['blocks'][number];
  sourceText: string;
  continuationIds: string[];
}

function appendCaptionContinuation(source: string, continuation: string): string {
  if (source.endsWith('-') && /^[a-z]/.test(continuation)) {
    return `${source.slice(0, -1)}${continuation}`;
  }
  return `${source} ${continuation}`;
}

/**
 * Some two-column PDFs emit the left caption and the right prose baseline as
 * one span block. A narrow continuation directly below the caption is strong
 * physical evidence that the real caption belongs to only one column.
 */
function recoverSplitColumnCaption(
  doc: Doc,
  caption: Doc['blocks'][number],
): RecoveredCaptionLane | undefined {
  const page = doc.pages[caption.pageIndex];
  if (!page || caption.widthMode !== 'span' || caption.rect.w < page.width * 0.65) return undefined;
  const firstCharacter = (caption.characterRects ?? [])
    .filter((character) => character.pageIndex === caption.pageIndex && character.ch.trim())
    .sort((left, right) => left.sourceIndex - right.sourceIndex)[0];
  const captionOnLeft = (firstCharacter?.rect.x ?? caption.rect.x) < page.width / 2;
  const candidates = doc.blocks
    .filter((block) => {
      if (block.id === caption.id || block.pageIndex !== caption.pageIndex) return false;
      const centerX = block.rect.x + block.rect.w / 2;
      const verticalGap = block.rect.y - (caption.rect.y + caption.rect.h);
      return block.rect.w <= page.width * 0.55
        && (centerX < page.width / 2) === captionOnLeft
        && Math.abs(block.rect.x - caption.rect.x) <= page.width * 0.08
        && verticalGap >= -2
        && verticalGap <= 42
        && block.rect.h <= 24
        && Boolean(block.text?.trim());
    })
    .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
  if (!candidates.length) return undefined;

  const continuations: Doc['blocks'] = [];
  let previousBottom = caption.rect.y + caption.rect.h;
  let combinedText = '';
  for (const candidate of candidates) {
    if (candidate.rect.y > previousBottom + 12 || /[.!?]\s*$/.test(combinedText)) break;
    continuations.push(candidate);
    combinedText = appendCaptionContinuation(combinedText, candidate.text!.trim()).trim();
    previousBottom = candidate.rect.y + candidate.rect.h;
  }
  if (!continuations.length) return undefined;

  const laneCharacters = (caption.characterRects ?? []).filter((character) => {
    const centerX = character.rect.x + character.rect.w / 2;
    return character.pageIndex === caption.pageIndex
      && (centerX < page.width / 2) === captionOnLeft
      && character.ch.trim();
  });
  let captionText = caption.text?.trim() ?? '';
  if (laneCharacters.length) {
    const start = Math.min(...laneCharacters.map((character) => character.sourceIndex));
    const end = Math.max(...laneCharacters.map((character) => character.sourceIndex)) + 1;
    const laneText = (caption.text ?? '').slice(start, end).trim();
    if (isFigureCaptionText(laneText) || isTableCaptionText(laneText)) captionText = laneText;
  }
  for (const continuation of continuations) {
    captionText = appendCaptionContinuation(captionText, continuation.text!.trim());
  }

  const laneRects = [
    ...laneCharacters.map((character) => character.rect),
    ...continuations.map((block) => block.rect),
  ];
  const lane = unionRects(laneRects);
  if (!lane) return undefined;
  return {
    anchor: {
      ...caption,
      rect: { x: lane.x, y: caption.rect.y, w: lane.w, h: caption.rect.h },
      widthMode: 'column',
    },
    sourceText: captionText.replace(/\s+/g, ' ').trim(),
    continuationIds: continuations.map((block) => block.id),
  };
}

/** Rejoin a caption continuation that PDF.js emitted as the next column block. */
function recoverColumnCaptionContinuation(
  doc: Doc,
  caption: Doc['blocks'][number],
): RecoveredCaptionLane | undefined {
  const page = doc.pages[caption.pageIndex];
  const source = caption.text?.trim() ?? '';
  if (!page || caption.widthMode !== 'column' || /[.!?]\s*$/.test(source)) return undefined;
  const captionBottom = caption.rect.y + caption.rect.h;
  const continuation = doc.blocks
    .filter((block) => {
      const text = block.text?.trim() ?? '';
      const gap = block.rect.y - captionBottom;
      return block.id !== caption.id
        && block.pageIndex === caption.pageIndex
        && block.type === 'paragraph'
        && sameVisualColumn(block, caption, page.width)
        && Math.abs(block.rect.x - caption.rect.x) <= page.width * 0.04
        && gap >= -1
        && gap <= 7
        && block.rect.h <= 48
        && /^[A-Za-z(]/.test(text);
    })
    .sort((left, right) => left.rect.y - right.rect.y || left.order - right.order)[0];
  if (!continuation) return undefined;
  const lane = unionRects([caption.rect, continuation.rect]);
  if (!lane) return undefined;
  return {
    anchor: {
      ...caption,
      rect: { x: lane.x, y: caption.rect.y, w: lane.w, h: caption.rect.h },
      widthMode: 'column',
    },
    sourceText: appendCaptionContinuation(source, continuation.text!.trim())
      .replace(/\s+/g, ' ').trim(),
    continuationIds: [continuation.id],
  };
}

function previousPhysicalContentBottom(
  doc: Doc,
  caption: Doc['blocks'][number],
): number | undefined {
  const page = doc.pages[caption.pageIndex];
  if (!page) return undefined;
  const captionTop = caption.rect.y;
  const boundaries = doc.blocks.flatMap((block) => {
    if (block.id === caption.id || block.pageIndex !== caption.pageIndex) return [];
    const bottom = block.rect.y + block.rect.h;
    if (bottom > captionTop - 18 || block.rect.y < page.height * 0.08) return [];
    const overlap = Math.max(0, Math.min(
      block.rect.x + block.rect.w,
      caption.rect.x + caption.rect.w,
    ) - Math.max(block.rect.x, caption.rect.x));
    return overlap / Math.max(1, Math.min(block.rect.w, caption.rect.w)) >= 0.25 ? [bottom] : [];
  });
  return boundaries.sort((left, right) => right - left)[0];
}

function previousProseBottomInCaptionColumn(
  doc: Doc,
  caption: Doc['blocks'][number],
): number | undefined {
  const page = doc.pages[caption.pageIndex];
  if (!page) return undefined;
  const captionOnLeft = caption.rect.x + caption.rect.w / 2 < page.width / 2;
  const bottoms: number[] = [];
  for (const block of doc.blocks) {
    if (block.id === caption.id) continue;
    const source = block.text ?? '';
    let offset = 0;
    const lineRecords: Array<{ rect: Rect; natural: boolean }> = [];
    for (const line of source.split(/\r?\n/)) {
      const start = offset;
      const end = start + line.length;
      offset = end + 1;
      const words = line.match(/[A-Za-z]{3,}/g) ?? [];
      const functionWords = line.match(
        /\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at)\b/gi,
      ) ?? [];
      const lineRect = unionRects((block.characterRects ?? [])
        .filter((character) => {
          const centerX = character.rect.x + character.rect.w / 2;
          return character.pageIndex === caption.pageIndex
            && character.sourceIndex >= start
            && character.sourceIndex < end
            && (centerX < page.width / 2) === captionOnLeft
            && character.ch.trim().length > 0;
        })
        .map((character) => character.rect));
      if (lineRect && lineRect.y + lineRect.h < caption.rect.y - 8) {
        lineRecords.push({ rect: lineRect, natural: words.length >= 8 && functionWords.length >= 2 });
      }
    }
    const sortedLines = lineRecords.sort((left, right) => left.rect.y - right.rect.y);
    const firstNatural = sortedLines.findIndex((line) => line.natural);
    if (firstNatural >= 0) {
      let clusterBottom = sortedLines[firstNatural]!.rect.y + sortedLines[firstNatural]!.rect.h;
      for (const line of sortedLines.slice(firstNatural + 1)) {
        if (line.rect.y > clusterBottom + 18) break;
        clusterBottom = Math.max(clusterBottom, line.rect.y + line.rect.h);
      }
      bottoms.push(clusterBottom);
    }
    if (
      !block.characterRects?.length
      && block.pageIndex === caption.pageIndex
      && sameVisualColumn(block, caption, page.width)
      && block.rect.y + block.rect.h < caption.rect.y - 8
      && (source.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 8
    ) {
      bottoms.push(block.rect.y + block.rect.h);
    }
  }
  return bottoms.length ? Math.max(...bottoms) : undefined;
}

function looksLikeVisualLabels(block: Doc['blocks'][number]): boolean {
  const lines = (block.text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const labelLike = lines.filter((line) => (
    line.length <= 32 || /^[-+]?\d[\d.,%‰+\- ]*$/.test(line)
  )).length;
  return labelLike / lines.length >= 0.7;
}

function trailingVisualLabelClusterTop(block: Doc['blocks'][number]): number | undefined {
  if (!block.characterRects?.length || !/\r?\n/.test(block.text ?? '')) return undefined;
  let offset = 0;
  const lines = (block.text ?? '').split(/\r?\n/).map((text) => {
    const start = offset;
    const end = start + text.length;
    offset = end + 1;
    const words = text.match(/[A-Za-z]{2,}/g) ?? [];
    const functionWords = text.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|has|have)\b/gi) ?? [];
    const trimmed = text.trim();
    const labelLike = Boolean(trimmed)
      && trimmed.length <= 90
      && words.length <= 10
      && functionWords.length <= 1
      && !/[.!?;:]\s*$/.test(trimmed);
    return { start, end, words: words.length, labelLike };
  });
  let cut = lines.length;
  while (cut > 0 && lines[cut - 1]!.labelLike) cut -= 1;
  if (lines.length - cut < 3 || cut === 0 || !lines.slice(0, cut).some((line) => line.words >= 6)) {
    return undefined;
  }
  const clusterStart = lines[cut]!.start;
  const clusterEnd = lines.at(-1)!.end;
  const characters = block.characterRects.filter((character) => (
    character.sourceIndex >= clusterStart
    && character.sourceIndex < clusterEnd
    && character.ch.trim().length > 0
  ));
  if (!characters.length) return undefined;
  return Math.max(1, Math.min(...characters.map((character) => character.rect.y)) - 6);
}

function extendFigureThroughPrecedingVisualLabels(
  doc: Doc,
  asset: DetectedAssetRegion,
  allAssets: readonly DetectedAssetRegion[],
): void {
  if (asset.kind !== 'figure' || !asset.captionUnitId) return;
  const caption = doc.blocks.find((block) => block.id === asset.captionUnitId);
  if (!caption || embeddedCaptionText(caption.text ?? '', 'figure') !== (caption.text ?? '').trim()) return;
  const pageWidth = doc.pages[asset.pageIndex]?.width ?? doc.meta.paperWidth;
  const protectedTableBlockIds = new Set(doc.blocks
    .filter((block) => allAssets.some((other) => (
      other !== asset
      && other.kind === 'table'
      && other.pageIndex === asset.pageIndex
      && block.rect.x < other.rect.x + other.rect.w
      && block.rect.x + block.rect.w > other.rect.x
      && block.rect.y < other.rect.y + other.rect.h
      && block.rect.y + block.rect.h > other.rect.y
    )))
    .map((block) => block.id));
  const candidates = doc.blocks
    .filter((block) => (
      block.id !== caption.id
      && !protectedTableBlockIds.has(block.id)
      && block.pageIndex === asset.pageIndex
      && sameVisualColumn(block, caption, pageWidth)
      && block.rect.y < caption.rect.y
      && block.rect.y + block.rect.h >= asset.rect.y - 24
    ))
    .flatMap((block) => {
      const top = trailingVisualLabelClusterTop(block);
      return top !== undefined && top < asset.rect.y ? [top] : [];
    });
  if (!candidates.length) return;
  const top = Math.max(...candidates);
  if (asset.rect.y - top > (doc.pages[asset.pageIndex]?.height ?? doc.meta.paperHeight) * 0.25) return;
  const bottom = asset.rect.y + asset.rect.h;
  asset.rect = { ...asset.rect, y: top, h: bottom - top };
}

function looksLikeNumericTableBody(block: Doc['blocks'][number]): boolean {
  const text = block.text ?? '';
  const numericTokens = text.match(/\d+(?:[.,]\d+)?/g)?.length ?? 0;
  const wordTokens = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
  return lines >= 3
    && numericTokens >= 6
    && numericTokens >= Math.max(4, wordTokens * 0.6);
}

function looksLikeShortTableCellLabel(block: Doc['blocks'][number]): boolean {
  const text = block.text?.trim() ?? '';
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numericTokens = text.match(/\d+(?:[.,]\d+)?/g)?.length ?? 0;
  const naturalWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  return block.type !== 'caption'
    && lines.length >= 1
    && lines.length <= 4
    && text.length <= 80
    && numericTokens >= 1
    && naturalWords <= 8
    && !/[.!?;:]\s*$/.test(text);
}

interface CenteredSpanningTableGeometry {
  rect: Rect;
  bodyIds: string[];
}

interface PrecedingTableGeometry {
  rect: Rect;
}

/** Recover a numeric table placed immediately above its caption. */
function precedingTableGeometry(
  doc: Doc,
  caption: Doc['blocks'][number],
): PrecedingTableGeometry | undefined {
  const page = doc.pages[caption.pageIndex];
  if (!page) return undefined;
  const candidate = doc.blocks
    .map((block) => ({ block, rect: physicalRectOnPage(block, caption.pageIndex) }))
    .filter((entry): entry is { block: Doc['blocks'][number]; rect: Rect } => Boolean(entry.rect))
    .filter(({ block, rect }) => {
      if (block.id === caption.id || !looksLikeNumericTableBody(block)) return false;
      const gap = caption.rect.y - (rect.y + rect.h);
      const overlap = Math.max(0, Math.min(
        rect.x + rect.w,
        caption.rect.x + caption.rect.w,
      ) - Math.max(rect.x, caption.rect.x));
      return gap >= -2
        && gap <= 18
        && rect.h >= 18
        && overlap >= Math.min(rect.w, caption.rect.w) * 0.45;
    })
    .sort((left, right) => (
      right.rect.y + right.rect.h - (left.rect.y + left.rect.h)
      || left.block.order - right.block.order
    ))[0];
  if (!candidate) return undefined;
  const column = visualColumnBounds(doc, caption);
  const top = Math.max(page.height * 0.04, candidate.rect.y - 6);
  const bottom = caption.rect.y - 4;
  if (bottom - top < 18) return undefined;
  return { rect: { x: column.x, y: top, w: column.w, h: bottom - top } };
}

/**
 * A spanning table title can be emitted as a tiny block whose centre falls a
 * few points into one column, while the duplicate full table text aggregate is
 * removed during parser normalization. Recover the physical table from the
 * numeric label blocks that remain on both sides of the centre gutter.
 */
function centeredSpanningTableGeometry(
  doc: Doc,
  caption: Doc['blocks'][number],
): CenteredSpanningTableGeometry | undefined {
  const page = doc.pages[caption.pageIndex];
  if (!page || caption.widthMode !== 'column') return undefined;
  const midpoint = page.width / 2;
  const captionCenter = caption.rect.x + caption.rect.w / 2;
  if (Math.abs(captionCenter - midpoint) > page.width * 0.065) return undefined;

  const captionBottom = caption.rect.y + caption.rect.h;
  const nextCaption = doc.blocks
    .filter((block) => (
      block.id !== caption.id
      && block.pageIndex === caption.pageIndex
      && block.type === 'caption'
      && block.rect.y >= captionBottom + 24
    ))
    .sort((left, right) => left.rect.y - right.rect.y)[0];
  const searchBottom = nextCaption?.rect.y ?? Math.min(page.height * 0.55, captionBottom + page.height * 0.3);
  const candidates = doc.blocks.filter((block) => (
    block.id !== caption.id
    && block.pageIndex === caption.pageIndex
    && block.rect.y >= captionBottom - 2
    && block.rect.y + block.rect.h <= searchBottom + 2
    && (looksLikeNumericTableBody(block) || looksLikeShortTableCellLabel(block))
  ));
  const left = candidates.filter((block) => block.rect.x + block.rect.w / 2 < midpoint);
  const right = candidates.filter((block) => block.rect.x + block.rect.w / 2 >= midpoint);
  if (!left.length || !right.length) return undefined;

  const tableBottom = Math.max(...candidates.map((block) => block.rect.y + block.rect.h)) + 6;
  if (tableBottom <= captionBottom + 12) return undefined;
  const x = Math.min(
    page.width * 0.07,
    Math.min(...candidates.map((block) => block.rect.x)) - 6,
  );
  const rightEdge = Math.max(
    page.width * 0.93,
    Math.max(...candidates.map((block) => block.rect.x + block.rect.w)) + 6,
  );
  return {
    rect: {
      x,
      y: captionBottom + 1,
      w: rightEdge - x,
      h: Math.min(tableBottom, searchBottom - 4) - (captionBottom + 1),
    },
    bodyIds: candidates.map((block) => block.id),
  };
}

/** Stop a following figure after the contiguous numeric body of a preceding table. */
function precedingTableBodyBottom(
  doc: Doc,
  figureCaption: Doc['blocks'][number],
): number | undefined {
  const page = doc.pages[figureCaption.pageIndex];
  if (!page) return undefined;
  const pageWidth = page.width;
  const tableCaption = doc.blocks
    .filter((block) => (
      block.pageIndex === figureCaption.pageIndex
      && block.type === 'caption'
      && isTableCaptionText(block.text ?? '')
      && block.rect.y + block.rect.h < figureCaption.rect.y - 24
      && (
        sameVisualColumn(block, figureCaption, pageWidth)
        || Math.abs(block.rect.x + block.rect.w / 2 - pageWidth / 2) <= pageWidth * 0.065
      )
    ))
    .sort((left, right) => right.rect.y - left.rect.y)[0];
  if (!tableCaption) return undefined;

  const captionBottom = tableCaption.rect.y + tableCaption.rect.h;
  const candidates = doc.blocks
    .filter((block) => (
      block.id !== tableCaption.id
      && block.pageIndex === figureCaption.pageIndex
      && block.rect.y >= captionBottom - 2
      && block.rect.y + block.rect.h < figureCaption.rect.y - 18
      && looksLikeNumericTableBody(block)
      && (
        sameVisualColumn(block, figureCaption, pageWidth)
        || tableCaption.rect.x < pageWidth / 2 && tableCaption.rect.x + tableCaption.rect.w > pageWidth / 2
      )
    ))
    .sort((left, right) => left.rect.y - right.rect.y);
  if (!candidates.length || candidates[0]!.rect.y > captionBottom + 48) return undefined;

  let bottom = captionBottom;
  let consumed = 0;
  for (const candidate of candidates) {
    if (consumed && candidate.rect.y > bottom + 14) break;
    bottom = Math.max(bottom, candidate.rect.y + candidate.rect.h);
    consumed += 1;
  }
  return consumed ? bottom : undefined;
}

function visualColumnBounds(doc: Doc, anchor: Doc['blocks'][number]): { x: number; w: number } {
  const pageWidth = doc.pages[anchor.pageIndex]?.width ?? doc.meta.paperWidth;
  const columnBlocks = doc.blocks.filter((block) => (
    block.pageIndex === anchor.pageIndex
    && sameVisualColumn(block, anchor, pageWidth)
    && !(
      anchor.widthMode === 'column'
      && block.rect.w < pageWidth * 0.15
      && block.rect.x < pageWidth / 2
      && block.rect.x + block.rect.w > pageWidth / 2
    )
  ));
  if (!columnBlocks.length) return { x: anchor.rect.x, w: anchor.rect.w };
  const x = Math.min(...columnBlocks.map((block) => block.rect.x));
  const right = Math.max(...columnBlocks.map((block) => block.rect.x + block.rect.w));
  if (anchor.widthMode === 'span' && right - x < pageWidth * 0.6) {
    return { x: pageWidth * 0.08, w: pageWidth * 0.84 };
  }
  return { x, w: right - x };
}

function clampColumnTableToGutter(doc: Doc, asset: DetectedAssetRegion): void {
  if (asset.kind !== 'table' || asset.widthMode !== 'column') return;
  const page = doc.pages[asset.pageIndex];
  const caption = asset.captionUnitId
    ? doc.blocks.find((block) => block.id === asset.captionUnitId)
    : undefined;
  if (!page || !caption || asset.rect.w >= page.width * 0.62) return;
  const midpoint = page.width / 2;
  const gutter = Math.max(6, page.width * 0.012);
  const captionOnLeft = caption.rect.x + caption.rect.w / 2 < midpoint;
  if (captionOnLeft && asset.rect.x + asset.rect.w > midpoint - gutter) {
    asset.rect = { ...asset.rect, w: midpoint - gutter - asset.rect.x };
  } else if (!captionOnLeft && asset.rect.x < midpoint + gutter) {
    const right = asset.rect.x + asset.rect.w;
    asset.rect = { ...asset.rect, x: midpoint + gutter, w: right - midpoint - gutter };
  }
}

function clampSpanFigureToCaptionColumn(doc: Doc, asset: DetectedAssetRegion): void {
  if (asset.kind !== 'figure' || asset.widthMode !== 'span' || !asset.captionUnitId) return;
  const page = doc.pages[asset.pageIndex];
  const caption = doc.blocks.find((block) => block.id === asset.captionUnitId);
  if (!page || !caption || caption.widthMode !== 'column' || asset.rect.w < page.width * 0.62) return;
  const column = visualColumnBounds(doc, caption);
  if (column.w > page.width * 0.55) return;
  const left = Math.max(asset.rect.x, column.x);
  const right = Math.min(asset.rect.x + asset.rect.w, column.x + column.w);
  if (right - left < page.width * 0.2) return;
  asset.rect = { ...asset.rect, x: left, w: right - left };
  asset.widthMode = 'column';
}

function detectedPageFurnitureIds(doc: Doc): Set<string> {
  const ids = new Set<string>();
  const repeatedMargins = new Map<string, Array<{ id: string; pageIndex: number }>>();
  for (const block of doc.blocks) {
    const pageHeight = doc.pages[block.pageIndex]?.height ?? doc.meta.paperHeight;
    const nearMargin = block.rect.y < pageHeight * 0.12
      || block.rect.y + block.rect.h > pageHeight * 0.92;
    const normalized = block.text?.trim().replace(/\s+/g, ' ') ?? '';
    // IEEE first-page editorial notes and affiliation footnotes are outside
    // the paper's reading flow. They can begin well above the physical bottom
    // margin and continue through several blocks, so margin proximity alone
    // is not a sufficient precondition.
    if (
      block.pageIndex === 0
      && block.rect.y >= pageHeight * 0.65
      && /(?:Manuscript received|This work was supported|Recommended for acceptance|Corresponding author|\bis with\b.*(?:University|Institute|Company)|e-?mail\s*:|Digital Object Identifier|Personal use is permitted|See\s+https?:\/\/www[.]ieee[.]org\/publications\/rights)/i.test(normalized)
    ) {
      ids.add(block.id);
    }
    if (!nearMargin) continue;
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
    const pageWidth = doc.pages[captionBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const captionBottom = captionBlock.rect.y + captionBlock.rect.h;
    const candidates = doc.blocks
      .filter((block) => (
        block.pageIndex === captionBlock.pageIndex
        && block.rect.y >= captionBottom - 1
        && (
          captionBlock.widthMode === 'span'
          || sameVisualColumn(block, captionBlock, pageWidth)
          || (
            block.widthMode === 'span'
            && Math.abs(block.rect.x - captionBlock.rect.x) <= 24
          )
          || (
            block.rect.w >= pageWidth * 0.55
            && block.rect.x < captionBlock.rect.x + captionBlock.rect.w
            && block.rect.x + block.rect.w > captionBlock.rect.x
          )
        )
      ))
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
    const layoutRegion = doc.layoutRegions.find((region) => region.id === caption.layoutRegionId);
    const midpoint = pageWidth / 2;
    const gutter = Math.max(6, pageWidth * 0.012);
    const wideRegion = captionBlock.widthMode === 'span'
      || bodyBlocks.some((block) => block.rect.w >= pageWidth * 0.55)
      || (inkLeft < midpoint - gutter && inkRight > midpoint + gutter);
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

function embeddedCaptionText(source: string, kind: 'figure' | 'table'): string | undefined {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line) => (
    kind === 'figure' ? isFigureCaptionText(line) : isTableCaptionText(line)
  ));
  if (start < 0) return undefined;
  const caption = [lines[start]!];
  if (/[.!?。！？]\s*$/.test(lines[start]!)) return caption[0];
  for (const line of lines.slice(start + 1, start + 4)) {
    if (isFigureCaptionText(line) || isTableCaptionText(line)) break;
    const words = line.match(/[A-Za-z]{2,}/g) ?? [];
    const functionWords = line.match(/\b(?:the|a|an|and|or|of|to|in|for|with|that|this|is|are|was|were|as|by|from|on|at|has|have)\b/gi) ?? [];
    if (words.length < 4 || functionWords.length < 1) break;
    caption.push(line);
    if (/[.!?。！？]\s*$/.test(line)) break;
  }
  return caption.join(' ');
}

function splitMergedCaptionText(source: string): Array<{ kind: 'figure' | 'table'; text: string }> {
  const starts = [...source.matchAll(/\b(Figure|Table)\s+\d+[A-Za-z]?\s*[:.]\s*/gi)];
  if (starts.length < 2) return [];
  return starts.map((match, index) => ({
    kind: match[1]!.toLocaleLowerCase() as 'figure' | 'table',
    text: source.slice(match.index!, starts[index + 1]?.index ?? source.length).trim(),
  })).filter((segment) => segment.text.length > 0);
}

function isBibliographyHeading(source: string | undefined): boolean {
  const compact = (source ?? '').trim().replace(/\s+/g, '');
  return /^(?:references|bibliography|参考文献)$/i.test(compact);
}

export function authorBiographyStart(source: string | undefined): number | undefined {
  if (!source) return undefined;
  const match = source.match(
    /(?:^|\n)(?=[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){1,4}(?:\s+\([^\n)]*IEEE[^\n)]*\))?\s+(?:received|earned|obtained|is|was|has\s+(?:been|worked)|currently\s+(?:is|works))\b)/m,
  );
  if (match?.index === undefined) return undefined;
  return match.index + (match[0].startsWith('\n') ? 1 : 0);
}

type BibliographyCharacter = CharacterRect & {
  blockId: string;
  blockText: string;
};

function bibliographyRowText(row: BibliographyCharacter[]): string {
  const ordered = [...row].sort((left, right) => left.rect.x - right.rect.x);
  let value = '';
  let previous: BibliographyCharacter | undefined;
  for (const character of ordered) {
    if (previous) {
      const omittedSource = previous.blockId === character.blockId
        && character.sourceIndex > previous.sourceIndex
        ? character.blockText.slice(previous.sourceIndex + 1, character.sourceIndex)
        : '';
      const visualGap = character.rect.x - (previous.rect.x + previous.rect.w);
      if (/\s/.test(omittedSource) || (previous.blockId !== character.blockId && visualGap > 1)) {
        value += ' ';
      }
    }
    value += character.ch;
    previous = character;
  }
  return value.replace(/\s+/g, ' ').trim();
}

function appendBibliographyContinuation(entry: string, line: string): string {
  if (entry.endsWith('-') && /^[a-z]/.test(line)) {
    return `${entry.slice(0, -1)}${line}`;
  }
  if (entry.endsWith('-') && /^\d/.test(line)) return `${entry}${line}`;
  const trailingUrl = entry.match(/https?:\/\/\S+$/i)?.[0];
  if ((trailingUrl && /[./:]$/.test(trailingUrl) && /^[A-Za-z0-9/?#]/.test(line))
    || (/https?:$/i.test(entry) && line.startsWith('//'))) {
    return `${entry}${line}`;
  }
  return `${entry} ${line}`;
}

function physicalHeadingBlock(
  unit: SemanticUnit,
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): Doc['blocks'][number] | undefined {
  return blocks.get(unit.sourceBlockId ?? unit.id);
}

/**
 * PDF reading order is column-based, so a narrow citation-label column can be
 * emitted after the wider bibliography body even when the References heading
 * is physically above both. Rebuild a terminal bibliography from character
 * geometry so labels, bodies, and wrapped lines share one physical sequence.
 */
function rebuildBibliographyFromGeometry(
  doc: Doc,
  inputUnits: SemanticUnit[],
  regions: LayoutRegion[],
  blocks: ReadonlyMap<string, Doc['blocks'][number]>,
): SemanticUnit[] {
  const heading = inputUnits
    .filter((unit) => unit.kind === 'heading' && isBibliographyHeading(unit.sourceText))
    .map((unit) => ({ unit, block: physicalHeadingBlock(unit, blocks) }))
    .filter((candidate): candidate is { unit: SemanticUnit; block: Doc['blocks'][number] } => Boolean(candidate.block))
    .sort((left, right) => left.block.pageIndex - right.block.pageIndex || left.block.rect.y - right.block.rect.y)[0];
  if (!heading) return inputUnits;

  const nextHeading = inputUnits
    .filter((unit) => unit.kind === 'heading' && unit.id !== heading.unit.id)
    .map((unit) => physicalHeadingBlock(unit, blocks))
    .filter((block): block is Doc['blocks'][number] => Boolean(block))
    .filter((block) => (
      block.pageIndex > heading.block.pageIndex
      || (block.pageIndex === heading.block.pageIndex
        && block.rect.y > heading.block.rect.y + heading.block.rect.h + 2)
    ))
    .sort((left, right) => left.pageIndex - right.pageIndex || left.rect.y - right.rect.y)[0];

  const headingPage = doc.pages[heading.block.pageIndex];
  const headingPageMidpoint = (headingPage?.width ?? doc.meta.paperWidth) / 2;
  const bibliographyEntryStart = /^\[(?=[^\]\r\n]*\d)[A-Za-z0-9]+\]/;
  const citationBlocks = doc.blocks.filter((block) => (
    block.order > heading.block.order
    && (!nextHeading || block.order < nextHeading.order)
    && bibliographyEntryStart.test((block.text ?? '').trimStart())
  ));
  const leftCitationBlocks = citationBlocks.filter((block) => block.rect.x < headingPageMidpoint);
  const rightCitationBlocks = citationBlocks.filter((block) => block.rect.x >= headingPageMidpoint);
  const multiColumnBibliography = leftCitationBlocks.length >= 2 && rightCitationBlocks.length >= 2;
  const firstRightCitation = rightCitationBlocks
    .filter((block) => block.pageIndex === heading.block.pageIndex)
    .sort((left, right) => left.rect.y - right.rect.y)[0];
  const rightContinuation = firstRightCitation
    ? doc.blocks
      .filter((block) => (
        block.id !== firstRightCitation.id
        && block.pageIndex === firstRightCitation.pageIndex
        && block.rect.x + block.rect.w / 2 >= headingPageMidpoint
        && block.rect.y < firstRightCitation.rect.y
        && block.rect.y + block.rect.h >= firstRightCitation.rect.y - 6
      ))
      .sort((left, right) => left.rect.y - right.rect.y)[0]
    : undefined;
  const rightColumnBibliographyTop = rightContinuation?.rect.y ?? firstRightCitation?.rect.y;

  const characters: BibliographyCharacter[] = [];
  const seenCharacters = new Set<string>();
  for (const block of doc.blocks) {
    for (const character of block.characterRects ?? []) {
      const page = doc.pages[character.pageIndex];
      if (!page) continue;
      const centerY = character.rect.y + character.rect.h / 2;
      const centerX = character.rect.x + character.rect.w / 2;
      const headingIsNarrowLeftColumn = multiColumnBibliography
        && heading.block.rect.w < page.width * 0.6
        && heading.block.rect.x + heading.block.rect.w / 2 < page.width / 2;
      const followsHeadingInLaterColumn = character.pageIndex === heading.block.pageIndex
        && headingIsNarrowLeftColumn
        && centerX >= page.width / 2
        && rightColumnBibliographyTop !== undefined
        && centerY >= rightColumnBibliographyTop - 2;
      const sameHeadingColumn = (centerX < page.width / 2)
        === (heading.block.rect.x + heading.block.rect.w / 2 < page.width / 2);
      const blockCrossesMidpointFromHeadingLane = block.rect.x < page.width / 2
        && block.rect.x + block.rect.w > page.width / 2
        && block.rect.w >= page.width * 0.5
        && Math.abs(block.rect.x - heading.block.rect.x) <= page.width * 0.12;
      const afterHeading = character.pageIndex > heading.block.pageIndex
        || (character.pageIndex === heading.block.pageIndex
          && (followsHeadingInLaterColumn
            || (centerY > heading.block.rect.y + heading.block.rect.h + 2
              && (multiColumnBibliography || sameHeadingColumn || blockCrossesMidpointFromHeadingLane))));
      const beforeNextHeading = !nextHeading
        || character.pageIndex < nextHeading.pageIndex
        || (character.pageIndex === nextHeading.pageIndex && centerY < nextHeading.rect.y - 2);
      if (!afterHeading || !beforeNextHeading || centerY <= page.height * 0.065 || centerY >= page.height * 0.95) {
        continue;
      }
      const key = [
        character.pageIndex,
        Math.round(character.rect.x * 10),
        Math.round(character.rect.y * 10),
        Math.round(character.rect.w * 10),
        character.ch,
      ].join(':');
      if (seenCharacters.has(key)) continue;
      seenCharacters.add(key);
      characters.push({
        ...character,
        blockId: block.id,
        blockText: block.text ?? '',
      });
    }
  }

  const rows: Array<typeof characters> = [];
  const pageIndexes = [...new Set(characters.map((character) => character.pageIndex))]
    .sort((left, right) => left - right);
  for (const pageIndex of pageIndexes) {
    const page = doc.pages[pageIndex]!;
    const pageCharacters = characters.filter((character) => character.pageIndex === pageIndex);
    const columns = multiColumnBibliography
      ? [
          pageCharacters.filter((character) => character.rect.x + character.rect.w / 2 < page.width / 2),
          pageCharacters.filter((character) => character.rect.x + character.rect.w / 2 >= page.width / 2),
        ]
      : [pageCharacters];
    for (const column of columns) {
      column.sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
      for (const character of column) {
        const last = rows.at(-1);
        if (last?.length
          && last[0]!.pageIndex === character.pageIndex
          && Math.abs(last[0]!.rect.y - character.rect.y) <= 1.5
          && (!multiColumnBibliography
            || (last[0]!.rect.x < page.width / 2) === (character.rect.x < page.width / 2))) {
          last.push(character);
        } else {
          rows.push([character]);
        }
      }
    }
  }

  const rowLines = rows.map((row) => ({ row, text: bibliographyRowText(row) }))
    .filter((candidate) => Boolean(candidate.text));
  const biographyLineIndex = rowLines.findIndex((candidate) => (
    authorBiographyStart(candidate.text) === 0
  ));
  const bibliographyRowLines = biographyLineIndex >= 0
    ? rowLines.slice(0, biographyLineIndex)
    : rowLines;
  const selectedBlockIds = new Set(bibliographyRowLines
    .flatMap((candidate) => candidate.row.map((character) => character.blockId)));
  const entries: string[] = [];
  for (const { text: rawLine } of bibliographyRowLines) {
    const line = rawLine.replace(/^(\[(?=[^\]\r\n]*\d)[A-Za-z0-9]+\])(?=\S)/, '$1 ');
    if (bibliographyEntryStart.test(line)) {
      entries.push(line);
    } else if (entries.length) {
      entries[entries.length - 1] = appendBibliographyContinuation(entries.at(-1)!, line);
    }
  }
  // A single bracketed line can be an ordinary citation-bearing paragraph.
  // Require a real multi-entry bibliography before changing document order.
  if (entries.length < 2) return inputUnits;

  const replacedIds = new Set(inputUnits
    .filter((unit) => (
      unit.id !== heading.unit.id
      && (
        selectedBlockIds.has(unit.sourceBlockId ?? unit.id)
        || (unit.parentId === heading.unit.id && unit.kind === 'reference')
      )
    ))
    .map((unit) => unit.id));
  const targetRegion = regions.find((region) => region.id === heading.unit.layoutRegionId);
  if (!targetRegion) return inputUnits;

  const biographyResiduals = inputUnits.flatMap((unit): SemanticUnit[] => {
    if (!replacedIds.has(unit.id)) return [];
    const start = authorBiographyStart(unit.sourceText);
    if (start === undefined) return [];
    const sourceText = unit.sourceText!.slice(start).trim();
    if (!sourceText) return [];
    return [{
      ...unit,
      id: `${unit.id}-biography`,
      parentId: undefined,
      kind: 'paragraph',
      sourceText,
      protectedTokens: extractProtectedTokens(sourceText),
    }];
  });
  const residualByOriginal = new Map(biographyResiduals.map((unit) => [
    unit.id.replace(/-biography$/, ''), unit,
  ]));
  for (const region of regions) {
    region.orderedUnitIds = region.orderedUnitIds.flatMap((unitId) => {
      if (!replacedIds.has(unitId)) return [unitId];
      const residual = residualByOriginal.get(unitId);
      return residual ? [residual.id] : [];
    });
  }
  const rebuilt = entries.map((sourceText, index): SemanticUnit => ({
    id: `${heading.unit.id}-reference-${index + 1}`,
    parentId: heading.unit.id,
    kind: 'reference',
    sourceText,
    protectedTokens: extractProtectedTokens(sourceText),
    layoutRegionId: targetRegion.id,
    order: heading.unit.order + (index + 1) / 1_000,
  }));
  let headingIndex = targetRegion.orderedUnitIds.indexOf(heading.unit.id);
  if (headingIndex < 0) {
    targetRegion.orderedUnitIds.push(heading.unit.id);
    headingIndex = targetRegion.orderedUnitIds.length - 1;
  }
  targetRegion.orderedUnitIds.splice(headingIndex + 1, 0, ...rebuilt.map((unit) => unit.id));
  return inputUnits.filter((unit) => !replacedIds.has(unit.id)).concat(rebuilt, biographyResiduals);
}

export function prepareImmutableStructure(doc: Doc, options: PrepareImmutableOptions = {}): PreparedImmutableStructure {
  const regions = doc.layoutRegions.map((region) => ({ ...region, orderedUnitIds: [...region.orderedUnitIds] }));
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  let units: SemanticUnit[] = doc.semanticUnits.map((unit) => ({
    ...unit,
    sourceBlockId: unit.sourceBlockId ?? (blocks.has(unit.id) ? unit.id : undefined),
    protectedTokens: [...unit.protectedTokens],
  }));
  units = mergeFirstPageTitleContinuations(doc, units, regions, blocks);
  units = repairSplitHeadingRows(doc, units, regions, blocks);
  repairHeadingRegionOrder(doc, units, regions, blocks);
  const assetRegions: DetectedAssetRegion[] = [];
  const algorithmAssets = detectedAlgorithmAssets(doc);
  const algorithmPages = new Set(algorithmAssets.map((asset) => asset.pageIndex));
  const verifiedAssetRegions = (options.verifiedAssetRegions ?? [])
    // Vision occasionally mistakes an ordinary paragraph below an algorithm
    // for code. Once a caption-anchored algorithm body is reconstructed from
    // the PDF text geometry, prefer that deterministic crop for this page.
    .filter((asset) => asset.kind !== 'code' || !algorithmPages.has(asset.pageIndex))
    .filter((asset) => !proseHeavyFormulaRegion(doc, asset))
    .map((asset) => extendTableThroughClippedTailLine(doc, trimTableBeforeFollowingProse(doc, {
      ...asset,
      rect: { ...asset.rect },
    })))
    .concat(algorithmAssets);
  // Clamp before any coordinate-based text masking so a coarse table box
  // cannot delete the first glyphs of the neighbouring prose column.
  verifiedAssetRegions.forEach((asset) => {
    clampSpanFigureToCaptionColumn(doc, asset);
    clampColumnTableToGutter(doc, asset);
    extendFigureThroughPrecedingVisualLabels(doc, asset, verifiedAssetRegions);
  });
  // PDF.js can aggregate an entire diagram's labels with its trailing caption.
  // When reconciliation binds that block as the caption owner, translate only
  // the actual caption lines; the verified asset retains the preceding labels.
  const captionAssetCounts = new Map<string, number>();
  for (const asset of verifiedAssetRegions) {
    if (asset.captionUnitId) {
      captionAssetCounts.set(asset.captionUnitId, (captionAssetCounts.get(asset.captionUnitId) ?? 0) + 1);
    }
  }
  for (const asset of verifiedAssetRegions) {
    if (!asset.captionUnitId || (asset.kind !== 'figure' && asset.kind !== 'table')) continue;
    if (captionAssetCounts.get(asset.captionUnitId) !== 1) continue;
    const unit = units.find((candidate) => candidate.id === asset.captionUnitId);
    const block = blocks.get(asset.captionUnitId);
    const caption = block ? embeddedCaptionText(block.text ?? '', asset.kind) : undefined;
    if (!unit || !caption) continue;
    if (unit.kind === 'paragraph' || unit.kind === 'list-item') {
      unit.kind = asset.kind === 'table' ? 'table-title' : 'caption';
    }
    unit.sourceText = caption;
    unit.protectedTokens = extractProtectedTokens(caption);
  }
  const verifiedCaptionIds = new Set(verifiedAssetRegions
    .map((asset) => asset.captionUnitId)
    .filter((id): id is string => Boolean(id)));
  const portraitPages = authorPortraitPages(doc, verifiedAssetRegions);
  for (const region of regions) {
    const visionLayout = options.pageLayouts?.get(region.sourcePage);
    if (visionLayout === 'single' && !portraitPages.has(region.sourcePage)) region.mode = 'single';
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
    // A legitimate first-page title often straddles the generic 10% top
    // margin threshold. Never treat its first visual line as running furniture.
    const geometryCleaned = ['title', 'author'].includes(unit.kind)
      ? assetCleaned
      : withoutEmbeddedMarginFurniture(doc, block, assetCleaned);
    const labelsCleaned = withoutDetachedVariableLines(normalizeDetachedSubscriptLines(
      withoutTrailingVisualLabelCluster(geometryCleaned),
    ));
    const crossesPages = new Set((block.fragments ?? []).map((fragment) => fragment.pageIndex)).size > 1;
    // A numbered heading can sit next to a display formula, but its leading
    // section number is structural content rather than a scattered math
    // fragment (for example, `2.4 Sparse Matrix`). Never run the heuristic
    // formula-line scrubber over headings, otherwise the number is silently
    // removed before it can be protected and translated.
    const fragmentedMathAroundProse = ['paragraph', 'abstract', 'list-item'].includes(unit.kind)
      && hasScatteredMathLinesAroundProse(labelsCleaned);
    const fragmentsCleaned = unit.kind !== 'heading'
      && (crossesPages || block.rect.h <= 24 || nearVerifiedFormula(block, verifiedAssetRegions)
        || fragmentedMathAroundProse)
      ? withoutScatteredMathLines(labelsCleaned)
      : labelsCleaned;
    const furnitureCleaned = withoutRepeatedEmbeddedFurniture(
      doc,
      block,
      fragmentsCleaned,
      repeatedFurnitureLines,
    );
    const cleaned = withoutPublisherBoilerplate(furnitureCleaned);
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

  // PDF.js occasionally classifies a display equation as one or more tiny
  // paragraph blocks, especially when stacked limits are emitted after the
  // operator. Translating those fragments separately produces incomplete
  // formulas such as two detached summation signs. Reclassify only compact,
  // prose-free mathematical blocks; the formula cluster pass below then
  // reconstructs the original visual row from their character geometry.
  const reclassifiedFormulaSources = new Map<string, string>();
  for (const unit of units) {
    const block = blocks.get(unit.sourceBlockId ?? unit.id);
    if (!isStandaloneFormulaParagraph(unit, block)) continue;
    reclassifiedFormulaSources.set(unit.id, unit.sourceText!);
    unit.kind = 'formula';
    unit.sourceText = undefined;
    unit.protectedTokens = [];
    unit.assetId = unit.id;
  }

  const bibliographySectionIds = new Set(units
    .filter((unit) => unit.kind === 'heading' && isBibliographyHeading(unit.sourceText))
    .map((unit) => unit.id));
  if (bibliographySectionIds.size) {
    units = units.map((unit) => unit.id !== unit.parentId && bibliographySectionIds.has(unit.parentId ?? '')
      && authorBiographyStart(unit.sourceText) === undefined
      ? { ...unit, kind: 'reference' as const }
      : unit);
  }

  // A body sentence can continue on a new PDF text line with a citation such
  // as `[34] as the basic building block ...`. The line classifier sees the
  // leading bracket and labels it as a bibliography entry even though it is
  // still ordinary prose. Real bibliography units are parented to the
  // References heading; recover only unparented, sentence-like false matches.
  const firstBibliographyHeadingOrder = units
    .filter((unit) => unit.kind === 'heading' && isBibliographyHeading(unit.sourceText))
    .map((unit) => blocks.get(unit.sourceBlockId ?? unit.id)?.order ?? unit.order)
    .sort((left, right) => left - right)[0];
  units = units.map((unit) => {
    if (unit.kind !== 'reference' || !unit.sourceText) return unit;
    const physicalOrder = blocks.get(unit.sourceBlockId ?? unit.id)?.order ?? unit.order;
    if (firstBibliographyHeadingOrder !== undefined && physicalOrder < firstBibliographyHeadingOrder) {
      return { ...unit, kind: 'paragraph' as const };
    }
    if (unit.parentId) return unit;
    const wordsAfterCitation = unit.sourceText
      .replace(/^\s*\[\d+\]\s*/, '')
      .match(/[A-Za-z]{3,}/g)?.length ?? 0;
    return wordsAfterCitation >= 5 ? { ...unit, kind: 'paragraph' as const } : unit;
  });

  units = rebuildBibliographyFromGeometry(doc, units, regions, blocks);

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
    const assetBottom = asset.rect.y + asset.rect.h;
    const caption = asset.captionUnitId ? blocks.get(asset.captionUnitId) : undefined;
    const captionBottom = caption ? caption.rect.y + caption.rect.h : undefined;
    const attachedBodyIds = new Set<string>();
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
      const lines = (block.text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const attachedCaptionBody = captionBottom !== undefined
        && block.rect.y >= captionBottom - 1
        && block.rect.y <= captionBottom + 18
        && lines.length >= 4
        && numericTokens.length >= 4;
      if (attachedCaptionBody) attachedBodyIds.add(block.id);
      const visuallyContinuousLabels = block.rect.y <= assetBottom + 4
        && block.rect.y + block.rect.h > asset.rect.y
        && looksLikeVisualLabels(block);
      return horizontalOverlap / Math.max(1, Math.min(block.rect.w, asset.rect.w)) >= 0.2
        && (overlap / Math.max(1, block.rect.h) >= 0.6 || visuallyContinuousLabels || attachedCaptionBody)
        && numericTokens.length >= 2;
    });
    if (!numericRows.length) continue;
    const left = Math.min(asset.rect.x, ...numericRows.map((block) => block.rect.x));
    const right = Math.max(asset.rect.x + asset.rect.w, ...numericRows.map((block) => block.rect.x + block.rect.w));
    const numericBottom = Math.max(...numericRows.map((block) => block.rect.y + block.rect.h)) + 2;
    const extendsThroughVisualLabels = numericRows.some((block) => (
      block.rect.y <= assetBottom + 4
      && block.rect.y + block.rect.h > assetBottom + 2
      && looksLikeVisualLabels(block)
    ));
    const bottom = extendsThroughVisualLabels || attachedBodyIds.size > 0
      ? Math.max(assetBottom, numericBottom)
      : Math.min(assetBottom, numericBottom);
    const top = Math.min(asset.rect.y, ...numericRows
      .filter((block) => attachedBodyIds.has(block.id))
      .map((block) => Math.max(captionBottom! + 2, block.rect.y - 2)));
    asset.rect = {
      ...asset.rect,
      x: left,
      y: top,
      w: right - left,
      h: bottom > top + 12 ? bottom - top : asset.rect.h,
    };
  }

  // A coarse Vision box for a column table can leak a narrow strip from the
  // neighbouring prose column. Clamp only clearly column-sized tables to the
  // gutter; genuinely spanning tables keep their full width classification.
  verifiedAssetRegions.forEach((asset) => clampColumnTableToGutter(doc, asset));

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
      const page = doc.pages[fragment.pageIndex];
      const intersecting = doc.blocks.filter((candidate) => (
        candidate.pageIndex === fragment.pageIndex
        && intersectionArea(candidate.rect, fragment.rect) > 0
      ));
      const candidateAsset: DetectedAssetRegion = {
        id: `${unit.id}-inline-candidate`,
        kind: 'formula',
        pageIndex: fragment.pageIndex,
        rect: fragment.rect,
        widthMode: block.widthMode,
      };
      if (page && validateImmutableRegion(candidateAsset, page, intersecting).issues.includes('body-prose-density')) {
        // A malformed PDF source index can make a short `x = ...` match span
        // most of the prose line. Keep that source text translatable and keep
        // scanning for a later, genuinely tight expression.
        consumed = absoluteEnd;
        continue;
      }
      fragments.push({ ...fragment, absoluteStart, absoluteEnd });
      consumed = absoluteEnd;
    }
    if (!fragments.length) continue;

    const previousUnit = [...units]
      .filter((candidate) => candidate.order < unit.order && Boolean(candidate.sourceText))
      .sort((left, right) => right.order - left.order)
      .find((candidate) => {
        const candidateBlock = blocks.get(candidate.sourceBlockId ?? candidate.id);
        return candidateBlock
          && candidateBlock.pageIndex === block.pageIndex
          && sameVisualColumn(candidateBlock, block, doc.pages[block.pageIndex]?.width ?? doc.meta.paperWidth);
      });
    const previousBlock = previousUnit ? blocks.get(previousUnit.sourceBlockId ?? previousUnit.id) : undefined;
    if (previousUnit?.sourceText && previousBlock) {
      const cleanedPrevious = withoutTrailingFormulaFragment(previousUnit.sourceText);
      if (cleanedPrevious.length < previousUnit.sourceText.trim().length) {
        // The detached text-layer symbol can share a bounding row with the
        // preceding prose even though the visible operator is already inside
        // the tight inline-formula crop. Remove the duplicate source text but
        // do not enlarge the crop into that prose baseline.
        previousUnit.sourceText = cleanedPrevious;
        previousUnit.protectedTokens = extractProtectedTokens(cleanedPrevious);
      }
    }

    const replacementUnits: SemanticUnit[] = [];
    let cursor = 0;
    const pushText = (text: string, id: string) => {
      const cleaned = withoutDetachedVariableLines(text)
        .trim().replace(/^[,;:]\s*/, '').replace(/[,;:]\s*$/, '');
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
      const overlappingPrevious = assetRegions
        .filter((asset) => (
          asset.kind === 'formula'
          && asset.pageIndex === fragment.pageIndex
          && asset.id.includes('-inline-formula')
          && !asset.id.startsWith(`${unit.id}-`)
        ))
        .sort((left, right) => right.rect.y - left.rect.y)
        .find((asset) => {
          const ownerId = asset.id.match(/^(.*)-inline-formula(?:-\d+)?$/)?.[1];
          const ownerBlock = ownerId ? blocks.get(ownerId) : undefined;
          const horizontalGap = Math.max(
            0,
            asset.rect.x - (fragment.rect.x + fragment.rect.w),
            fragment.rect.x - (asset.rect.x + asset.rect.w),
          );
          const verticalGap = Math.max(
            0,
            asset.rect.y - (fragment.rect.y + fragment.rect.h),
            fragment.rect.y - (asset.rect.y + asset.rect.h),
          );
          // Adjacent equation baselines can touch because a summation's limits
          // make the earlier crop tall. They are not duplicate extractions.
          // Only fold into another inline asset when both source blocks occupy
          // effectively the same visual row.
          return horizontalGap <= 12
            && verticalGap <= 2
            && (!ownerBlock || Math.abs(ownerBlock.rect.y - block.rect.y) <= 8);
        });
      if (overlappingPrevious) {
        // The later block is a duplicate limit/subscript extraction from the
        // same visual formula. Its rectangle can also span surrounding prose,
        // so retain the earlier tight crop instead of taking their union.
        const fragmentSource = unit.sourceText.slice(fragment.absoluteStart, fragment.absoluteEnd);
        const baseVariable = (fragmentSource.match(/\b[A-Za-z]\b/g) ?? [])
          .filter((candidate) => !/^[ij]$/i.test(candidate))
          .at(-1);
        const precedingText = replacementUnits.at(-1);
        if (baseVariable && precedingText?.sourceText) {
          precedingText.sourceText = `${precedingText.sourceText} ${baseVariable}`;
          precedingText.protectedTokens = extractProtectedTokens(precedingText.sourceText);
        }
        cursor = fragment.absoluteEnd;
        continue;
      }
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
        formulaHint: unit.sourceText.slice(fragment.absoluteStart, fragment.absoluteEnd),
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

  // Some detached limit blocks are removed from semantic reading order before
  // they can become formula units. Recover their character geometry directly
  // against the tight inline assets. Assign every glyph to its nearest sibling
  // formula so two equations on adjacent baselines cannot absorb one another.
  const inlineFormulaAssets = assetRegions.filter((asset) => (
    asset.kind === 'formula' && /-inline-formula(?:-\d+)?$/.test(asset.id)
  ));
  const detachedFormulaCandidates = doc.blocks.flatMap((fragmentBlock) => {
    const text = fragmentBlock.text?.trim() ?? '';
    const glyphs = detachedFormulaGlyphs(fragmentBlock, fragmentBlock.pageIndex);
    if (!glyphs.length) return [];
    const page = doc.pages[fragmentBlock.pageIndex];
    if (!page) return [];
    const fragmentRect = unionRects(glyphs.map((character) => character.rect));
    if (!fragmentRect) return [];
    const nearbyAssets = inlineFormulaAssets.filter((asset) => {
      if (asset.pageIndex !== fragmentBlock.pageIndex) return false;
      const horizontalGap = Math.max(
        0,
        fragmentRect.x - (asset.rect.x + asset.rect.w),
        asset.rect.x - (fragmentRect.x + fragmentRect.w),
      );
      const verticalGap = Math.max(
        0,
        fragmentRect.y - (asset.rect.y + asset.rect.h),
        asset.rect.y - (fragmentRect.y + fragmentRect.h),
      );
      return horizontalGap <= 8 && verticalGap <= 8;
    });
    return nearbyAssets.length ? [{ fragmentBlock, page, fragmentRect, nearbyAssets, text, glyphs }] : [];
  });
  for (const candidate of detachedFormulaCandidates) {
    const { fragmentBlock, page, nearbyAssets, text, glyphs } = candidate;
    const sharedCompanion = detachedFormulaCandidates.some((other) => (
      other.fragmentBlock.id !== fragmentBlock.id
      && other.fragmentBlock.pageIndex === fragmentBlock.pageIndex
      && other.nearbyAssets.some((asset) => nearbyAssets.some((current) => current.id === asset.id))
      && (
        (/[∑∫∏]/u.test(text) && /=/u.test(other.text))
        || (/=/u.test(text) && /[∑∫∏]/u.test(other.text))
      )
    ));
    // A lone extracted summation near one inline equation is ambiguous: it can
    // belong to a different line in the same aggregate paragraph. Require one
    // block spanning multiple tight formulas, or a sum/operator block paired
    // with a separate equality/index block at the same formula.
    if (nearbyAssets.length < 2 && !sharedCompanion) continue;
    nearbyAssets.forEach((asset) => (
      absorbDetachedFormulaGlyphs(asset, nearbyAssets, glyphs, page)
    ));
  }

  // Display formulas are often emitted by PDF.js as one small equation anchor
  // plus several late, out-of-order text blocks for limits and subscripts.
  // Reconstruct the visual row from character geometry and remove those
  // duplicate text-layer fragments before pagination.
  const clusteredFormulaRects = new Map<string, Rect>();
  const clusteredFormulaFragmentIds = new Set<string>();
  const clusteredFormulaPrefixIds = new Set<string>();
  const currentUnitIds = new Set(units.map((unit) => unit.id));
  const discardedEmbeddedFormulaIds = new Set<string>();
  for (const unit of units) {
    if (unit.kind !== 'formula' || clusteredFormulaFragmentIds.has(unit.id)) continue;
    const block = blocks.get(unit.id);
    if (!block || verifiedAssetRegions.some((asset) => materiallyCovered(block, asset))) continue;
    const cluster = formulaGlyphCluster(doc, block, currentUnitIds);
    if (!cluster) continue;
    clusteredFormulaRects.set(unit.id, cluster.rect);
    cluster.fragmentIds.forEach((id) => clusteredFormulaFragmentIds.add(id));
    cluster.prefixIds.forEach((id) => clusteredFormulaPrefixIds.add(id));
  }
  if (clusteredFormulaFragmentIds.size) {
    units = units.filter((unit) => !clusteredFormulaFragmentIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((id) => !clusteredFormulaFragmentIds.has(id));
    }
  }
  for (const prefixId of clusteredFormulaPrefixIds) {
    const prefixUnit = units.find((unit) => unit.id === prefixId);
    if (!prefixUnit?.sourceText) continue;
    prefixUnit.sourceText = withoutLeadingFormulaLines(prefixUnit.sourceText);
    prefixUnit.protectedTokens = extractProtectedTokens(prefixUnit.sourceText);
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
      const overlappingTightFormulas = assetRegions.filter((existing) => {
        if (existing.kind !== 'formula' || existing.pageIndex !== block.pageIndex) return false;
        const overlap = intersectionArea(existing.rect, rect);
        const existingArea = Math.max(1, existing.rect.w * existing.rect.h);
        const candidateArea = Math.max(1, rect.w * rect.h);
        return overlap / Math.min(existingArea, candidateArea) >= 0.75;
      });
      if (overlappingTightFormulas.length) {
        // Inline reconstruction already produced a tighter crop for this
        // expression. PDF.js can also emit a later disconnected aggregate
        // whose outer box spans formulas and the prose between them. Individual
        // glyph boxes from that aggregate can still safely complete detached
        // limits/subscripts without freezing its unsafe outer rectangle.
        discardedEmbeddedFormulaIds.add(unit.id);
        continue;
      }
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
        const reclassifiedSource = reclassifiedFormulaSources.get(unit.id);
        const originalSource = reclassifiedSource ?? unit.sourceText;
        const candidateArea = Math.max(1, rect.w * rect.h);
        const embeddedInProseAggregate = reclassifiedSource !== undefined && intersecting.some((candidate) => {
          if (candidate.id === block.id) return false;
          const naturalWords = candidate.text?.match(/[A-Za-z]{3,}/g) ?? [];
          return naturalWords.length >= 8
            && candidate.rect.w * candidate.rect.h >= candidateArea * 2
            && intersectionArea(candidate.rect, rect) / candidateArea >= 0.65;
        });
        if (embeddedInProseAggregate) {
          // The compact math block is a duplicate text-layer extraction from
          // a larger prose aggregate that already carries the sentence. Its
          // disconnected bounding box crosses ordinary words, so neither
          // rendering it as text nor freezing that rectangle is safe.
          discardedEmbeddedFormulaIds.add(unit.id);
        } else if (originalSource) {
          unit.kind = 'paragraph';
          unit.sourceText = originalSource;
          unit.protectedTokens = extractProtectedTokens(originalSource ?? '');
          delete unit.assetId;
        } else {
          // Never leave a text unit without source text: it cannot generate a
          // translation request and would fail later during composition.
          discardedEmbeddedFormulaIds.add(unit.id);
        }
        continue;
      }
    }
    assetRegions.push(candidateAsset);
    if (previousToClean && cleanedPrevious !== undefined) previousToClean.sourceText = cleanedPrevious;
  }
  if (discardedEmbeddedFormulaIds.size) {
    units = units.filter((unit) => !discardedEmbeddedFormulaIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((id) => !discardedEmbeddedFormulaIds.has(id));
    }
  }

  // Parser-confirmed formula assets are constructed after the first cleanup
  // pass above. Re-run the narrow fragment test against those new assets so a
  // piecewise equation split into `formula first row + paragraph tail` cannot
  // leave its stacked subscripts, equation number, and closing brace as a
  // translated text block (for example `res / T otal / N = ...`). Never
  // remove another formula owner here; adjacent equations remain independent.
  const deterministicFormulaFragmentIds = new Set(units
    .filter((unit) => ['paragraph', 'abstract', 'list-item'].includes(unit.kind))
    .filter((unit) => {
      const block = blocks.get(unit.sourceBlockId ?? unit.id);
      if (!block) return false;
      return assetRegions.some((asset) => (
        asset.kind === 'formula'
        && asset.id !== unit.assetId
        && asset.id !== block.id
        && isFormulaExtractionFragment(block, asset)
      ));
    })
    .map((unit) => unit.id));
  if (deterministicFormulaFragmentIds.size) {
    units = units.filter((unit) => !deterministicFormulaFragmentIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds
        .filter((id) => !deterministicFormulaFragmentIds.has(id));
    }
  }

  // PDF text extraction can detach an inline cross-reference at a column
  // boundary and the semantic classifier can then mistake the tiny fragment
  // for a table caption. Rejoin only the unambiguous form: a mixed-case bare
  // `Table N.` immediately after prose ending in “shown/presented in”. Real
  // IEEE table captions use a title/header and do not complete that sentence.
  const detachedTableReferenceIds = new Set<string>();
  for (const reference of units.filter((unit) => (
    unit.kind === 'caption'
    && /^Table\s+(?:[IVXLCDM]+|\d+)\s*[.:]?$/u.test(unit.sourceText?.trim() ?? '')
  ))) {
    const referenceBlock = blocks.get(reference.id);
    const region = regions.find((candidate) => candidate.id === reference.layoutRegionId);
    const referenceIndex = region?.orderedUnitIds.indexOf(reference.id) ?? -1;
    const previousId = referenceIndex > 0 ? region!.orderedUnitIds[referenceIndex - 1] : undefined;
    const previous = previousId ? units.find((unit) => unit.id === previousId) : undefined;
    const previousBlock = previousId ? blocks.get(previousId) : undefined;
    if (
      !referenceBlock || !region || !previous || !previousBlock
      || !['paragraph', 'abstract', 'list-item'].includes(previous.kind)
      || previousBlock.pageIndex !== referenceBlock.pageIndex
      || !sameVisualColumn(previousBlock, referenceBlock, doc.pages[referenceBlock.pageIndex]?.width ?? doc.meta.paperWidth)
      || referenceBlock.rect.y - (previousBlock.rect.y + previousBlock.rect.h) < -1
      || referenceBlock.rect.y - (previousBlock.rect.y + previousBlock.rect.h) > 6
      || !/\b(?:shown|presented|summarized|reported|listed|given|provided|described)\s+in\s*$/iu.test(previous.sourceText ?? '')
    ) continue;
    previous.sourceText = `${previous.sourceText!.trimEnd()} ${reference.sourceText!.trim()}`;
    previous.protectedTokens = extractProtectedTokens(previous.sourceText);
    detachedTableReferenceIds.add(reference.id);
  }
  if (detachedTableReferenceIds.size) {
    units = units.filter((unit) => !detachedTableReferenceIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds
        .filter((id) => !detachedTableReferenceIds.has(id));
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
    const recoveredCaption = recoverSplitColumnCaption(doc, captionBlock);
    const captionAnchor = recoveredCaption?.anchor ?? captionBlock;
    if (recoveredCaption) {
      caption.sourceText = recoveredCaption.sourceText;
      caption.protectedTokens = extractProtectedTokens(recoveredCaption.sourceText);
      const continuationIds = new Set(recoveredCaption.continuationIds);
      units = units.filter((unit) => !continuationIds.has(unit.id));
      for (const candidateRegion of regions) {
        candidateRegion.orderedUnitIds = candidateRegion.orderedUnitIds
          .filter((unitId) => !continuationIds.has(unitId));
      }
    }
    const captionIndex = region.orderedUnitIds.indexOf(caption.id);
    const pageWidth = doc.pages[captionAnchor.pageIndex]?.width ?? doc.meta.paperWidth;
    const previousBlock = [...region.orderedUnitIds.slice(0, captionIndex)]
      .reverse().map((id) => blocks.get(id)).find((block) => (
        block?.pageIndex === captionAnchor.pageIndex
        && sameVisualColumn(block, captionAnchor, pageWidth)
      ));
    const bottom = captionAnchor.rect.y - 6;
    const furnitureBoundary = doc.blocks
      .filter((block) => (
        block.pageIndex === captionAnchor.pageIndex
        && furnitureIds.has(block.id)
        && block.rect.y + block.rect.h <= bottom
        && block.rect.x < captionAnchor.rect.x + captionAnchor.rect.w
        && block.rect.x + block.rect.w > captionAnchor.rect.x
      ))
      .reduce((boundary, block) => Math.max(boundary, block.rect.y + block.rect.h + 6), 0);
    const previousBoundary = previousBlock ? previousBlock.rect.y + previousBlock.rect.h + 6 : 0;
    const visualLabelTop = doc.blocks
      .filter((block) => (
        block.pageIndex === captionAnchor.pageIndex
        && block.id !== caption.id
        && block.rect.y < bottom
        && block.rect.x < captionAnchor.rect.x + captionAnchor.rect.w
        && block.rect.x + block.rect.w > captionAnchor.rect.x
      ))
      .flatMap((block) => {
        const clusterTop = trailingVisualLabelClusterTop(block);
        if (clusterTop !== undefined) return [clusterTop];
        return looksLikeVisualLabels(block) ? [Math.max(1, block.rect.y - 6)] : [];
      })
      .reduce((boundary, top) => Math.min(boundary, top), Number.POSITIVE_INFINITY);
    const previousColumnProseBottom = previousProseBottomInCaptionColumn(doc, captionAnchor);
    const previousTableBottom = precedingTableBodyBottom(doc, captionAnchor);
    const previousPhysicalBottom = recoveredCaption
      ? previousPhysicalContentBottom(doc, captionAnchor)
      : undefined;
    const inferredTop = Math.max(
      furnitureBoundary,
      previousColumnProseBottom !== undefined ? previousColumnProseBottom + 6 : 0,
      previousTableBottom !== undefined ? previousTableBottom + 6 : 0,
      previousPhysicalBottom !== undefined ? previousPhysicalBottom + 6 : 0,
      Number.isFinite(visualLabelTop)
        ? visualLabelTop
        : (doc.pages[captionAnchor.pageIndex]?.height ?? doc.meta.paperHeight) * 0.1,
    );
    const top = previousBlock && previousBoundary < bottom - 24
      ? Math.max(previousBoundary, inferredTop)
      : inferredTop;
    if (bottom - top < 24) {
      const previousId = previousBlock?.id ?? 'none';
      const previousText = previousBlock?.text?.replace(/\s+/g, ' ').slice(0, 48) ?? 'none';
      throw new Error(
        `无法可靠确定图 ${caption.id} 的不可变区域（前块 ${previousId}“${previousText}”，可用高度 ${Math.round(bottom - top)}pt）`,
      );
    }
    const id = `${caption.id}-asset`;
    const widthMode = captionAnchor.widthMode;
    const column = visualColumnBounds(doc, captionAnchor);
    assetRegions.push({
      id, kind: 'figure', pageIndex: captionAnchor.pageIndex,
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
    const recoveredCaption = recoverColumnCaptionContinuation(doc, captionBlock);
    if (recoveredCaption) {
      caption.sourceText = recoveredCaption.sourceText;
      caption.protectedTokens = extractProtectedTokens(recoveredCaption.sourceText);
      const continuationIds = new Set(recoveredCaption.continuationIds);
      units = units.filter((unit) => !continuationIds.has(unit.id));
      for (const candidateRegion of regions) {
        candidateRegion.orderedUnitIds = candidateRegion.orderedUnitIds
          .filter((unitId) => !continuationIds.has(unitId));
      }
    }
    const pageWidth = doc.pages[captionBlock.pageIndex]?.width ?? doc.meta.paperWidth;
    const captionBottom = captionBlock.rect.y + captionBlock.rect.h;
    const bodyIds: string[] = [];
    const precedingGeometry = precedingTableGeometry(doc, captionBlock);
    const spanningGeometry = centeredSpanningTableGeometry(doc, captionBlock);
    let top = precedingGeometry?.rect.y ?? spanningGeometry?.rect.y ?? captionBottom + 6;
    let bottom: number;
    let column = precedingGeometry
      ? { x: precedingGeometry.rect.x, w: precedingGeometry.rect.w }
      : spanningGeometry
      ? { x: spanningGeometry.rect.x, w: spanningGeometry.rect.w }
      : visualColumnBounds(doc, captionBlock);
    let widthMode = spanningGeometry ? 'span' as const : captionBlock.widthMode;
    if (precedingGeometry) {
      bottom = precedingGeometry.rect.y + precedingGeometry.rect.h;
    } else if (spanningGeometry) {
      bottom = spanningGeometry.rect.y + spanningGeometry.rect.h;
      bodyIds.push(...spanningGeometry.bodyIds);
    } else {
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
        const isolatedSpanningBody = bodyIds.length > 0
          && (captionBlock.widthMode === 'span' || region.mode === 'full-width')
          && bodyIds.every((id) => {
            const block = blocks.get(id);
            return Boolean(block && (looksLikeNumericTableBody(block) || looksLikeShortTableCellLabel(block)));
          })
          && region.orderedUnitIds.every((id) => id === caption.id || bodyIds.includes(id));
        // A full-width table can own an isolated parser region that ends at
        // the last numeric row. In that case there is deliberately no
        // same-column prose boundary: the region membership itself is the
        // deterministic lower boundary (SZKP Tables 7-9).
        if (!bodyIds.length || (!boundaryFound && !isolatedSpanningBody)) {
          throw new Error(`无法可靠确定表 ${caption.id} 的不可变区域（未检测到表后边界）`);
        }
        const lastBody = blocks.get(bodyIds.at(-1)!)!;
        bottom = lastBody.rect.y + lastBody.rect.h + 6;
      }
    }
    // A full-width table can be split by PDF.js into a shallow span header and
    // a separate column-classified numeric body. Keep a valid header-height
    // seed here; the attached-table pass below expands it through the numeric
    // rows before final geometry validation. Requiring 18pt at this point
    // rejects real two-row headers (MSMAC Table 3 was 15.4pt high).
    if (bottom - top < 12) throw new Error(`无法可靠确定表 ${caption.id} 的不可变区域（高度不足）`);

    const id = `${caption.id}-asset`;
    assetRegions.push({
      id, kind: 'table', pageIndex: captionBlock.pageIndex,
      rect: { x: column.x, y: top, w: column.w, h: bottom - top },
      widthMode, captionUnitId: caption.id,
    });
    units = units.filter((unit) => !bodyIds.includes(unit.id));
    for (const candidateRegion of regions) {
      candidateRegion.orderedUnitIds = candidateRegion.orderedUnitIds.filter((unitId) => !bodyIds.includes(unitId));
    }
    units.push({
      id, kind: 'table', protectedTokens: [], assetId: id,
      layoutRegionId: caption.layoutRegionId, order: caption.order + (precedingGeometry ? -0.1 : 0.1),
    });
    const captionIndex = region.orderedUnitIds.indexOf(caption.id);
    region.orderedUnitIds.splice(captionIndex + (precedingGeometry ? 0 : 1), 0, id);
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

  // Caption-derived table crops can be bounded from only one parser column
  // even when the physical table spans both columns. Extend a shallow crop
  // through an attached block of short labels/numeric cells before applying
  // the final text mask. Natural-language paragraphs do not satisfy the
  // visual-label predicate, so they remain outside the immutable region.
  for (const asset of assetRegions) {
    if (asset.kind !== 'table') continue;
    const captionDerived = !verifiedAssetRegions.includes(asset);
    const assetBottom = asset.rect.y + asset.rect.h;
    const continuations = doc.blocks.filter((block) => {
      if (block.pageIndex !== asset.pageIndex || block.id === asset.captionUnitId) return false;
      const horizontalOverlap = Math.max(0, Math.min(
        block.rect.x + block.rect.w,
        asset.rect.x + asset.rect.w,
      ) - Math.max(block.rect.x, asset.rect.x));
      const numericTokens = block.text?.match(/\d+(?:[.,]\d+)?/g) ?? [];
      return horizontalOverlap / Math.max(1, Math.min(block.rect.w, asset.rect.w)) >= 0.2
        && block.rect.y <= assetBottom + 4
        && block.rect.y + block.rect.h > assetBottom + 2
        && (looksLikeVisualLabels(block) || (captionDerived && looksLikeNumericTableBody(block)))
        && numericTokens.length >= 2;
    });
    if (!continuations.length) continue;
    const left = Math.min(asset.rect.x, ...continuations.map((block) => block.rect.x));
    const right = Math.max(
      asset.rect.x + asset.rect.w,
      ...continuations.map((block) => block.rect.x + block.rect.w),
    );
    const bottom = Math.max(
      assetBottom,
      ...continuations.map((block) => block.rect.y + block.rect.h + 2),
    );
    asset.rect = { ...asset.rect, x: left, w: right - left, h: bottom - asset.rect.y };
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
    const blockingGeometryIssues = portraitPages.has(asset.pageIndex) && isPortraitAsset(doc, asset)
      ? geometry.issues.filter((issue) => issue !== 'body-prose-density')
      : geometry.issues;
    if (blockingGeometryIssues.length) {
      const rect = [asset.rect.x, asset.rect.y, asset.rect.w, asset.rect.h]
        .map((value) => Number(value.toFixed(2))).join(',');
      throw new Error(`不可变资产 ${asset.id} 几何校验失败（第 ${asset.pageIndex + 1} 页：${blockingGeometryIssues.join(', ')}；bbox=${rect}）`);
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
    const portraitPage = candidates.length >= 3
      && candidates.every((asset) => isPortraitAsset(doc, asset))
      && isAuthorBiographyPage(doc, candidates[0]!.pageIndex);
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
        if ((portraitPage && isPortraitAsset(doc, anchor) && isPortraitAsset(doc, candidate))
          || (Math.abs(candidate.rect.y - anchor.rect.y) <= 12
            && overlap / Math.max(1, Math.min(anchor.rect.h, candidate.rect.h)) >= 0.6)) {
          band.push(candidate);
          pending.splice(index, 1);
        }
      }
      if (band.length < 2) continue;
      band.sort((left, right) => left.rect.x - right.rect.x || left.rect.y - right.rect.y);
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
    const normalized = normalizePdfNumericSpacing(unit.sourceText, unit.kind === 'heading');
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
