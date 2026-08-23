import { describe, it, expect } from 'vitest';
import {
  parseLlmJson,
  runAiReview,
  combineIssues,
  isApproved,
  resolveIssue,
  buildProjectPackage,
  validateProjectPackage,
  type ReviewIssue,
} from '../../src/core/review/index';

const pairs = [
  { enBlockId: 'e1', zhBlockId: 'z1', enText: 'It achieves 18.3x speedup.', zhText: '它取得加速。' },
  { enBlockId: 'e2', zhBlockId: 'z2', enText: 'The architecture reduces latency.', zhText: '该架构降低了延迟。' },
  { enBlockId: 'e3', zhBlockId: 'z3', enText: 'Prior work uses GPUs.', zhText: '已有工作使用 GPU。' },
];

describe('review: AI 复审', () => {
  it('解析围栏 JSON 并收集 error', async () => {
    expect(parseLlmJson('```json\n{"a":1}\n```').a).toBe(1);
    const r = await runAiReview(pairs, {
      translate: async (ctx) =>
        ctx.enBlockId === 'e1'
          ? '```json\n{"issues":[{"severity":"error","message":"数字 18.3 漏译"}]}\n```'
          : '{"issues":[]}',
    });
    expect(r.pass).toBe(false);
    expect(r.issues.filter((i) => i.severity === 'error')).toHaveLength(1);
  });
});

describe('review: 门禁与项目包', () => {
  it('人工消解 error 后门禁通过;项目包校验和防篡改', async () => {
    const ai = await runAiReview(pairs, { translate: async () => '{"issues":[]}' });
    const rule: ReviewIssue[] = [
      { id: 'r1', kind: 'rule', severity: 'error', blockId: 'e3', message: '译文污染', rule: 'R7', resolved: false },
    ];
    const comb = combineIssues(rule, ai.issues);
    expect(comb.unresolvedErrors).toBe(1);
    expect(isApproved(comb.issues)).toBe(false);
    for (const it of comb.issues.filter((i) => i.severity === 'error')) resolveIssue(comb.issues, it.id, true);
    expect(isApproved(comb.issues)).toBe(true);

    const pkg = buildProjectPackage({
      mode: 'A',
      enDoc: { id: 'en', blocks: [] },
      zhDoc: { id: 'zh', blocks: [] },
      units: [],
      spans: [],
      terms: [],
      issues: comb.issues,
      auditPassed: true,
    });
    expect(validateProjectPackage(pkg).ok).toBe(true);

    const tampered = { ...pkg, zhDoc: { id: 'zh', blocks: [{ id: 'x', type: 'paragraph', text: 'tampered' }] } };
    const v = validateProjectPackage(tampered as any);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('checksum'))).toBe(true);
  });
});
