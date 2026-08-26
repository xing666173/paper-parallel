import { describe, it, expect } from 'vitest';
import { itemsToLines, type SimpleTextItem } from '../../src/core/parser/lines';
import { classifyLines, detectLayoutMode } from '../../src/core/parser/columns';
import {
  groupLinesToBlocks,
  isDisplayFormulaCandidate,
  isFigureCaptionText,
  isTableCaptionText,
} from '../../src/core/parser/blocks';
import { parsePageItems } from '../../src/core/parser/index';
import { normalizeTextItem } from '../../src/core/parser/pdfjsAdapter';

/** 与 P5 探针完全一致的合成夹具:通栏标题区 + 双栏正文 */
function syntheticFixture(): { pageW: number; pageH: number; items: SimpleTextItem[] } {
  const pageW = 612;
  const pageH = 792;
  const items: SimpleTextItem[] = [];
  const add = (str: string, x: number, y: number, w: number, h: number) => items.push({ str, x, y, w, h });

  add('面向零知识虚拟机轨迹生成的高性能异构加速器', 70, 80, 430, 16);
  add('作者一，作者二，作者三 东南大学集成电路学院', 170, 105, 260, 12);
  add('摘要——零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）在区块链', 50, 130, 500, 12);

  const L = 50;
  const lw = 240;
  add('1 引言', L, 180, lw, 13.5);
  add('执行轨迹（Trace）的生成速度直接决定了整个证明流水线的端到端延迟。', L, 206, lw, 13);
  add('本文提出一种面向 zkVM 轨迹生成的高性能异构加速器架构。', L, 230, lw, 13);
  add('实验结果表明，所提架构相比通用 CPU 基线取得 18.3 倍的加速。', L, 254, lw, 13);
  add('该方案的面积开销控制在 1.4 倍以内，同时保持 78% 的算术单元利用率。', L, 306, lw, 13);
  add('相关工作分为基于 GPU 的多标量乘法加速与基于 ASIC 的 NTT 加速。', L, 330, lw, 13);
  add('图 1：zkVM 执行阶段与证明阶段的工作流示意图', L, 388, lw, 11);
  add('证明者（Prover）与验证者（Verifier）之间的交互轮数保持恒定。', L, 414, lw, 13);

  const R = 330;
  add('该模块通过双缓冲机制隐藏了数据搬运的延迟。', R, 180, lw, 13);
  add('我们在表 1 中汇总了各配置下的关键路径延迟分解结果。', R, 204, lw, 13);
  add('安全性分析表明，该优化不改变原有协议的可满足性（Soundness）。', R, 228, lw, 13);
  add('与已有工作不同，我们的方法不需要改变应用层的密码学假设。', R, 252, lw, 13);
  add('e = gcd(f, (x^N - 1) mod f)   (1)', R, 360, lw, 13);
  add('2 结论', R, 386, lw, 13.5);
  add('综上所述，所提架构在性能与面积之间取得了更好的权衡。', R, 412, lw, 13);

  return { pageW, pageH, items };
}

describe('parser: items -> lines', () => {
  it('合并同基线、拆分左右两栏同一 y 的行', () => {
    const fx = syntheticFixture();
    const lines = itemsToLines(fx.items);
    expect(lines).toHaveLength(18); // 3 通栏 + 8 左 + 7 右
    const y180 = lines.filter((l) => Math.abs(l.y - 180) <= 4);
    expect(y180).toHaveLength(2); // 左右两栏各一行
    expect(y180[0].x1).toBeLessThan(200);
    expect(y180[1].x1).toBeGreaterThan(300);
  });

  it('splits same-baseline columns when the real gutter is narrower than 24 points', () => {
    const lines = itemsToLines([
      { str: 'the permutation and accumulator columns', x: 53.798, y: 235.193, w: 240.245, h: 8.966 },
      { str: '3 Design and Philosophy', x: 317.955, y: 235.193, w: 111.4, h: 8.966 },
    ], 612);

    expect(lines.map((line) => line.text)).toEqual([
      'the permutation and accumulator columns',
      '3 Design and Philosophy',
    ]);
  });

  it('does not split ordinary same-line fragments near the page center', () => {
    const lines = itemsToLines([
      { str: 'a full-width sentence ending', x: 120, y: 90, w: 180, h: 10 },
      { str: 'near the center', x: 309, y: 90, w: 90, h: 10 },
    ], 612);

    expect(lines).toHaveLength(1);
  });
});

