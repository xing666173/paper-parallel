import { describe, expect, it } from 'vitest';
import { createTaskSnapshot, reduceTaskEvent } from '../../src/core/task/stateMachine';

describe('task state machine', () => {
  it('allows the declared happy path and records timestamps', () => {
    let state = createTaskSnapshot('project-1', 1000);
    state = reduceTaskEvent(state, { type: 'START_PARSE', at: 1100 });
    state = reduceTaskEvent(state, { type: 'PARSE_DONE', at: 1200 });

    expect(state.stage).toBe('analyzing-layout');
    expect(state.startedAt).toBe(1100);
    expect(state.updatedAt).toBe(1200);
  });

  it('keeps validated progress when safely stopped', () => {
    let state = createTaskSnapshot('project-1', 1000);
    state = reduceTaskEvent(state, { type: 'START_TRANSLATION', total: 40, at: 1100 });
    state = reduceTaskEvent(state, { type: 'BLOCKS_VALIDATED', count: 12, at: 1200 });
    state = reduceTaskEvent(state, { type: 'STOP_REQUESTED', at: 1300 });
    state = reduceTaskEvent(state, { type: 'STOPPED', at: 1400 });

    expect(state.status).toBe('stopped');
    expect(state.progress.completed).toBe(12);
  });

  it('rejects completion before the quality gate passes', () => {
    const state = createTaskSnapshot('project-1', 1000);

    expect(() => reduceTaskEvent(state, { type: 'QUALITY_PASSED', at: 1200 })).toThrow(
      'QUALITY_PASSED is invalid from idle',
    );
  });
});
