import { describe, it, expect } from 'vitest';
import { paginate, validateOrder, type PaginatorBlockInput } from '../../src/core/paginate/index';
import { runResumableTranslation, type SessionState, type TranslateBlockInput } from '../../src/core/translate/index';
import { alignBlockPair } from '../../src/core/align/index';
import { runRuleAudit, type AuditBlock } from '../../src/core/audit/index';
import { runAiReview, combineIssues, isApproved, buildProjectPackage, validateProjectPackage } from '../../src/core/review/index';

/** 与浏览器探针 ext-p18-integration-test.html 完全一致的合成论文 */
function makeBlocks() {
  const blocks: (PaginatorBlockInput & TranslateBlockInput & AuditBlock)[] = [
    { id: 'b01', type: 'title', text: 'A High-Performance Accelerator for ZKVM Trace Generation', fontSize: 17, widthMode: 'span', frontMatter: true, order: 0 },
    { id: 'b02', type: 'authors', text: 'Author One, Author Two, Southeast University', fontSize: 11, widthMode: 'span', frontMatter: true, order: 1 },
    { id: 'b03', type: 'abstract', text: 'This paper studies hardware acceleration for zero-knowledge virtual machines.', fontSize: 12, widthMode: 'span', frontMatter: true, order: 2 },
    { id: 'b04', type: 'section', text: '1 Introduction', fontSize: 14, order: 3 },
    { id: 'b05', type: 'paragraph', text: 'The execution trace generation dominates end-to-end latency. We propose a hardware accelerator.', fontSize: 13, order: 4 },
    { id: 'b06', type: 'figure', atomicH: 220, widthMode: 'column', caption: 'Figure 1: Workflow', text: '', order: 5 },
    { id: 'b07', type: 'paragraph', text: 'The proposed architecture reduces memory traffic by 18.3x.', fontSize: 13, order: 6 },
    { id: 'b08', type: 'section', text: '2 Background', fontSize: 14, order: 7 },
    { id: 'b09', type: 'paragraph', text: 'Prior work uses GPUs for multi-scalar multiplication.', fontSize: 13, order: 8 },
    { id: 'b10', type: 'reference', text: '[1] Prior work.', fontSize: 11, order: 9 },
  ];
  return blocks;
}

async function mockTranslate(ctx: any): Promise<string> {
  if (ctx.pass === 1) return '本章围绕零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）展开。执行轨迹（Trace）的生成是关键。加速器（Accelerator）用于卸载。';
  const map: Record<string, string> = {
    b01: '面向零知识虚拟机轨迹生成的高性能加速器',
    b02: '作者一，作者二，东南大学',
    b03: '摘要——本文研究零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）的硬件加速。',
    b04: '1 引言',
    b05: '执行轨迹（Trace）的生成主导了端到端延迟。我们提出一种硬件加速器。',
    b07: '所提架构将内存访问降低了 18.3 倍。',
    b08: '2 背景',
    b09: '已有工作使用 GPU 进行多标量乘法。',
    b10: '[1] 已有工作。',
  };
  return map[ctx.block.id] || '已译：' + ctx.block.text;
}

function fakeMeasure(text: string, w: number, fs: number): number {
  const lh = fs * 1.6;
  const cpl = Math.max(1, Math.floor(w / (fs * 1.05)));
  return Math.max(lh, Math.ceil([...text].length / cpl) * lh);
}

describe('integration: 合成论文端到端(解析后六模块串行)', () => {
  it('翻译 -> 分页 -> 对齐 -> 规则审核 -> AI 复审 -> 门禁 -> 项目包', async () => {
    const blocks = makeBlocks();
    const TEXT = new Set(['title', 'authors', 'abstract', 'keywords', 'section', 'paragraph', 'reference', 'caption']);
    const textBlocks = blocks.filter((b) => TEXT.has(b.type));
    const nonText = blocks.filter((b) => !TEXT.has(b.type));

    // 1 翻译
    const store: SessionState = { byId: {}, terms: [] };
    const tr = await runResumableTranslation(textBlocks, {
      translate: mockTranslate,
      loadState: () => store,
      saveState: async (s) => { store.byId = s.byId; store.terms = s.terms; },
      maxRetries: 1,
      systemPrompt: 'SYS',
      userPrompt: 'USER',
    });
    expect(tr.stats.failed).toBe(0);
    expect(tr.terms.length).toBeGreaterThanOrEqual(3);

    // 2 分页
    const zhTextBlocks = textBlocks.map((b) => ({ ...b, text: tr.blocks.find((x) => x.id === b.id)!.zhText }));
    const zhBlocks = [...zhTextBlocks, ...nonText.map((b) => ({ ...b }))].sort((a, b) => a.order - b.order);
    const layout = paginate(zhBlocks, { mode: 'double', measureText: fakeMeasure });
    expect(validateOrder(zhBlocks, layout.log).ok).toBe(true);
    expect(layout.pages.length).toBeGreaterThanOrEqual(1);

    // 3 句级对齐 + span
    const enText = blocks.find((b) => b.id === 'b05')!.text!;
    const zhText = zhBlocks.find((b) => b.id === 'b05')!.text!;
    const pair = await alignBlockPair({ id: 'b05', text: enText }, { id: 'b05', text: zhText }, {
      scoreFn: async (i, j) => {
        const e = ['The execution trace generation dominates end-to-end latency.', 'We propose a hardware accelerator.'];
        const z = ['执行轨迹（Trace）的生成主导了端到端延迟。', '我们提出一种硬件加速器。'];
        const KW: [string, string][] = [['trace', '执行轨迹'], ['latency', '延迟'], ['propose', '提出'], ['accelerator', '加速器']];
        let h = 0;
        for (const [x, y] of KW) if (e[i].toLowerCase().includes(x) && z[j].includes(y)) h++;
        return Math.min(1, h / 2);
      },
      spansForPair: async () => [{ en: 'hardware accelerator', zh: '硬件加速器' }],
    });
    expect(pair.level).toBe('sentence');
    expect(pair.spans).toHaveLength(1);

    // 4 规则审核
    const pairs = textBlocks.map((b) => ({
      enBlockId: b.id,
      zhBlockId: b.id,
      zhText: zhBlocks.find((x) => x.id === b.id)!.text!,
    }));
    const audit = runRuleAudit({ enBlocks: blocks, zhBlocks, pairs, terms: tr.terms });
    expect(audit.pass).toBe(true);

    // 5 AI 复审(无问题)
    const ai = await runAiReview(pairs.map((p) => ({ ...p, enText: blocks.find((b) => b.id === p.enBlockId)!.text! })), {
      translate: async () => '{"issues":[]}',
    });
    const comb = combineIssues(audit.issues, ai.issues);
    expect(comb.unresolvedErrors).toBe(0);

    // 6 门禁 + 项目包
    const approved = isApproved(comb.issues);
    const pkg = buildProjectPackage({
      mode: 'A',
      enDoc: { id: 'en', blocks },
      zhDoc: { id: 'zh', blocks: zhBlocks },
      units: blocks.map((b) => ({ enBlockIds: [b.id], zhBlockIds: [b.id] })),
      spans: pair.spans,
      terms: tr.terms,
      issues: comb.issues,
      auditPassed: approved,
    });
    expect(approved).toBe(true);
    expect(validateProjectPackage(pkg).ok).toBe(true);
  });
});
