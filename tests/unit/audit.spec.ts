import { describe, it, expect } from 'vitest';
import { runRuleAudit, type AuditBlock, type TranslationPair } from '../../src/core/audit/index';

function base() {
  const en: AuditBlock[] = [
    { id: 'e-t', type: 'title', text: 'A High-Performance Accelerator', order: 0 },
    { id: 'e-s1', type: 'section', text: '1 Introduction', order: 1 },
    { id: 'e-p1', type: 'paragraph', text: 'It achieves 18.3x speedup in 2024.', order: 2 },
    { id: 'e-f', type: 'figure', text: 'Figure 1: Workflow', order: 3 },
    { id: 'e-p2', type: 'paragraph', text: 'The architecture reduces latency.', order: 4 },
    { id: 'e-tab', type: 'table', text: 'Table 1: Results', order: 5 },
    { id: 'e-eq', type: 'equation', text: '(1)', order: 6 },
    { id: 'e-s2', type: 'section', text: '2 Background', order: 7 },
    { id: 'e-ref', type: 'reference', text: '[1] Prior work.', order: 8 },
  ];
  const zh: AuditBlock[] = [
    { id: 'z-t', type: 'title', text: '高性能加速器（zkVM）', order: 0 },
    { id: 'z-s1', type: 'section', text: '1 引言', order: 1 },
    { id: 'z-p1', type: 'paragraph', text: '它在 2024 年取得 18.3 倍加速。', order: 2 },
    { id: 'z-f', type: 'figure', text: '图 1:工作流', order: 3 },
    { id: 'z-p2', type: 'paragraph', text: '该架构降低了延迟。', order: 4 },
    { id: 'z-tab', type: 'table', text: '表 1:结果', order: 5 },
    { id: 'z-eq', type: 'equation', text: '(1)', order: 6 },
    { id: 'z-s2', type: 'section', text: '2 背景', order: 7 },
    { id: 'z-ref', type: 'reference', text: '[1] 已有工作。', order: 8 },
  ];
  const pairIds = [['e-t', 'z-t'], ['e-s1', 'z-s1'], ['e-p1', 'z-p1'], ['e-p2', 'z-p2'], ['e-s2', 'z-s2'], ['e-ref', 'z-ref']] as const;
  const pairs: TranslationPair[] = pairIds.map(([a, b]) => ({
    enBlockId: a,
    zhBlockId: b,
    zhText: zh.find((x) => x.id === b)!.text!,
  }));
  return { en, zh, pairs };
}

describe('audit: 规则审核', () => {
  it('正常论文:0 error 0 warn,门禁通过', () => {
    const fx = base();
    const r = runRuleAudit({ enBlocks: fx.en, zhBlocks: fx.zh, pairs: fx.pairs, terms: [{ zh: '零知识虚拟机', en: 'Zero-Knowledge Virtual Machine', abbr: 'zkVM' }] });
    expect(r.pass).toBe(true);
    expect(r.errors).toBe(0);
    expect(r.warns).toBe(0);
  });

  it('场景B:allowUnpaired 的 1:0 块判 warn 而非 error', () => {
    const fx = base();
    fx.pairs = fx.pairs.filter((p) => p.enBlockId !== 'e-p2');
    const r = runRuleAudit({ enBlocks: fx.en, zhBlocks: fx.zh, pairs: fx.pairs, allowUnpaired: ['e-p2'] });
    expect(r.pass).toBe(true);
    expect(r.issues.find((i) => i.blockId === 'e-p2')).toMatchObject({ severity: 'warn', rule: 'R4' });
  });

  it('埋错夹具:R1/R2/R3/R4/R7 为 error,R6/R8 为 warn', () => {
    const fx = base();
    fx.zh.splice(7, 1, { id: 'z-s2', type: 'section', text: '3 背景', order: 7 });
    fx.zh.splice(5, 1);
    fx.pairs[2].zhText = '翻译说明:这是一段说明。';
    fx.pairs = fx.pairs.filter((p) => p.enBlockId !== 'e-p2');
    fx.zh[2].text = '它取得 18.3 倍加速。';
    const r = runRuleAudit({ enBlocks: fx.en, zhBlocks: fx.zh, pairs: fx.pairs, terms: [{ zh: '零知识虚拟机', en: 'Zero-Knowledge Virtual Machine', abbr: 'ABC' }] });
    expect(r.pass).toBe(false);
    const rules = r.issues.map((i) => i.rule);
    expect(['R1', 'R2', 'R3', 'R4', 'R7'].every((x) => rules.includes(x))).toBe(true);
    expect(rules.includes('R6')).toBe(true);
    expect(rules.includes('R8')).toBe(true);
    expect(r.issues.filter((i) => i.severity === 'error').length).toBeGreaterThan(0);
  });
});
