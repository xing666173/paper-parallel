import { describe, it, expect } from 'vitest';
import { itemsToLines, type SimpleTextItem } from '../../src/core/parser/lines';
import { classifyLines } from '../../src/core/parser/columns';
import { groupLinesToBlocks } from '../../src/core/parser/blocks';
import {
  mergeBitmapRegions,
  detectTableRegions,
  unifyBlocks,
  type LineSegment,
} from '../../src/core/parser/regions';
import { itemsToCharRects, rectsForRange } from '../../src/core/parser/charRects';

/** 与 P6 探针一致的合成夹具 */
function fixture(): {
  pageW: number;
  pageH: number;
  items: SimpleTextItem[];
  bitmaps: { x: number; y: number; w: number; h: number }[];
  hSegs: LineSegment[];
  vSegs: LineSegment[];
} {
  const pageW = 612;
  const pageH = 792;
  const items: SimpleTextItem[] = [];
  const add = (str: string, x: number, y: number, w: number, h: number) => items.push({ str, x, y, w, h });

  add('面向零知识虚拟机轨迹生成的高性能异构加速器', 70, 80, 430, 16);
  add('作者一，作者二，作者三 东南大学集成电路学院', 170, 105, 260, 12);
  add('摘要——零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）在区块链', 50, 130, 500, 12);
  const L = 50;
  const R = 330;
  const lw = 240;
  add('1 引言', L, 180, lw, 13.5);
  add('执行轨迹（Trace）的生成速度直接决定了整个证明流水线的端到端延迟。', L, 206, lw, 13);
  add('本文提出一种面向 zkVM 轨迹生成的高性能异构加速器架构。', L, 230, lw, 13);
  add('实验结果表明，所提架构相比通用 CPU 基线取得 18.3 倍的加速。', L, 254, lw, 13);
  add('图 1：zkVM 执行阶段与证明阶段的工作流示意图', L, 388, lw, 11);
  add('证明者（Prover）与验证者（Verifier）之间的交互轮数保持恒定。', L, 414, lw, 13);
  add('该模块通过双缓冲机制隐藏了数据搬运的延迟。', R, 180, lw, 13);
  add('我们在表 1 中汇总了各配置下的关键路径延迟分解结果。', R, 204, lw, 13);
  add('安全性分析表明，该优化不改变原有协议的可满足性（Soundness）。', R, 228, lw, 13);
  add('与已有工作不同，我们的方法不需要改变应用层的密码学假设。', R, 252, lw, 13);
  add('表 1：各配置关键路径延迟分解（ns）', R, 312, lw, 11);
  add('该方案的面积开销控制在 1.4 倍以内，同时保持 78% 的算术单元利用率。', R, 398, lw, 13);
  add('相关工作分为基于 GPU 的多标量乘法加速与基于 ASIC 的 NTT 加速。', R, 422, lw, 13);
  add('e = gcd(f, (x^N - 1) mod f)   (1)', R, 486, lw, 13);

  const bitmaps = [
    { x: 60, y: 270, w: 220, h: 80 },
    { x: 250, y: 300, w: 50, h: 40 },
  ];
  const hSegs: LineSegment[] = [340, 360, 380].map((y) => ({ x1: 340, x2: 560, y1: y, y2: y }));
  const vSegs: LineSegment[] = [340, 440, 560].map((x) => ({ x1: x, x2: x, y1: 280, y2: 380 }));
  return { pageW, pageH, items, bitmaps, hSegs, vSegs };
}

describe('parser: regions', () => {
  it('重叠位图合并为一张图', () => {
    const fx = fixture();
    const figs = mergeBitmapRegions(fx.bitmaps);
    expect(figs).toHaveLength(1);
    expect(figs[0]).toEqual({ x: 60, y: 270, w: 240, h: 80 });
  });

  it('横竖线网格检测为表格区域(bbox 以横线网格为界)', () => {
    const fx = fixture();
    const tabs = detectTableRegions(fx.hSegs, fx.vSegs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toEqual({ x: 340, y: 340, w: 220, h: 40 });
  });

  it('题注关联(图题在下方/表题在上方)+ 统一块序列保序', () => {
    const fx = fixture();
    const lines = classifyLines(itemsToLines(fx.items), fx.pageW);
    const textBlocks = groupLinesToBlocks(lines, fx.pageW, fx.pageH);
    const figs = mergeBitmapRegions(fx.bitmaps);
    const tabs = detectTableRegions(fx.hSegs, fx.vSegs);
    const all = unifyBlocks(textBlocks, figs, tabs, fx.pageW);

    expect(all.map((b) => b.type)).toEqual([
      'title',
      'authors',
      'abstract',
      'section',
      'paragraph',
      'figure',
      'paragraph',
      'paragraph',
      'table',
      'paragraph',
      'equation',
    ]);
    const fig = all.find((b) => b.type === 'figure')!;
    const tab = all.find((b) => b.type === 'table')!;
    expect(fig.caption).toContain('图 1');
    expect(fig.captionSide).toBe('below');
    expect(tab.caption).toContain('表 1');
    expect(tab.captionSide).toBe('above');
    // 图块紧跟其前一个正文段落之后(相对顺序不漂移)
    expect(all[5].type).toBe('figure');
    expect(all[4].type).toBe('paragraph');
  });

  it('未匹配到题注的 caption 块保留,不丢失', () => {
    const fx = fixture();
    const lines = classifyLines(itemsToLines(fx.items), fx.pageW);
    const textBlocks = groupLinesToBlocks(lines, fx.pageW, fx.pageH);
    const orphanRegion = { x: 40, y: 600, w: 200, h: 100 };
    const all = unifyBlocks(textBlocks, [orphanRegion], [], fx.pageW);
    expect(all.some((b) => b.type === 'caption')).toBe(true);
    expect(all.some((b) => b.type === 'figure' && !b.caption)).toBe(true);
  });
});

describe('parser: charRects', () => {
  it('字符等分宽度 + 同行片段合并为一个矩形', () => {
    const fx = fixture();
    const target = fx.items.filter((it) => it.str.includes('执行轨迹'));
    const chars = itemsToCharRects(target);
    expect(chars.length).toBe(target.reduce((n, it) => n + it.str.length, 0));
    const rects = rectsForRange(chars, [0, 10]);
    expect(rects.length).toBe(1);
    expect(rects[0].x).toBeCloseTo(chars[0].x);
  });
});
