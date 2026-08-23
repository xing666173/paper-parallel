import { describe, it, expect } from 'vitest';
import {
  splitSentences,
  alignSentenceSequences,
  alignBlockPair,
  validateSpans,
} from '../../src/core/align/index';

const KW: [string, string][] = [
  ['trace generation', '执行轨迹生成'],
  ['execution trace', '执行轨迹'],
  ['accelerator', '加速器'],
  ['latency', '延迟'],
  ['propose', '提出'],
  ['speedup', '加速'],
  ['architecture', '架构'],
  ['memory', '内存'],
];

function kwScore(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  let hit = 0;
  for (const [en, zh] of KW) if (al.includes(en) && bl.includes(zh)) hit++;
  return Math.min(1, hit / 2.67);
}

describe('align: 分句', () => {
  it('中英文句末标点分句,小数点与缩写点不误切', () => {
    expect(splitSentences('The trace generation dominates latency. We propose an accelerator.')).toHaveLength(2);
    expect(splitSentences('执行轨迹的生成主导了延迟。我们提出一种加速器。')).toHaveLength(2);
    expect(splitSentences('It achieves 18.3x speedup. Fig. 1 shows this.')).toHaveLength(2);
  });
});

describe('align: 句级 DP', () => {
  it('1:1 全部匹配', async () => {
    const en = ['The trace generation dominates latency.', 'We propose an accelerator.'];
    const zh = ['执行轨迹的生成主导了延迟。', '我们提出一种加速器。'];
    const r = await alignSentenceSequences(en, zh, (i, j) => kwScore(en[i], zh[j]));
    expect(r.matchedEn).toBe(2);
    expect(r.matchedZh).toBe(2);
    expect(r.units.filter((u) => u.enIndices.length && u.zhIndices.length)).toHaveLength(2);
  });

  it('2:1 合句对齐', async () => {
    const en = ['The trace generation dominates latency.', 'We propose an accelerator.'];
    const zh = ['执行轨迹的生成主导了延迟,我们提出一种加速器。'];
    const r = await alignSentenceSequences(en, zh, (i, j) => kwScore(en[i], zh[j]));
    expect(r.units.some((u) => u.enIndices.length === 2 && u.zhIndices.length === 1)).toBe(true);
  });

  it('漏译产生 1:0,而不是强行合并', async () => {
    const en = ['The trace generation dominates latency.', 'We propose an accelerator.'];
    const zh = ['执行轨迹的生成主导了延迟。'];
    const r = await alignSentenceSequences(en, zh, (i, j) => kwScore(en[i], zh[j]));
    expect(r.units.some((u) => u.enIndices.length === 1 && u.zhIndices.length === 0)).toBe(true);
  });
});

describe('align: 块对与 span', () => {
  it('低置信度降级为 paragraph', async () => {
    const r = await alignBlockPair(
      { id: 'en', text: 'Quantum field theory describes fundamental interactions.' },
      { id: 'zh', text: '本文研究完全无关的另一主题。' },
      { scoreFn: async () => 0, minConfidence: 0.35 },
    );
    expect(r.level).toBe('paragraph');
    expect(r.units[0].fallback).toBe(true);
  });

  it('span 子串校验:合法保留、非法丢弃', () => {
    const spans = validateSpans(
      'We propose a hardware accelerator for trace generation.',
      '我们为执行轨迹生成提出一种硬件加速器。',
      [
        { en: 'hardware accelerator', zh: '硬件加速器' },
        { en: 'trace generation', zh: '执行轨迹生成' },
        { en: 'not present', zh: '不存在' },
      ],
    );
    expect(spans).toHaveLength(2);
    expect(spans.every((s) => s.validated)).toBe(true);
  });
});
