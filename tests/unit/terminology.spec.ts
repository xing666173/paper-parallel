import { describe, expect, it } from 'vitest';
import { markFirstOccurrences, mergeGlossary } from '../../src/core/translate/terminology';

describe('document terminology', () => {
  it('applies user over detected over model precedence after Unicode normalization', () => {
    expect(mergeGlossary({
      detected: [
        { source: 'Ｔｒａｃｅ', target: '轨迹' },
        { source: 'constraint', target: '约束' },
      ],
      model: [
        { source: 'trace', target: '执行轨迹' },
        { source: 'Constraint', target: '限制条件' },
      ],
      user: [{ source: 'Trace', target: '跟踪记录' }],
    })).toEqual([
      { source: 'Trace', target: '跟踪记录', sourceType: 'user' },
      { source: 'constraint', target: '约束', sourceType: 'detected' },
    ]);
  });

  it('marks only the first ordered whole-term occurrence without mutating blocks', () => {
    const blocks = [
      { blockId: 'a', source: 'Traceability differs from a trace.' },
      { blockId: 'b', source: 'The TRACE is stored.' },
    ];

    const marked = markFirstOccurrences(blocks, [
      { source: 'trace', target: '执行轨迹', abbreviation: 'Trace' },
    ]);

    expect(marked[0]?.firstTermIds).toEqual(['trace']);
    expect(marked[1]?.firstTermIds).toEqual([]);
    expect(blocks).toEqual([
      { blockId: 'a', source: 'Traceability differs from a trace.' },
      { blockId: 'b', source: 'The TRACE is stored.' },
    ]);
    expect(marked[0]).not.toBe(blocks[0]);
  });
});
