// ============================================================================
// columns.ts —— 分栏分类与阅读顺序
// 算法基准:P4/P5 探针(已 debug)。纯函数、零依赖。
// ============================================================================
import type { ParsedLine } from './lines';

export type ColumnKind = 'full' | 'left' | 'right';

export interface ClassifiedLine extends ParsedLine {
  col: ColumnKind;
}

/**
 * 每行分类:
 * - full :span > 0.5W,或 span > 0.38W 且行中点靠近页面中心(如居中的作者行)
 * - right:行中点 > 0.5W
 * - left :其余
 */
export function classifyLines(lines: ParsedLine[], pageW: number): ClassifiedLine[] {
  const out: ClassifiedLine[] = lines.map((l) => {
    const span = l.x2 - l.x1;
    const mid = (l.x1 + l.x2) / 2;
    const nearCenter = Math.abs(mid - pageW / 2) <= pageW * 0.08;
    let col: ColumnKind = 'left';
    if (span > pageW * 0.5 || (span > pageW * 0.38 && nearCenter)) col = 'full';
    else if (mid > pageW * 0.5) col = 'right';
    return { ...l, col };
  });
  // 阅读顺序:通栏(上→下) -> 左栏(上→下) -> 右栏(上→下)
  const rank = (c: ColumnKind) => (c === 'full' ? 0 : c === 'left' ? 1 : 2);
  out.sort((a, b) => rank(a.col) - rank(b.col) || a.y - b.y);
  return out;
}

/** 页面分栏模式判定(供版式继承 R4 使用) */
export function detectLayoutMode(lines: ClassifiedLine[]): 'single' | 'double' | 'mixed' {
  const cols = new Set(lines.map((l) => l.col));
  if (cols.has('full')) return 'mixed';
  return cols.has('left') && cols.has('right') ? 'double' : 'single';
}
