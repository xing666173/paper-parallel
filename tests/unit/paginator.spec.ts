import { describe, it, expect } from 'vitest';
import { chunkText, paginate, validateOrder } from '../../src/core/paginate';

/** 与浏览器探针相同的确定性假测量:等宽近似 */
function fakeMeasure(text: string, w: number, fs: number): number {
  const lineH = fs * 1.6;
  const cpl = Math.max(1, Math.floor(w / (fs * 1.05)));
  const lines = Math.ceil([...text].length / cpl);
  return Math.max(lineH, lines * lineH);
}

const S = [
  '零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）在区块链扩容与隐私计算中扮演关键角色。',
  '执行轨迹（Trace）的生成速度直接决定了整个证明流水线的端到端延迟。',
  '本文提出一种面向 zkVM 轨迹生成的高性能异构加速器架构。',
  '实验结果表明，所提架构相比通用 CPU 基线取得 18.3 倍的端到端加速。',
];
function makeBlocks() {
  const B: any[] = [];
  let n = 0;
  const add = (o: any) => B.push({ id: 'b' + ++n, ...o });
  const para = (k: number) => Array.from({ length: k }, (_, i) => S[i % S.length]).join('');
  add({ type: 'title', text: '面向零知识虚拟机轨迹生成的高性能异构加速器', widthMode: 'span', frontMatter: true, fontSize: 17 });
  add({ type: 'authors', text: '作者一，作者二，作者三  东南大学集成电路学院', widthMode: 'span', frontMatter: true, fontSize: 11 });
  add({ type: 'abstract', text: '摘要——' + para(3), widthMode: 'span', frontMatter: true, fontSize: 12 });
  add({ type: 'keywords', text: '关键词：zkVM；Trace；Accelerator', widthMode: 'span', frontMatter: true, fontSize: 11 });
  add({ type: 'section', text: '1 引言', fontSize: 14 });
  add({ type: 'paragraph', text: para(6), fontSize: 13 });
  add({ type: 'figure', widthMode: 'column', atomicH: 220, caption: '图 1' });
  add({ type: 'paragraph', text: para(5), fontSize: 13 });
  add({ type: 'section', text: '2 背景', fontSize: 14 });
  add({ type: 'paragraph', text: para(7), fontSize: 13 });
  add({ type: 'equation', widthMode: 'column', atomicH: 80, label: 'e=gcd(f)' });
  add({ type: 'paragraph', text: para(4), fontSize: 13 });
  add({ type: 'table', widthMode: 'span', atomicH: 280, caption: '表 1' });
  add({ type: 'paragraph', text: para(6), fontSize: 13 });
  add({ type: 'section', text: '3 结论', fontSize: 14 });
  add({ type: 'paragraph', text: para(3), fontSize: 13 });
  add({ type: 'table', widthMode: 'span', atomicH: 1180, caption: '超大表' });
  return B;
}

describe('paginator.core(与浏览器探针同一份源码)', () => {
  it('三种版式:块序校验全部通过,页数自然延伸', () => {
    const blocks = makeBlocks();
    for (const mode of ['double', 'single', 'mixed'] as const) {
      const r = paginate(blocks, { mode, measureText: fakeMeasure });
      const v = validateOrder(blocks, r.log);
      expect(v.ok).toBe(true);
      expect(r.pages.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('超高原子块降级:缩放并记录 issue,不阻塞', () => {
    const blocks = makeBlocks();
    for (const mode of ['double', 'single', 'mixed'] as const) {
      const r = paginate(blocks, { mode, measureText: fakeMeasure });
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0].block).toBe('b17');
      const placement = r.log.find((entry) => entry.id === 'b17');
      expect(placement).toMatchObject({ h: r.geom.usableH, frags: '整' });
    }
  });

  it('双栏首页 frontMatter 进通栏区,标题不被压进左栏', () => {
    const blocks = makeBlocks();
    const r = paginate(blocks, { mode: 'double', measureText: fakeMeasure });
    const p0 = r.pages[0];
    expect(p0.full.blocks.map((b: any) => b.block.type)).toEqual(['title', 'authors', 'abstract', 'keywords']);
    expect(p0.left.blocks.length).toBeGreaterThan(0);
  });

  it('单栏模式所有栏位只出现 single/span', () => {
    const blocks = makeBlocks();
    const r = paginate(blocks, { mode: 'single', measureText: fakeMeasure });
    const cols = new Set(r.log.map((l: any) => l.col));
    expect([...cols].sort()).toEqual(['single', 'span']);
  });

  it('原子块永不劈开:log 中 frags 恒为整', () => {
    const blocks = makeBlocks();
    const r = paginate(blocks, { mode: 'double', measureText: fakeMeasure });
    for (const l of r.log) {
      if (['figure', 'table', 'equation'].includes(l.type)) expect(l.frags).toBe('整');
    }
  });

  it('chunkText 每片高度不超过 maxH', () => {
    const text = '执行轨迹的生成速度直接决定了整个证明流水线的端到端延迟。本文提出一种新的架构。'.repeat(8);
    const chunks = chunkText(text, 300, 60, 13, fakeMeasure);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.h).toBeLessThanOrEqual(60 + 1e-9);
    expect(chunks.map((c: any) => c.text).join('')).toBe(text);
  });
});
