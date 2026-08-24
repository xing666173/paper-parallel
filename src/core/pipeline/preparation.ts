import type {
  Doc,
  LayoutRegion,
  SemanticUnit,
  SemanticUnitKind,
} from '../../types/models';
import type { DetectedAssetRegion } from '../assets/extract';
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
    .filter((unit) => !IMMUTABLE_KINDS.has(unit.kind) && Boolean(unit.sourceText?.trim()))
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

function visualColumnBounds(doc: Doc, anchor: Doc['blocks'][number]): { x: number; w: number } {
  const pageWidth = doc.pages[anchor.pageIndex]?.width ?? doc.meta.paperWidth;
  const columnBlocks = doc.blocks.filter((block) => (
    block.pageIndex === anchor.pageIndex && sameVisualColumn(block, anchor, pageWidth)
  ));
  if (!columnBlocks.length) return { x: anchor.rect.x, w: anchor.rect.w };
  const x = Math.min(...columnBlocks.map((block) => block.rect.x));
  const right = Math.max(...columnBlocks.map((block) => block.rect.x + block.rect.w));
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

export function prepareImmutableStructure(doc: Doc): PreparedImmutableStructure {
  const regions = doc.layoutRegions.map((region) => ({ ...region, orderedUnitIds: [...region.orderedUnitIds] }));
  let units = doc.semanticUnits.map((unit) => ({ ...unit, protectedTokens: [...unit.protectedTokens] }));
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  const assetRegions: DetectedAssetRegion[] = [];
  const furnitureIds = detectedPageFurnitureIds(doc);
  if (furnitureIds.size) {
    units = units.filter((unit) => !furnitureIds.has(unit.id));
    for (const region of regions) {
      region.orderedUnitIds = region.orderedUnitIds.filter((unitId) => !furnitureIds.has(unitId));
    }
  }

  for (const unit of units) {
    if (unit.kind !== 'formula' && unit.kind !== 'code' && unit.kind !== 'page-furniture') continue;
    const block = blocks.get(unit.id);
    if (!block) throw new Error(`不可变资产 ${unit.id} 缺少源坐标`);
    assetRegions.push({
      id: unit.assetId ?? unit.id,
      kind: unit.kind,
      pageIndex: block.pageIndex,
      rect: { ...block.rect },
      widthMode: block.widthMode,
    });
  }

  for (const caption of units.filter((unit) => unit.kind === 'caption' && isFigureCaptionText(unit.sourceText ?? ''))) {
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
    const top = previousBlock && previousBoundary < bottom - 24 ? previousBoundary : furnitureBoundary;
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

  for (const caption of units.filter((unit) => unit.kind === 'caption' && isTableCaptionText(unit.sourceText ?? ''))) {
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

  return {
    regions,
    units: units.sort((left, right) => left.order - right.order),
    assetRegions,
  };
}
