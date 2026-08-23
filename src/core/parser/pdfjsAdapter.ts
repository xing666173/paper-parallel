// ============================================================================
// pdfjsAdapter.ts —— 把 pdf.js 的 TextItem 换算成解析器需要的视口坐标
// 与 pdfjs 解耦:解析器只认 SimpleTextItem;换算矩阵算法来自 P4 探针。
// ============================================================================
import type { SimpleTextItem } from './lines';

export interface PdfTextItemLike {
  str: string;
  width: number;
  height?: number;
  transform: number[];
}

export interface PdfViewportLike {
  transform: number[];
  clone?: (opts: { scale: number }) => PdfViewportLike;
}

/** 矩阵乘(2D 仿射,仿 pdf.js Util.transform) */
export function transformPoint(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** 归一化:TextItem -> 视口坐标 SimpleTextItem(scale=1) */
export function normalizeTextItem(item: PdfTextItemLike, viewport: PdfViewportLike): SimpleTextItem {
  const vp = viewport.clone ? viewport.clone({ scale: 1 }) : viewport;
  const m = transformPoint(vp.transform, item.transform);
  const x = m[4];
  const y = m[5];
  const h = Math.max(Math.hypot(m[2], m[3]), item.height || 0);
  const w = item.width * Math.hypot(m[0], m[1]) || 0;
  return { str: item.str, x, y, w, h };
}
