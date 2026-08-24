import { describe, it, expect } from 'vitest';
import { buildDoc, type ParsedPage } from '../../src/core/parser/docBuilder';

/** 与 P7 探针一致的合成双页夹具 */
function fixture(): ParsedPage[] {
  return [
    {
      no: 1,
      w: 612,
      h: 792,
      layoutMode: 'mixed',
      blocks: [
        { id: 't1', type: 'title', col: 'full', rect: { x: 70, y: 80, w: 430, h: 16 }, text: '面向零知识虚拟机轨迹生成的高性能异构加速器' },
        { id: 'a1', type: 'authors', col: 'full', rect: { x: 170, y: 105, w: 260, h: 12 }, text: '作者一，作者二，作者三 东南大学集成电路学院' },
        { id: 'ab1', type: 'abstract', col: 'full', rect: { x: 50, y: 130, w: 500, h: 12 }, text: '摘要——零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）在区块链' },
        { id: 's1', type: 'section', col: 'left', rect: { x: 50, y: 180, w: 240, h: 14 }, text: '1 引言' },
        { id: 'p2', type: 'paragraph', col: 'left', rect: { x: 50, y: 206, w: 240, h: 61 }, text: '实验结果表明，所提架构相比通用 CPU 基线取得 18.3 倍的加速。' },
        { id: 'f1', type: 'figure', col: 'left', rect: { x: 60, y: 290, w: 220, h: 80 }, text: '' },
        { id: 'p1', type: 'paragraph', col: 'left', rect: { x: 50, y: 390, w: 240, h: 48 }, text: '执行轨迹（Trace）的生成速度直接决定了整个证明流水线的端到端延迟。本文提出' },
        { id: 'p3', type: 'paragraph', col: 'right', rect: { x: 330, y: 180, w: 240, h: 72 }, text: '该模块通过双缓冲机制隐藏了数据搬运的延迟。' },
      ],
    },
    {
      no: 2,
      w: 612,
      h: 792,
      layoutMode: 'double',
      blocks: [
        { id: 'p1b', type: 'paragraph', col: 'left', rect: { x: 50, y: 70, w: 240, h: 48 }, text: '一种面向 zkVM 轨迹生成的高性能异构加速器架构。该方案的面积开销控制在 1.4 倍以内。' },
        { id: 's2', type: 'section', col: 'left', rect: { x: 50, y: 150, w: 240, h: 14 }, text: '2 背景与相关工作' },
        { id: 'p4', type: 'paragraph', col: 'left', rect: { x: 50, y: 176, w: 240, h: 54 }, text: '相关工作分为基于 GPU 的多标量乘法加速与基于 ASIC 的 NTT 加速。' },
        { id: 'e1', type: 'equation', col: 'right', rect: { x: 350, y: 70, w: 200, h: 30 }, text: 'e = gcd(f, (x^N - 1) mod f)' },
        { id: 'p5', type: 'paragraph', col: 'right', rect: { x: 330, y: 120, w: 240, h: 60 }, text: '安全性分析表明，该优化不改变原有协议的可满足性（Soundness）。' },
      ],
    },
  ];
}

describe('parser: docBuilder', () => {
  it('跨页同栏段落续接合并为 1 个块(2 fragments),且不误并右栏段', () => {
    const doc = buildDoc(fixture(), 'en');
    expect(doc.blocks.map((b) => b.type)).toEqual([
      'title',
      'authors',
      'abstract',
      'section',
      'paragraph',
      'figure',
      'paragraph',
      'paragraph',
      'section',
      'paragraph',
      'equation',
      'paragraph',
    ]);
    const twoFrag = doc.blocks.filter((b) => (b.fragments?.length ?? 0) === 2);
    expect(twoFrag).toHaveLength(1);
    expect(twoFrag[0].text).toContain('本文提出');
    expect(twoFrag[0].text).toContain('一种面向');
    expect(twoFrag[0].pageIndex).toBe(1);
    // 右栏段 p3 未被误并
    expect(doc.blocks[7].text!).toContain('双缓冲');
  });

  it('连续三页的同栏段落合并为一个三片段块', () => {
    const pages: ParsedPage[] = [1, 2, 3].map((no) => ({
      no,
      w: 612,
      h: 792,
      layoutMode: 'double',
      blocks: [
        {
          id: `left-${no}`,
          type: 'paragraph',
          col: 'left',
          rect: { x: 50, y: 70, w: 240, h: 48 },
          text: no === 1 ? '跨页段落第一部分' : no === 2 ? '跨页段落第二部分' : '跨页段落第三部分。',
        },
        {
          id: `right-${no}`,
          type: 'paragraph',
          col: 'right',
          rect: { x: 330, y: 70, w: 240, h: 48 },
          text: `右栏独立段落 ${no}。`,
        },
      ],
    }));

    const doc = buildDoc(pages, 'en');
    const continued = doc.blocks.find((b) => b.text?.includes('跨页段落第一部分'))!;
    expect(continued.fragments).toHaveLength(3);
    expect(continued.text).toContain('跨页段落第二部分');
    expect(continued.text).toContain('跨页段落第三部分');
    expect(doc.blocks.filter((b) => b.text?.includes('右栏独立段落'))).toHaveLength(3);
  });

  it('prev/next 链连续,新 id 生效', () => {
    const doc = buildDoc(fixture(), 'en');
    doc.blocks.forEach((b, i) => {
      if (i > 0) expect(b.prevBlockId).toBe(doc.blocks[i - 1].id);
      if (i < doc.blocks.length - 1) expect(b.nextBlockId).toBe(doc.blocks[i + 1].id);
    });
    expect(new Set(doc.blocks.map((b) => b.id)).size).toBe(doc.blocks.length);
  });

  it('章节归属与 widthMode/splitAllowed 规则', () => {
    const doc = buildDoc(fixture(), 'en');
    const s1 = doc.blocks.find((b) => b.type === 'section' && b.text?.startsWith('1'))!;
    const s2 = doc.blocks.find((b) => b.type === 'section' && b.text?.startsWith('2'))!;
    expect(doc.blocks.find((b) => b.text?.includes('本文提出'))?.parentSectionId).toBe(s1.id);
    expect(doc.blocks.find((b) => b.text?.includes('安全性分析'))?.parentSectionId).toBe(s2.id);
    expect(doc.blocks.find((b) => b.type === 'title')?.widthMode).toBe('span');
    expect(doc.blocks.find((b) => b.type === 'paragraph')?.widthMode).toBe('column');
    expect(doc.blocks.find((b) => b.type === 'figure')?.splitAllowed).toBe(false);
    expect(doc.blocks.find((b) => b.type === 'equation')?.splitAllowed).toBe(false);
    expect(doc.blocks.find((b) => b.type === 'paragraph')?.splitAllowed).toBe(true);
  });

  it('整体版式 mixed;逐页信息保留', () => {
    const doc = buildDoc(fixture(), 'en');
    expect(doc.layoutMode).toBe('mixed');
    expect(doc.pageCount).toBe(2);
    expect(doc.pages[0].pageIndex).toBe(0);
    expect(doc.pages[1].pageIndex).toBe(1);
    expect(doc.layoutRegions.map((region) => region.mode)).toEqual(['full-width', 'double']);
    expect(doc.semanticUnits.map((unit) => unit.id)).toEqual(doc.blocks.map((block) => block.id));
    expect(doc.semanticUnits.find((unit) => unit.kind === 'figure')?.assetId).toBeDefined();
  });
});
