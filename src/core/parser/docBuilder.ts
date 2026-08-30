// ============================================================================
// docBuilder.ts —— 跨页装配:逐页解析结果 -> 统一 Doc
// 算法基准:P7 探针(合成双页夹具 8 项断言全部通过)。纯函数、零依赖。
// ============================================================================
import type {
  Block, BlockFragment, CharacterRect, Doc, LayoutMode, PageInfo, Rect, SemanticUnitKind,
} from '../../types/models';
import { buildLayoutRegions } from '../layout/regions';
import type { ColumnKind } from './columns';

/** 单页解析器产物(由 parsePageItems + regions 检测装配而来) */
export interface ParsedPageBlock {
  id: string;
  type: Block['type'];
  col: ColumnKind;
  rect: Rect;
  text: string;
  characterRects?: CharacterRect[];
}

export interface ParsedPage {
  no: number;
  w: number;
  h: number;
  layoutMode: LayoutMode;
  blocks: ParsedPageBlock[];
}

type WorkBlock = ParsedPageBlock & {
  pageIndex: number;
  fragments: BlockFragment[];
  prevBlockId?: string;
  nextBlockId?: string;
  parentSectionId?: string;
  widthMode: 'span' | 'column';
  splitAllowed: boolean;
  order: number;
};

const COL_RANK: Record<ColumnKind, number> = { full: 0, left: 1, right: 2 };
const ATOMIC_TYPES = new Set<Block['type']>(['figure', 'table', 'equation', 'caption']);

function isContinuable(b: ParsedPageBlock): boolean {
  return (
    b.type === 'paragraph' &&
    !/[。！？.!?；;:：]$/.test((b.text || '').trim()) &&
    b.text.trim().length > 0
  );
}

function startsLikeHeading(b: ParsedPageBlock): boolean {
  const t = (b.text || '').trim();
  return (
    /^\s*(\d+(\.\d+)*|IV|V|VI|VII|VIII|IX|X)\s+[A-Z\u4e00-\u9fa5]/.test(t) ||
    /^(fig(ure)?\.?|table|algorithm)\s*\d+/i.test(t) ||
    /^[图表]\s*\d+/.test(t)
  );
}

function lastFragmentPage(b: WorkBlock): number {
  return b.fragments[b.fragments.length - 1]?.pageIndex ?? b.pageIndex;
}

function liesAcrossPageBoundary(
  previous: WorkBlock,
  next: WorkBlock,
  pageHeights: ReadonlyMap<number, number>,
): boolean {
  const previousRect = previous.fragments.at(-1)?.rect ?? previous.rect;
  const pageHeight = pageHeights.get(lastFragmentPage(previous)) ?? 792;
  return previousRect.y + previousRect.h >= pageHeight * 0.72
    && next.rect.y <= pageHeight * 0.35;
}

/** 两遍法合并:先接上一页阅读顺序末尾→下一页开头,再接同页左→右栏 */
function mergePass(
  list: WorkBlock[],
  allowCrossPage: boolean,
  allowCrossCol: boolean,
  pageHeights: ReadonlyMap<number, number>,
): WorkBlock[] {
  const out: WorkBlock[] = [];
  const seenPages = new Set<number>();
  for (const b of list) {
    const firstInPage = !seenPages.has(b.pageIndex);
    seenPages.add(b.pageIndex);
    const prev = out[out.length - 1];
    if (
      prev &&
      isContinuable(prev) &&
      b.type === 'paragraph' &&
      !startsLikeHeading(b)
    ) {
      const crossPage =
        allowCrossPage &&
        firstInPage &&
        b.pageIndex === lastFragmentPage(prev) + 1 &&
        liesAcrossPageBoundary(prev, b, pageHeights);
      const crossCol =
        allowCrossCol &&
        b.pageIndex === lastFragmentPage(prev) &&
        prev.col === 'left' &&
        b.col === 'right' &&
        liesAcrossPageBoundary(prev, b, pageHeights);
      if (crossPage || crossCol) {
        const sourceOffset = (prev.text || '').length + 1;
        prev.text = `${prev.text || ''}\n${b.text || ''}`;
        prev.fragments.push({ pageIndex: b.pageIndex, rect: b.rect });
        prev.characterRects = [
          ...(prev.characterRects ?? []),
          ...(b.characterRects ?? []).map((char) => ({
            ...char,
            sourceIndex: char.sourceIndex + sourceOffset,
          })),
        ];
        continue;
      }
    }
    out.push({
      ...b,
      fragments: b.fragments.length
        ? [...b.fragments]
        : [{ pageIndex: b.pageIndex, rect: b.rect }],
    });
  }
  return out;
}

