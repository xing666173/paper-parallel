// ============================================================================
// blocks.ts —— 行 -> 块切分
// 算法基准:P5 探针(合成夹具断言已通过)。纯函数、零依赖。
// 块级保序 R5:同栏按 y 归块,跨栏按 通栏→左→右 的阅读顺序输出。
// ============================================================================
import type { ClassifiedLine, ColumnKind } from './columns';
import type { BlockType, CharacterRect, Rect } from '../../types/models';
import { itemsToCharRects } from './charRects';

/** 解析器产出的原始块(尚未装配 docId/pageIndex 等文档上下文) */
export interface RawBlock {
  id: string;
  type: BlockType;
  col: ColumnKind;
  rect: Rect;
  text: string;
  lineCount: number;
  order: number;
  characterRects?: CharacterRect[];
}

const COLUMN_ORDER: ColumnKind[] = ['full', 'left', 'right'];

export interface ColumnBounds {
  min: number;
  max: number;
}

function hasCaptionSuffix(suffix: string | undefined): boolean {
  if (suffix === undefined) return false;
  const trimmed = suffix.trimStart();
  if (!trimmed) return true;
  if (/^[:：.\-–—]/.test(trimmed)) return true;
  return trimmed.length < suffix.length && /^[A-Z\u4e00-\u9fff]/.test(trimmed);
}

export function isFigureCaptionText(text: string): boolean {
  return hasCaptionSuffix(text.trim().match(/^fig(?:ure)?\.?\s*(?:\d+|[IVXLCDM]+)(.*)$/i)?.[1]);
}

export function isTableCaptionText(text: string): boolean {
  return hasCaptionSuffix(text.trim().match(/^table\s*(?:\d+|[IVXLCDM]+)(.*)$/i)?.[1]);
}

function isNumberedCaptionText(text: string): boolean {
  const trimmed = text.trim();
  return isFigureCaptionText(trimmed)
    || isTableCaptionText(trimmed)
    || hasCaptionSuffix(trimmed.match(/^algorithm\s*(?:\d+|[IVXLCDM]+)(.*)$/i)?.[1])
    || hasCaptionSuffix(trimmed.match(/^[图表]\s*(?:\d+|[IVXLCDM]+)(.*)$/i)?.[1]);
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}

export function isDisplayFormulaCandidate(text: string, centered: boolean): boolean {
  if (!centered) return false;
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 180) return false;

  const naturalWords = normalized.match(/[A-Za-z]{3,}/g) ?? [];
  if (naturalWords.length > 5) return false;

  const relations = normalized.match(/(?:=|≠|≈|≤|≥|<|>)/g) ?? [];
  const operators = normalized.match(/[+*/^{}×÷√∑∫]/g) ?? [];
  const variables = normalized.match(/(?:^|[\s,(])[A-Za-z](?:_[A-Za-z0-9]+)?(?=$|[\s,)=+*/^])/g) ?? [];
  const numbered = /\(\d+[a-z]?\)\s*$/i.test(normalized);
  const mathScore = relations.length * 2 + operators.length + Math.min(variables.length, 3);

  if (relations.length && mathScore >= 3) return true;
  if (numbered && mathScore >= 3) return true;
  return naturalWords.length <= 2 && mathScore >= 5;
}

function classifyLineRole(l: ClassifiedLine, col: ColumnBounds): RawBlock['type'] {
  const t = l.text.trim();
  const colCenter = (col.min + col.max) / 2;
  const lineCenter = (l.x1 + l.x2) / 2;
  const centered = Math.abs(lineCenter - colCenter) <= Math.max(20, (col.max - col.min) * 0.12);

  // 通栏区:标题/作者/摘要/关键词
  if (l.col === 'full') {
    if (/^(abstract|摘要)[\s—\-:：]/i.test(t)) return 'abstract';
    if (/^key ?words|^关键词/i.test(t)) return 'keywords';
    if (/[,，]/.test(t) && /university|大学|学院|实验室|lab/i.test(t)) return 'authors';
    if (t.length < 90 && l.h >= 14) return 'title';
  }

  // 章节标题:数字编号 + 短文本;排除"2021 IEEE..."这类文献行(含逗号/句末标点)
  if (
    /^\s*(\d+(\.\d+)*|IV|V|VI|VII|VIII|IX|X)\s+[A-Z\u4e00-\u9fa5]/.test(t) &&
    t.length < 80 &&
    !/[.!?。！？]$/.test(t) &&
    !/[,;]/.test(t)
  )
    return 'section';
  if (/^(references|bibliography|acknowledge?ments?|参考文献|致谢)\s*$/i.test(t)) return 'section';

  // 图表题注
  if (isNumberedCaptionText(t))
    return 'caption';

  // 独立公式:短、居中、含数学符号或右端编号
  if (isDisplayFormulaCandidate(t, centered)) return 'equation';

  // 参考文献
  if (/^\[\d+\]/.test(t)) return 'reference';

  return 'paragraph';
}

