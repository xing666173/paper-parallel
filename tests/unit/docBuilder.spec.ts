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
  function interleavedColumnBlock(): ParsedPage['blocks'][number] {
    const leftLines = [
      'Many protocols have been developed for modern proof systems.',
      'The prover computes a compact proof for the public verifier.',
      'This construction is widely used in practical applications.',
      'The arithmetic circuit is converted into polynomial constraints.',
      'Each witness value is processed by the protocol in sequence.',
      'The final result can be checked without revealing private data.',
    ];
    const rightLines = [
      'The hardware implementation incurs a high multiplication cost.',
      'In order to reduce it the scalar is divided into small windows.',
      'Each window can be evaluated with a lightweight point adder.',
      'The intermediate values are accumulated inside local buckets.',
      'This method reduces memory traffic and improves the throughput.',
      'The design is then mapped to an efficient accelerator pipeline.',
    ];
    const text = leftLines.map((line, index) => `${line} ${rightLines[index]}`).join('\n');
    const characterRects: NonNullable<ParsedPage['blocks'][number]['characterRects']> = [];
    let sourceOffset = 0;
    leftLines.forEach((leftLine, row) => {
      const rightLine = rightLines[row];
      [...leftLine].forEach((ch, index) => characterRects.push({
        ch,
        sourceIndex: sourceOffset + index,
        pageIndex: 0,
        rect: { x: 45 + index * 3.7, y: 100 + row * 12, w: 3.5, h: 9 },
      }));
      const rightOffset = sourceOffset + leftLine.length + 1;
      [...rightLine].forEach((ch, index) => characterRects.push({
        ch,
        sourceIndex: rightOffset + index,
        pageIndex: 0,
        rect: { x: 330 + index * 3.5, y: 100 + row * 12, w: 3.3, h: 9 },
      }));
      sourceOffset += leftLine.length + 1 + rightLine.length + (row < leftLines.length - 1 ? 1 : 0);
    });
    return {
      id: 'interleaved',
      type: 'paragraph',
      col: 'full',
      rect: { x: 45, y: 100, w: 500, h: 69 },
      text,
      characterRects,
    };
  }

  it('按字符坐标恢复被 PDF 文字层逐行交错的双栏正文', () => {
    const pages: ParsedPage[] = [{
      no: 1,
      w: 612,
      h: 792,
      layoutMode: 'double',
      blocks: [interleavedColumnBlock()],
    }];

    const doc = buildDoc(pages, 'en');

    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0].text).toContain('Many protocols have been developed');
    expect(doc.blocks[0].text).not.toContain('hardware implementation');
    expect(doc.blocks[1].text).toContain('hardware implementation');
    expect(doc.blocks[1].text).not.toContain('Many protocols');
    expect(doc.blocks.map((block) => block.widthMode)).toEqual(['column', 'column']);
    expect(doc.blocks[0].characterRects?.find((char) => char.ch === 'M')?.sourceIndex).toBe(0);
    expect(doc.blocks[1].characterRects?.find((char) => char.ch === 'T')?.sourceIndex).toBe(0);
  });

  it('恢复短交错正文并纠正页面中部的 authors 误分类', () => {
    const left = 'The design connects from one side of the FPGA.';
    const right = 'The total memory capacity is available for every core.';
    const text = `${left} ${right}`;
    const characterRects = [
      ...[...left].map((ch, sourceIndex) => ({
        ch, sourceIndex, pageIndex: 0,
        rect: { x: 45 + sourceIndex * 3.8, y: 400, w: 3.5, h: 9 },
      })),
      ...[...right].map((ch, index) => ({
        ch, sourceIndex: left.length + 1 + index, pageIndex: 0,
        rect: { x: 330 + index * 3.7, y: 400, w: 3.5, h: 9 },
      })),
    ];
    const doc = buildDoc([{
      no: 1, w: 612, h: 792, layoutMode: 'mixed', blocks: [{
        id: 'short-authors', type: 'authors', col: 'full',
        rect: { x: 45, y: 400, w: 500, h: 9 }, text, characterRects,
      }],
    }], 'en');

    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph']);
    expect(doc.blocks[0].text).toBe(left);
    expect(doc.blocks[1].text).toBe(right);
  });

  it('不把数值密集的跨栏表格拆成双栏正文', () => {
    const block = interleavedColumnBlock();
    block.text = `${block.text}\n${Array.from({ length: 60 }, (_, index) => `${index}.0`).join(' ')}`;
    const doc = buildDoc([{
      no: 1, w: 612, h: 792, layoutMode: 'mixed', blocks: [block],
    }], 'en');

    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].widthMode).toBe('span');
  });

  it('不拆分没有中央栏沟的通栏正文', () => {
    const block = interleavedColumnBlock();
    block.characterRects = block.characterRects?.map((character) => ({
      ...character,
      rect: character.rect.x >= 300
        ? { ...character.rect, x: character.rect.x - 75 }
        : character.rect,
    }));
    const doc = buildDoc([{
      no: 1, w: 612, h: 792, layoutMode: 'mixed', blocks: [block],
    }], 'en');

    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].widthMode).toBe('span');
  });

  it('不把尚未到栏底的左栏段落跳过右栏后接到下一页', () => {
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
      'paragraph',
      'section',
      'paragraph',
      'equation',
      'paragraph',
    ]);
    const twoFrag = doc.blocks.filter((b) => (b.fragments?.length ?? 0) === 2);
    expect(twoFrag).toHaveLength(0);
    expect(doc.blocks.find((block) => block.text?.includes('本文提出'))?.text)
      .not.toContain('一种面向');
    expect(doc.blocks[7].text!).toContain('双缓冲');
  });

  it('连续三页单栏正文按上一页末尾到下一页开头合并', () => {
    const pages: ParsedPage[] = [1, 2, 3].map((no) => ({
      no,
      w: 612,
      h: 792,
      layoutMode: 'single',
      blocks: [
        {
          id: `body-${no}`,
          type: 'paragraph',
          col: 'full',
          rect: { x: 50, y: no === 1 ? 700 : 70, w: 500, h: no === 2 ? 640 : 48 },
          text: no === 1 ? '跨页段落第一部分' : no === 2 ? '跨页段落第二部分' : '跨页段落第三部分。',
        },
      ],
    }));
    const doc = buildDoc(pages, 'en');
    const continued = doc.blocks.find((b) => b.text?.includes('跨页段落第一部分'))!;
    expect(continued.fragments).toHaveLength(3);
    expect(continued.text).toContain('跨页段落第二部分');
    expect(continued.text).toContain('跨页段落第三部分');
  });

  it('双栏跨页只连接上一页右栏末尾与下一页左栏开头', () => {
    const pages: ParsedPage[] = [
      {
        no: 1, w: 612, h: 792, layoutMode: 'double',
        blocks: [
          { id: 'left-1', type: 'paragraph', col: 'left', rect: { x: 50, y: 650, w: 240, h: 60 }, text: '左栏完整段落。' },
          { id: 'right-1', type: 'paragraph', col: 'right', rect: { x: 330, y: 650, w: 240, h: 60 }, text: '上一页右栏尚未结束的' },
        ],
      },
      {
        no: 2, w: 612, h: 792, layoutMode: 'double',
        blocks: [
          { id: 'left-2', type: 'paragraph', col: 'left', rect: { x: 50, y: 70, w: 240, h: 60 }, text: '正文在下一页左栏继续并结束。' },
          { id: 'right-2', type: 'paragraph', col: 'right', rect: { x: 330, y: 70, w: 240, h: 60 }, text: '下一页右栏独立段落。' },
        ],
      },
    ];

    const doc = buildDoc(pages, 'en');
    const continued = doc.blocks.find((block) => block.text?.includes('上一页右栏'))!;

    expect(continued.text).toContain('下一页左栏继续');
    expect(continued.fragments).toHaveLength(2);
    expect(continued.text).not.toContain('下一页右栏独立');
    expect(doc.blocks.find((block) => block.text?.includes('下一页右栏独立'))).toBeDefined();
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
    expect(doc.layoutRegions.map((region) => ({
      mode: region.mode,
      sourcePage: region.sourcePage,
    }))).toEqual([
      { mode: 'full-width', sourcePage: 1 },
      { mode: 'double', sourcePage: 1 },
      { mode: 'double', sourcePage: 2 },
    ]);
    expect(doc.layoutRegions.flatMap((region) => region.orderedUnitIds)).toEqual(
      doc.blocks.map((block) => block.id),
    );
    expect(doc.semanticUnits.map((unit) => unit.id)).toEqual(doc.blocks.map((block) => block.id));
    expect(doc.semanticUnits.find((unit) => unit.kind === 'figure')?.assetId).toBeDefined();
  });

  it('跨页合并时同步偏移字符索引并使用零基 PDF 页号', () => {
    const pages: ParsedPage[] = [1, 2].map((no) => ({
      no, w: 612, h: 792, layoutMode: 'single',
      blocks: [{
        id: `p-${no}`, type: 'paragraph', col: 'full',
        rect: { x: 10, y: no === 1 ? 700 : 20, w: 50, h: 40 },
        text: no === 1 ? 'First' : 'Second.',
        characterRects: [{
          ch: no === 1 ? 'F' : 'S', sourceIndex: 0, pageIndex: 0,
          rect: { x: 10, y: no === 1 ? 700 : 20, w: 5, h: 10 },
        }],
      }],
    }));

    const block = buildDoc(pages, 'en').blocks[0];
    expect(block.characterRects).toEqual([
      expect.objectContaining({ ch: 'F', sourceIndex: 0, pageIndex: 0 }),
      expect.objectContaining({ ch: 'S', sourceIndex: 6, pageIndex: 1 }),
    ]);
  });

  it('将图中数值标签和页面中部的作者误判降级为正文', () => {
    const doc = buildDoc([{
      no: 1, w: 612, h: 792, layoutMode: 'double', blocks: [
        {
          id: 'diagram-measurement', type: 'section', col: 'left',
          rect: { x: 70, y: 340, w: 150, h: 8 }, text: '15 x 1 x 768 = 1.4kB',
        },
        {
          id: 'mid-page-author', type: 'authors', col: 'right',
          rect: { x: 330, y: 430, w: 220, h: 12 },
          text: 'The implementation processes each input independently.',
        },
      ],
    }], 'en');

    expect(doc.blocks.find((block) => block.text === '15 x 1 x 768 = 1.4kB')?.type).toBe('paragraph');
    expect(doc.blocks.find((block) => block.text?.includes('processes each input'))?.type).toBe('paragraph');
    expect(doc.semanticUnits.filter((unit) => unit.kind === 'heading' || unit.kind === 'author')).toEqual([]);
  });
});
