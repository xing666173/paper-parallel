// ============================================================================
// charRects.ts —— 字符级坐标(词级联动高亮的数据基础)
// PDF.js 的 TextItem 只给整串宽度,第一版按字符等分 item 宽度。
// 后续可接 canvas measureText 做精确分配;等分对 CJK 与等宽数字已足够。
// ============================================================================
import type { Rect } from '../../types/models';
import type { SimpleTextItem } from './lines';

export interface CharRect {
  ch: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function itemsToCharRects(items: SimpleTextItem[]): CharRect[] {
  const out: CharRect[] = [];
  for (const it of items) {
    const n = it.str.length;
    if (!n) continue;
    const w = it.w / n;
    for (let i = 0; i < n; i++) {
      out.push({ ch: it.str[i], x: it.x + i * w, y: it.y, w, h: it.h });
    }
  }
  return out;
}

/** 由字符矩形反查某文本片段在视口中的覆盖矩形(跨行时返回多个) */
export function rectsForRange(chars: CharRect[], range: [number, number]): Rect[] {
  const [start, end] = range;
  const out: Rect[] = [];
  let cur: Rect | null = null;
  for (let i = start; i < end && i < chars.length; i++) {
    const c = chars[i];
    if (!cur) {
      cur = { x: c.x, y: c.y, w: c.w, h: c.h };
    } else if (Math.abs(c.y - cur.y) <= 2 && c.x <= cur.x + cur.w + 4) {
      const x2 = Math.max(cur.x + cur.w, c.x + c.w);
      cur.w = x2 - cur.x;
    } else {
      out.push(cur);
      cur = { x: c.x, y: c.y, w: c.w, h: c.h };
    }
  }
  if (cur) out.push(cur);
  return out;
}
