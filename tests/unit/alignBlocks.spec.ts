import { describe, it, expect } from 'vitest';
import {
  normalizeAnchorLabel,
  extractAnchors,
  matchAnchors,
  applyManualAnchorOverrides,
  alignBlocksWithAnchors,
  type AlignBlock,
} from '../../src/core/align/index';

const KW: [string, string][] = [
  ['trace generation', '轨迹生成'],
  ['execution trace', '执行轨迹'],
  ['accelerator', '加速器'],
  ['latency', '延迟'],
  ['propose', '提出'],
  ['gpu', 'gpu'],
  ['multi-scalar', '多标量'],
  ['multiplication', '乘法'],
  ['high-performance', '高性能'],
];

function kwScore(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  let hit = 0;
  for (const [en, zh] of KW) if (al.includes(en) && bl.includes(zh)) hit++;
  const na: string[] = al.match(/\d+(\.\d+)?/g) || [];
  const nb: string[] = bl.match(/\d+(\.\d+)?/g) || [];
  if (na.length && na.some((x) => nb.includes(x))) hit += 2;
  return Math.min(1, hit / 3);
}

const enBlocks: AlignBlock[] = [
  { id: 'e-title', type: 'title', text: 'A High-Performance Accelerator for ZKVM Trace Generation', order: 0 },
  { id: 'e-s1', type: 'section', text: '1 Introduction', order: 1 },
  { id: 'e-intro', type: 'paragraph', text: 'We propose a hardware accelerator for trace generation.', order: 2 },
  { id: 'e-fig', type: 'figure', text: 'Figure 1: Workflow of execution and proving', order: 3 },
  { id: 'e-after', type: 'paragraph', text: 'It reduces latency by 18.3x.', order: 4 },
  { id: 'e-s2', type: 'section', text: '2 Background', order: 5 },
  { id: 'e-bg', type: 'paragraph', text: 'Prior work uses GPUs for multi-scalar multiplication.', order: 6 },
  { id: 'e-extra', type: 'paragraph', text: 'This paragraph is missing in the Chinese version.', order: 7 },
];

const zhBlocks: AlignBlock[] = [
  { id: 'z-title', type: 'title', text: '面向零知识虚拟机轨迹生成的高性能异构加速器', order: 0 },
  { id: 'z-s1', type: 'section', text: '1 引言', order: 1 },
  { id: 'z-intro', type: 'paragraph', text: '我们为执行轨迹生成提出一种硬件加速器。', order: 2 },
  { id: 'z-fig', type: 'figure', text: '图 1:工作流示意图', order: 3 },
  { id: 'z-after', type: 'paragraph', text: '它将延迟降低 18.3 倍。', order: 4 },
  { id: 'z-s2', type: 'section', text: '2 背景', order: 5 },
  { id: 'z-bg', type: 'paragraph', text: '已有工作使用 GPU 进行多标量乘法。', order: 6 },
];

describe('align: 锚点', () => {
  it('跨语言标签归一化', () => {
    expect(normalizeAnchorLabel('figure', 'Figure 1')).toBe('fig1');
    expect(normalizeAnchorLabel('figure', '图 1')).toBe('fig1');
    expect(normalizeAnchorLabel('section', '1.2 Motivation')).toBe('sec1.2');
    expect(normalizeAnchorLabel('paragraph', 'normal text')).toBeNull();
  });

  it('图块锚点读取 caption 兜底(text 缺失时)', () => {
    const a = extractAnchors([{ id: 'f1', type: 'figure', text: '', order: 0, caption: '图 1：工作流' } as any]);
    expect(a).toHaveLength(1);
    expect(a[0].label).toBe('fig1');
  });

  it('锚点抽取与自动配对', () => {
    const en = extractAnchors(enBlocks);
    const zh = extractAnchors(zhBlocks);
    expect(en.map((a) => a.label)).toEqual(['sec1', 'fig1', 'sec2']);
    const m = matchAnchors(en, zh);
    expect(m.pairs).toHaveLength(3);
    expect(m.unmatchedEn).toHaveLength(0);
    expect(m.unmatchedZh).toHaveLength(0);
  });

  it('人工删除与重绑锚点', () => {
    const m = matchAnchors(extractAnchors(enBlocks), extractAnchors(zhBlocks));
    const removed = applyManualAnchorOverrides(m.pairs, [{ label: 'fig1', zhBlockId: null }]);
    expect(removed.pairs).toHaveLength(2);
    const rebound = applyManualAnchorOverrides(removed.pairs, [{ label: 'fig1', enBlockId: 'e-fig', zhBlockId: 'z-after' }]);
    expect(rebound.pairs).toHaveLength(3);
    expect(rebound.pairs.find((p) => p.label === 'fig1')).toMatchObject({ source: 'manual', zhBlockId: 'z-after' });
  });
});

describe('align: 场景B 锚点+块级对齐', () => {
  it('锚点锁大局,段内块级对齐,英文多余块 1:0', async () => {
    const r = await alignBlocksWithAnchors(enBlocks, zhBlocks, {
      scoreFn: async (a, b) => kwScore(a.text || '', b.text || ''),
    });
    expect(r.anchors).toHaveLength(3);
    expect(r.units.filter((u) => u.anchor)).toHaveLength(3);
    const coveredZh = new Set(r.units.flatMap((u) => u.zhBlockIds));
    expect(coveredZh.size).toBe(zhBlocks.length);
    expect(r.units.some((u) => u.enBlockIds.includes('e-extra') && u.zhBlockIds.length === 0)).toBe(true);
    expect(r.degraded).toBe(false);
  });
});
