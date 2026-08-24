import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserPrompt, runResumableTranslation, type SessionState, type TranslateBlockInput } from '../../src/core/translate/index';

const blocks: TranslateBlockInput[] = [
  { id: 'b01', type: 'section', text: '1 Intro', order: 0 },
  { id: 'b02', type: 'paragraph', text: 'The trace generation dominates latency.', order: 1 },
  { id: 'b03', type: 'paragraph', text: 'This block crashes the first run.', order: 2 },
  { id: 'b04', type: 'paragraph', text: 'The architecture reduces memory traffic.', order: 3 },
];

describe('translate: prompt assembly', () => {
  it('系统提示词拼接角色/任务/包装,用户提示词原文在最前', () => {
    const sys = buildSystemPrompt({ roleDefinition: 'R', task: 'T', wrapper: 'W' });
    expect(sys).toBe('R\n\nT\n\nW');
    const user = buildUserPrompt({
      pass: 2,
      userPrompt: '原文提示词',
      chapterTitle: '1 引言',
      terms: [{ zh: '执行轨迹', en: 'Trace', abbr: undefined }],
      block: { id: 'x', type: 'paragraph', text: 'hello', order: 0 },
    });
    expect(user.startsWith('原文提示词')).toBe(true);
    expect(user).toContain('【当前章节】1 引言');
    expect(user).toContain('执行轨迹（Trace）');
    expect(user).toContain('【待翻译块】');
  });
});

describe('translate: resumable session', () => {
  it('mock 与 real 及不同翻译器版本使用互不冲突的缓存键', () => {
    const buildKey = (globalThis as any).PaperParallelTranslateSession
      .buildSessionStorageKey as (base: string, engine: string, version: string) => string;
    expect(typeof buildKey).toBe('function');

    const keys = [
      buildKey('paper.pdf@123', 'mock', '2'),
      buildKey('paper.pdf@123', 'real', '1'),
      buildKey('paper.pdf@123', 'mock', '3'),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain('paper.pdf@123');
  });

  async function makeEnv() {
    const store: SessionState = { byId: {}, terms: [] };
    let run = 0;
    const calls: string[] = [];
    const translate = async (ctx: any) => {
      calls.push(`${run}:${ctx.pass}:${ctx.block?.id ?? 'chapter'}`);
      if (ctx.pass === 1) return '零知识虚拟机（Zero-Knowledge Virtual Machine, zkVM）与执行轨迹（Trace）。';
      const t = (ctx.block.text as string).trim();
      if (ctx.block.type === 'section') return t;
      if (run === 1 && ctx.block.id === 'b03') throw new Error('simulated crash');
      return '已译:' + t.slice(0, 12);
    };
    const opts = () => ({
      translate,
      loadState: () => store,
      saveState: async (s: SessionState) => { store.byId = s.byId; store.terms = s.terms; },
      maxRetries: 1,
      systemPrompt: 'SYS',
      userPrompt: 'USER',
    });
    return { store, calls, opts, nextRun: () => ++run };
  }

  it('第一轮中途失败,第二轮复用已完成块并续跑成功', async () => {
    const env = await makeEnv();
    env.nextRun(); // run=1
    const r1 = await runResumableTranslation(blocks, env.opts());
    expect(r1.blocks.find((b) => b.id === 'b03')?.status).toBe('failed');
    expect(r1.stats.done).toBe(3);

    env.nextRun(); // run=2
    const before = env.calls.length;
    const r2 = await runResumableTranslation(blocks, env.opts());
    expect(r2.stats.resumed).toBe(3);
    expect(r2.stats.done).toBe(4);
    expect(r2.stats.failed).toBe(0);
    const newCalls = env.calls.slice(before).filter((c) => c.startsWith('2:2:'));
    expect(newCalls).toEqual(['2:2:b03']); // 已完成块不重跑
    expect(r2.terms.length).toBeGreaterThanOrEqual(2); // 术语表跨轮复用
  });
});