describe('parser: columns', () => {
  it('分类与阅读顺序:full -> left -> right,且居中的短作者行判为 full', () => {
    const fx = syntheticFixture();
    const lines = classifyLines(itemsToLines(fx.items), fx.pageW);
    expect(lines.filter((l) => l.col === 'full')).toHaveLength(3);
    expect(lines.filter((l) => l.col === 'left')).toHaveLength(8);
    expect(lines.filter((l) => l.col === 'right')).toHaveLength(7);
    const kinds = lines.map((l) => l.col);
    expect(kinds.join('|')).toMatch(/^full(\|full)*(\|left)*(\|right)*$/);
    expect(detectLayoutMode(lines)).toBe('mixed');
  });

  it('does not treat a short centered body continuation as full-width front matter', () => {
    const lines = classifyLines([{
      y: 306, x1: 318, x2: 364, h: 9,
      text: 'acceleration.', items: [],
    }], 612);

    expect(lines[0]?.col).toBe('right');
  });
});

describe('parser: lines -> blocks', () => {
  it('requires mathematical dominance before classifying a centered line as a display formula', () => {
    for (const prose of [
      'Zero-knowledge virtual machines (zkVMs) are a key technology for',
      'in Figure 1, consists of two main stages: (1) Front-end Execution',
      'RISC-V ISA [34, 35] with two custom instructions: trace_on and',
      'a high-performance multi-core CPU. When integrated with exist-',
    ]) {
      expect(isDisplayFormulaCandidate(prose, true), prose).toBe(false);
    }
    expect(isDisplayFormulaCandidate('e = gcd(f, (x^N - 1) mod f)   (1)', true)).toBe(true);
    expect(isDisplayFormulaCandidate('T_total = T_front + T_back   (3)', true)).toBe(true);
    expect(isDisplayFormulaCandidate('x = y + 1', false)).toBe(false);
  });

  it('块类型序列与 P5 合成夹具一致(段间隙断块、题注/公式/章节识别)', () => {
    const fx = syntheticFixture();
    const lines = classifyLines(itemsToLines(fx.items), fx.pageW);
    const blocks = groupLinesToBlocks(lines, fx.pageW, fx.pageH);
    expect(blocks.map((b) => b.type)).toEqual([
      'title',
      'authors',
      'abstract',
      'section',
      'paragraph',
      'paragraph',
      'caption',
      'paragraph',
      'paragraph',
      'equation',
      'section',
      'paragraph',
    ]);
    // 阅读顺序即 order 顺序,且 order 从 0 连续
    blocks.forEach((b, i) => expect(b.order).toBe(i));
    expect(blocks[6].type).toBe('caption');
    expect(blocks[9].type).toBe('equation');
  });

  it('parsePageItems 端到端输出', () => {
    const fx = syntheticFixture();
    const r = parsePageItems(fx.items, fx.pageW, fx.pageH);
    expect(r.layoutMode).toBe('mixed');
    expect(r.blocks).toHaveLength(12);
  });

  it('does not misclassify prose references to figures and tables as captions', () => {
    const line = (text: string, y: number) => ({
      y, x1: 50, x2: 290, h: 10, text, items: [], col: 'left' as const,
    });
    const blocks = groupLinesToBlocks([
      line('Table 3 shows the comparison of execution time.', 100),
      line('Figure 9, the sweet spot is 17 parallel units.', 125),
      line('Figure 11 show that our pipeline improves performance.', 150),
      line('Figure 3: Profiling before and after acceleration', 190),
      line('Table 2: ZK-Tracer PPA Results', 220),
    ], 612, 792);

    for (const prose of ['Table 3 shows', 'Figure 9,', 'Figure 11 show']) {
      expect(blocks.find((block) => block.text.includes(prose))?.type).toBe('paragraph');
    }
    expect(blocks.find((block) => block.text.includes('Figure 3:'))?.type).toBe('caption');
    expect(blocks.find((block) => block.text.includes('Table 2:'))?.type).toBe('caption');
  });

  it('recognizes both captions when PDF extraction merges adjacent figure and table captions', () => {
    const merged = 'Figure 9: Parallelism Analysis\nTable 2: ZK-Tracer PPA Results';
    expect(isFigureCaptionText(merged)).toBe(true);
    expect(isTableCaptionText(merged)).toBe(true);
  });

  it('在块文本中保留 PDF.js 文本项的字符索引和真实坐标', () => {
    const result = parsePageItems([
      { str: 'AB', x: 10, y: 20, w: 12, h: 10 },
      { str: 'CD', x: 24, y: 20, w: 12, h: 10 },
    ], 200, 300);
    expect(result.blocks[0].text).toBe('AB CD');
    expect(result.blocks[0].characterRects?.map((char) => char.sourceIndex)).toEqual([0, 1, 3, 4]);
    expect(result.blocks[0].characterRects?.[2].rect).toEqual({ x: 24, y: 20, w: 6, h: 10 });
  });

  it('keeps short centered front matter and wrapped full-width continuations out of paper columns', () => {
    const lines = classifyLines([
      { y: 60, x1: 240, x2: 372, h: 11, text: 'Alice Example, Bob Example', items: [] },
      { y: 100, x1: 48, x2: 560, h: 10, text: 'Abstract: a full-width line that reaches across the page', items: [] },
      { y: 113, x1: 48, x2: 250, h: 10, text: 'and its short continuation.', items: [] },
      { y: 140, x1: 48, x2: 280, h: 10, text: 'Keywords: layout, translation', items: [] },
    ], 612);

    expect(lines.map((line) => line.col)).toEqual(['full', 'full', 'full', 'full']);
  });
});

