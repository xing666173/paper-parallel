import { describe, it, expect } from 'vitest';
import {
  extractTerms,
  runTranslationPipeline,
  validateTranslation,
} from '../../src/core/translate';

const calls: any[] = [];
async function mockTranslate(ctx: any): Promise<string> {
  calls.push({ pass: ctx.pass, blockId: ctx.block && ctx.block.id, attempt: ctx.attempt, terms: ctx.terms.length });
  if (ctx.pass === 1) {
    return '本章围绕零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）展开。执行轨迹（Trace）是关键。加速器（Accelerator）用于卸载。';
  }
  const t = (ctx.block.text || '').trim();
  if (t.includes('FAIL_FOREVER')) throw new Error('permanent');
  if (t.includes('FAIL_ONCE') && ctx.attempt === 0) throw new Error('transient');
  if (t.includes('BAD_PREFIX') && ctx.attempt === 0) return '翻译说明:说明性文字不应作为译文。';
  if (ctx.block.type === 'section') return t;
  return '已译：' + (t.includes('execution trace') ? '执行轨迹（Trace）的生成速度决定延迟。' : '该段落描述架构设计与实验配置。');
}

const blocks = [
  { id: 'b01', type: 'section', text: '1 Introduction', order: 0 },
  { id: 'b02', type: 'paragraph', text: 'The execution trace generation dominates latency.', order: 1 },
  { id: 'b03', type: 'paragraph', text: 'FAIL_ONCE transient.', order: 2 },
  { id: 'b04', type: 'paragraph', text: 'BAD_PREFIX validation.', order: 3 },
  { id: 'b05', type: 'paragraph', text: 'FAIL_FOREVER always fails.', order: 4 },
  { id: 'b06', type: 'paragraph', text: 'The proposed architecture reduces memory traffic.', order: 5 },
];

describe('translate pipeline core(与浏览器探针同一份源码)', () => {
  it('两遍法 + 术语抽取 + 串行保序 + 重试校验 + 失败续跑', async () => {
    const res = await runTranslationPipeline(blocks, {
      translate: mockTranslate,
      maxRetries: 2,
      systemPrompt: 'SYS',
      userPrompt: 'USR',
    });
    expect(res.stats.pass1Chapters).toBe(1);
    expect(res.terms.map((t: any) => t.abbr || t.en)).toEqual(['zkVM', 'Trace', 'Accelerator']);
    expect(res.blocks.map((b: any) => b.id)).toEqual(blocks.map((b) => b.id));
    expect(res.blocks.find((b) => b.id === 'b03')).toMatchObject({ status: 'done', attempts: 2 });
    expect(res.blocks.find((b) => b.id === 'b04')!.attempts).toBe(2);
    expect(res.blocks.find((b) => b.id === 'b05')!.status).toBe('failed');
    expect(res.blocks.find((b) => b.id === 'b06')!.status).toBe('done');
    expect(res.stats.done).toBe(5);
    expect(res.stats.failed).toBe(1);
    expect(calls.filter((c) => c.pass === 2 && c.blockId === 'b06').every((c) => c.terms >= 3)).toBe(true);
    expect(res.assembled).toContain('执行轨迹');
    expect(res.assembled).not.toContain('翻译说明:');
  });

  it('extractTerms:捕获带缩写、无缩写术语,去重', () => {
    const terms = extractTerms('零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）和证明（Proof）。以及零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）');
    expect(terms).toHaveLength(2);
    expect(terms[0]).toEqual({ zh: '零知识虚拟机', en: 'Zero-Knowledge Virtual Machine', abbr: 'zkVM' });
    expect(terms[1].abbr).toBeUndefined();
  });

  it('validateTranslation:拒绝说明前缀与近全英文', () => {
    expect(validateTranslation('翻译说明:这是译文', 'some english source text long enough').ok).toBe(false);
    expect(validateTranslation('This is entirely English output text', 'The source paragraph has more than twenty characters').ok).toBe(false);
    expect(validateTranslation('这是正常的中文译文。', 'The source paragraph has more than twenty characters').ok).toBe(true);
  });
});
