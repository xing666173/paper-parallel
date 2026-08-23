// ============================================================================
// lines.ts —— 文字层第一道工序:字符 items -> 行
// 算法基准:P5 探针(已通过合成夹具断言)。纯函数、零依赖,便于 Vitest 测试。
// ============================================================================

/** 归一化后的简单文本项(视口坐标,scale=1)。pdfjs 坐标换算见 pdfjsAdapter。 */
export interface SimpleTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一行:同一 y 基线、且 x 连续的字符合并结果 */
export interface ParsedLine {
  y: number;
  x1: number;
  x2: number;
  h: number;
  text: string;
  items: SimpleTextItem[];
}

const Y_TOLERANCE = 4;   // 同一行 y 容差(px)
const X_GAP = 24;        // 同一基线内 x 间隙阈值:超过即视为另一栏的另一行

/**
 * items -> lines。
 * 1) y 容差内聚组;2) 组内按 x 排序,间隙 > X_GAP 拆行(防止左右两栏同行合并)。
 */
export function itemsToLines(items: SimpleTextItem[]): ParsedLine[] {
  const groups: { y: number; items: SimpleTextItem[] }[] = [];

  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    let g = groups.find((g) => Math.abs(g.y - it.y) <= Y_TOLERANCE);
    if (!g) {
      g = { y: it.y, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }

  const lines: ParsedLine[] = [];
  for (const g of groups) {
    g.items.sort((a, b) => a.x - b.x);
    let seg: SimpleTextItem[] = [];
    const flush = () => {
      if (!seg.length) return;
      lines.push({
        y: g.y,
        items: seg,
        x1: seg[0].x,
        x2: Math.max(...seg.map((i) => i.x + i.w)),
        h: Math.max(...seg.map((i) => i.h)),
        text: seg.map((i) => i.str).join(' '),
      });
    };
    for (const it of g.items) {
      if (seg.length) {
        const prev = seg[seg.length - 1];
        if (it.x - (prev.x + prev.w) > X_GAP) {
          flush();
          seg = [];
        }
      }
      seg.push(it);
    }
    flush();
  }
  lines.sort((a, b) => a.y - b.y);
  return lines;
}