export function buildDoc(pages: ParsedPage[], docId: 'en' | 'zh'): Doc {
  // 1) 每页按阅读顺序展开成带 pageIndex 的全局序列
  const seq: WorkBlock[] = [];
  for (const pg of pages) {
    const sorted = [...pg.blocks].sort(
      (a, b) => COL_RANK[a.col] - COL_RANK[b.col] || a.rect.y - b.rect.y,
    );
    for (const b of sorted) {
      seq.push({
        ...b,
        pageIndex: pg.no,
        characterRects: b.characterRects?.map((char) => ({
          ...char,
          pageIndex: pg.no - 1,
        })),
        fragments: [],
        widthMode: 'column',
        splitAllowed: true,
        order: -1,
      });
    }
  }

  // 2) 续接合并:第一遍跨页阅读顺序末尾→开头,第二遍同页左→右
  const pageHeights = new Map(pages.map((page) => [page.no, page.h] as const));
  const merged = mergePass(
    mergePass(seq, true, false, pageHeights),
    false,
    true,
    pageHeights,
  );

  // 3) 两遍赋值:先统一换新 id,再建 prev/next 链与章节归属
  //    (不能在单遍里取 merged[i+1].id,否则拿到的是尚未替换的旧 id)
  merged.forEach((b, i) => {
    b.id = `blk-${i + 1}`;
    b.order = i;
    b.pageIndex = b.fragments[0].pageIndex;
    b.widthMode = b.col === 'full' ? 'span' : 'column';
    b.splitAllowed = !ATOMIC_TYPES.has(b.type);
  });
  let currentSectionId: string | undefined;
  merged.forEach((b, i) => {
    b.prevBlockId = i > 0 ? merged[i - 1].id : undefined;
    b.nextBlockId = i < merged.length - 1 ? merged[i + 1].id : undefined;
    if (b.type === 'section') {
      currentSectionId = b.id;
      b.parentSectionId = currentSectionId;
    } else {
      b.parentSectionId = currentSectionId;
    }
  });

  // 4) 版式:整体 = 任一页 mixed 则 mixed;否则任一页 double 则 double
  const layoutMode: LayoutMode = pages.some((p) => p.layoutMode === 'mixed')
    ? 'mixed'
    : pages.some((p) => p.layoutMode === 'double')
      ? 'double'
      : 'single';

  const pageInfos: PageInfo[] = pages.map((p) => ({
    pageIndex: p.no - 1,
    width: p.w,
    height: p.h,
    columns: [], // 由栏检测结果回填(本模块不负责)
  }));

  const blocks: Block[] = merged.map((b) => ({
    id: b.id,
    docId,
    type: b.type,
    pageIndex: b.pageIndex,
    rect: b.rect,
    order: b.order,
    prevBlockId: b.prevBlockId,
    nextBlockId: b.nextBlockId,
    fragments: b.fragments,
    text: b.text,
    characterRects: b.characterRects,
    widthMode: b.widthMode,
    parentSectionId: b.parentSectionId,
    splitAllowed: b.splitAllowed,
  }));

  const layoutRegions = buildLayoutRegions({
    pageWidth: pages[0]?.w ?? 0,
    pageModes: Object.fromEntries(pages.map((page) => [page.no, page.layoutMode])),
    blocks: merged.map((block) => ({
      id: block.id,
      pageIndex: block.pageIndex,
      order: block.order,
      col: block.col,
      rect: block.rect,
    })),
  });
  const regionByUnit = new Map(
    layoutRegions.flatMap((region) => region.orderedUnitIds.map((id) => [id, region.id] as const)),
  );
  const semanticKind: Record<Block['type'], SemanticUnitKind> = {
    title: 'title', authors: 'author', abstract: 'abstract', keywords: 'paragraph',
    section: 'heading', paragraph: 'paragraph', figure: 'figure', table: 'table',
    equation: 'formula', caption: 'caption', reference: 'reference', other: 'paragraph',
  };
  const semanticUnits = blocks.map((block) => ({
    id: block.id,
    parentId: block.parentSectionId,
    kind: semanticKind[block.type],
    sourceText: block.text,
    protectedTokens: [],
    assetId: ['figure', 'table', 'equation'].includes(block.type) ? block.id : undefined,
    layoutRegionId: regionByUnit.get(block.id)!,
    order: block.order,
  }));

  return {
    id: docId,
    role: docId === 'zh' ? 'zh' : 'en',
    pageCount: pages.length,
    pages: pageInfos,
    blocks,
    layoutRegions,
    semanticUnits,
    layoutMode,
    meta: {
      paperWidth: pages[0]?.w ?? 0,
      paperHeight: pages[0]?.h ?? 0,
      title: blocks.find((b) => b.type === 'title')?.text,
    },
  };
}
