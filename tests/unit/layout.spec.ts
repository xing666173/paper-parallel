import { describe, it, expect } from 'vitest';
import { paginate, DEFAULT_GEOM, type PaginatorBlockInput } from '../../src/core/paginate/index';
import { buildLayout, auditLayout } from '../../src/core/paginate/layout';

function fakeMeasure(text: string, w: number, fs: number): number {
  const lh = fs * 1.6;
  const cpl = Math.max(1, Math.floor(w / (fs * 1.05)));
  return Math.max(lh, Math.ceil([...text].length / cpl) * lh);
}

function makeBlocks(): PaginatorBlockInput[] {
  const B: PaginatorBlockInput[] = [];
  let n = 0;
  const add = (o: Omit<PaginatorBlockInput, 'id'>) => B.push({ id: 'b' + ++n, ...o });
  add({ type: 'title', text: '标题', widthMode: 'span', frontMatter: true, fontSize: 17 });
  add({ type: 'authors', text: '作者', widthMode: 'span', frontMatter: true, fontSize: 11 });
  add({ type: 'section', text: '1 引言', fontSize: 14 });
  add({ type: 'paragraph', text: '第一段内容。'.repeat(20), fontSize: 13 });
  add({ type: 'figure', widthMode: 'column', atomicH: 200, caption: '图 1' });
  add({ type: 'paragraph', text: '第二段内容。'.repeat(15), fontSize: 13 });
  add({ type: 'table', widthMode: 'span', atomicH: 250, caption: '表 1' });
  add({ type: 'paragraph', text: '第三段内容。'.repeat(12), fontSize: 13 });
  add({ type: 'table', widthMode: 'span', atomicH: 1180, caption: '超大表' });
  return B;
}

describe('paginate: layout', () => {
  it('buildLayout 与分页日志一一对应,audit 无越界', () => {
    const blocks = makeBlocks();
    const result = paginate(blocks, { mode: 'double', measureText: fakeMeasure });
    const layout = buildLayout(result);
    const placements = layout.reduce((n, p) => n + p.placements.length, 0);
    expect(placements).toBe(result.log.length);
    expect(auditLayout(result, layout)).toEqual([]);
  });

  it('跨栏块坐标横跨可用宽度,超高块 scaled 标记', () => {
    const blocks = makeBlocks();
    const result = paginate(blocks, { mode: 'double', measureText: fakeMeasure });
    const layout = buildLayout(result);
    const spans = layout.flatMap((p) => p.placements.filter((x) => x.col === 'span'));
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.x).toBe(DEFAULT_GEOM.margin);
      expect(s.w).toBe(DEFAULT_GEOM.usableW);
    }
    const huge = layout.flatMap((p) => p.placements).find((x) => x.blockId === 'b9');
    expect(huge?.scaled).toBe(true);
  });

  it('三种版式全部通过 audit', () => {
    const blocks = makeBlocks();
    for (const mode of ['double', 'single', 'mixed'] as const) {
      const result = paginate(blocks, { mode, measureText: fakeMeasure });
      const layout = buildLayout(result);
      expect(auditLayout(result, layout)).toEqual([]);
    }
  });
});