/**
 * 行 -> 块。断块规则:
 * - 角色变化(标题/题注/公式/正文)立即断块
 * - 同角色但垂直空白 > max(栏内中位行距*1.4, 行高中位数*1.5, 18px) 断块
 * - 块输出顺序:通栏 → 左栏 → 右栏(栏内 y 升序)
 */
export function groupLinesToBlocks(
  lines: ClassifiedLine[],
  pageW: number,
  _pageH: number,
): RawBlock[] {
  const byCol: Record<ColumnKind, ClassifiedLine[]> = { full: [], left: [], right: [] };
  for (const l of lines) byCol[l.col].push(l);

  // 每个栏的 x 范围(由该栏行坐标推算)
  const colBounds: Record<ColumnKind, ColumnBounds> = {
    full: { min: 0, max: pageW },
    left: { min: 0, max: pageW / 2 },
    right: { min: pageW / 2, max: pageW },
  };
  for (const c of COLUMN_ORDER) {
    const arr = byCol[c];
    if (arr.length) {
      colBounds[c] = {
        min: Math.min(...arr.map((l) => l.x1)),
        max: Math.max(...arr.map((l) => l.x2)),
      };
    }
  }

  const blocks: RawBlock[] = [];
  let n = 0;
  const push = (type: RawBlock['type'], ls: ClassifiedLine[]) => {
    if (!ls.length) return;
    const y1 = Math.min(...ls.map((l) => l.y));
    const y2 = Math.max(...ls.map((l) => l.y + l.h));
    const x1 = Math.min(...ls.map((l) => l.x1));
    const x2 = Math.max(...ls.map((l) => l.x2));
    const characterRects: CharacterRect[] = [];
    let sourceOffset = 0;
    ls.forEach((line, lineIndex) => {
      if (lineIndex > 0) sourceOffset += 1; // block text joins visual lines with "\n"
      const chars = itemsToCharRects(line.items, {
        pageIndex: 0,
        sourceOffset,
        itemSeparator: ' ',
      });
      characterRects.push(...chars.map((char) => ({
        ch: char.ch,
        sourceIndex: char.sourceIndex!,
        pageIndex: 0,
        rect: { x: char.x, y: char.y, w: char.w, h: char.h },
      })));
      sourceOffset += line.text.length;
    });
    blocks.push({
      id: `blk${++n}`,
      type,
      col: ls[0].col,
      rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
      text: ls.map((l) => l.text).join('\n'),
      lineCount: ls.length,
      order: -1,
      characterRects,
    });
  };

  for (const c of COLUMN_ORDER) {
    const arr = byCol[c];
    if (!arr.length) continue;
    arr.sort((a, b) => a.y - b.y);

    const gaps: number[] = [];
    for (let i = 1; i < arr.length; i++) gaps.push(arr[i].y - arr[i - 1].y);
    const medianGap = gaps.length ? median(gaps) : 12;
    const lineH = median(arr.map((l) => l.h));
    const BREAK = Math.max(medianGap * 1.4, lineH * 1.5, 18);

    let curType: RawBlock['type'] | null = null;
    let cur: ClassifiedLine[] = [];
    const flush = () => {
      if (cur.length && curType) push(curType, cur);
      curType = null;
      cur = [];
    };

    for (let i = 0; i < arr.length; i++) {
      const l = arr[i];
      const role = classifyLineRole(l, colBounds[c]);
      const prev = arr[i - 1];
      const bigGap = prev ? l.y - (prev.y + prev.h) > BREAK : false;
      if (cur.length && (bigGap || role !== curType)) flush();
      if (!cur.length) curType = role;
      cur.push(l);
    }
    flush();
  }

  const rank = (c: ColumnKind) => (c === 'full' ? 0 : c === 'left' ? 1 : 2);
  blocks.sort((a, b) => rank(a.col) - rank(b.col) || a.rect.y - b.rect.y);
  blocks.forEach((b, i) => (b.order = i));
  return blocks;
}
