import type {
  Doc,
  LayoutRegion,
  SemanticUnit,
  SemanticUnitKind,
} from '../../types/models';
import type { DetectedAssetRegion } from '../assets/extract';
import { buildSourceSentenceCandidates } from '../align/sourceSentences';
import { extractProtectedTokens } from '../translate/protected';
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

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('DeepSeek JSON 字段必须为数组');
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`DeepSeek JSON 缺少 ${field}`);
  return value;
}

export function normalizeDeepSeekTranslationResponse(input: unknown): TranslationResponse {
  if (!input || typeof input !== 'object') throw new Error('DeepSeek 未返回 JSON 对象');
  const root = input as Record<string, unknown>;
  return {
    blocks: array(root.blocks).map((raw) => {
      if (!raw || typeof raw !== 'object') throw new Error('DeepSeek blocks 项无效');
      const block = raw as Record<string, unknown>;
      const groups = block.alignmentGroups ?? block.alignment_groups;
      const terms = block.newTerms ?? block.new_terms ?? [];
      return {
        blockId: text(block.blockId ?? block.block_id, 'block_id'),
        translation: text(block.translation, 'translation'),
        alignmentGroups: array(groups).map((rawGroup) => {
          const group = rawGroup as Record<string, unknown>;
          return {
            sourceSentenceIds: array(group.sourceSentenceIds ?? group.source_sentence_ids).map((id) => text(id, 'source_sentence_id')),
            targetSegments: array(group.targetSegments ?? group.target_segments).map((segment) => text(segment, 'target_segment')),
          };
        }),
        newTerms: array(terms).map((rawTerm) => {
          const term = rawTerm as Record<string, unknown>;
          return {
            source: text(term.source, 'term.source'),
            target: text(term.target, 'term.target'),
            abbreviation: typeof term.abbreviation === 'string' ? term.abbreviation : undefined,
          };
        }),
        warnings: array(block.warnings ?? []).map((warning) => text(warning, 'warning')),
      };
    }),
  };
}

export interface PreparedImmutableStructure {
  regions: LayoutRegion[];
  units: SemanticUnit[];
  assetRegions: DetectedAssetRegion[];
}

export function prepareImmutableStructure(doc: Doc): PreparedImmutableStructure {
  const regions = doc.layoutRegions.map((region) => ({ ...region, orderedUnitIds: [...region.orderedUnitIds] }));
  const units = doc.semanticUnits.map((unit) => ({ ...unit, protectedTokens: [...unit.protectedTokens] }));
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  const assetRegions: DetectedAssetRegion[] = [];

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

  for (const caption of units.filter((unit) => unit.kind === 'caption' && /^fig(?:ure)?\.?\s*\d+/i.test(unit.sourceText ?? ''))) {
    const captionBlock = blocks.get(caption.id);
    const region = regions.find((candidate) => candidate.id === caption.layoutRegionId);
    if (!captionBlock || !region) throw new Error(`图注 ${caption.id} 缺少版式坐标`);
    const captionIndex = region.orderedUnitIds.indexOf(caption.id);
    const previousBlock = [...region.orderedUnitIds.slice(0, captionIndex)]
      .reverse().map((id) => blocks.get(id)).find((block) => block?.pageIndex === captionBlock.pageIndex);
    const top = previousBlock ? previousBlock.rect.y + previousBlock.rect.h + 6 : region.bounds.y;
    const bottom = captionBlock.rect.y - 6;
    if (bottom - top < 24) {
      const previousId = previousBlock?.id ?? 'none';
      const previousText = previousBlock?.text?.replace(/\s+/g, ' ').slice(0, 48) ?? 'none';
      throw new Error(
        `无法可靠确定图 ${caption.id} 的不可变区域（前块 ${previousId}“${previousText}”，可用高度 ${Math.round(bottom - top)}pt）`,
      );
    }
    const id = `${caption.id}-asset`;
    const widthMode = captionBlock.widthMode;
    assetRegions.push({
      id, kind: 'figure', pageIndex: captionBlock.pageIndex,
      rect: { x: captionBlock.rect.x, y: top, w: captionBlock.rect.w, h: bottom - top },
      widthMode, captionUnitId: caption.id,
    });
    units.push({
      id, kind: 'figure', protectedTokens: [], assetId: id,
      layoutRegionId: caption.layoutRegionId, order: caption.order - 0.1,
    });
    region.orderedUnitIds.splice(captionIndex, 0, id);
  }

  return {
    regions,
    units: units.sort((left, right) => left.order - right.order),
    assetRegions,
  };
}