describe('parser: pdfjsAdapter', () => {
  it('仿射变换正确(单位视口矩阵)', () => {
    const item = { str: 'x', width: 5, height: 12, transform: [1, 0, 0, 1, 10, 20] };
    const viewport = { transform: [1, 0, 0, 1, 0, 0] };
    const r = normalizeTextItem(item, viewport);
    expect(r).toEqual({ str: 'x', x: 10, y: 8, w: 5, h: 12 });
  });

  it('带纵向翻转的视口矩阵(典型 PDF.js scale=1 视口)', () => {
    // PDF 坐标原点在左下,视口矩阵 [1,0,0,-1,0,pageH] 完成 y 翻转
    const viewport = { transform: [1, 0, 0, -1, 0, 792] };
    const item = { str: 'x', width: 5, height: 12, transform: [1, 0, 0, 1, 100, 700] };
    const r = normalizeTextItem(item, viewport);
    expect(r.x).toBeCloseTo(100);
    expect(r.y).toBeCloseTo(80);
    expect(r.w).toBeCloseTo(5);
    expect(r.h).toBeCloseTo(12);
  });

  it('does not multiply the PDF.js text width by the font transform', () => {
    const viewport = { transform: [1, 0, 0, -1, 0, 792] };
    const item = { str: 'paper title', width: 180, height: 15, transform: [15, 0, 0, 15, 100, 700] };

    const result = normalizeTextItem(item, viewport);

    expect(result.w).toBeCloseTo(180);
    expect(result.h).toBeCloseTo(15);
  });
});
