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

describe('composition task transitions', () => {
  it('advances only through composition, compilation, alignment and quality', () => {
    let task = reduceTaskEvent(createTaskSnapshot('p-compose', 1), {
      type: 'START_TRANSLATION', total: 2, at: 2,
    });
    task = reduceTaskEvent(task, { type: 'BLOCKS_VALIDATED', count: 2, at: 3 });
    task = reduceTaskEvent(task, { type: 'TRANSLATION_DONE', at: 4 });
    expect(task.stage).toBe('composing');
    task = reduceTaskEvent(task, { type: 'COMPOSITION_DONE', at: 5 });
    expect(task.stage).toBe('compiling');
    task = reduceTaskEvent(task, { type: 'COMPILE_DONE', at: 6 });
    expect(task.stage).toBe('aligning');
    task = reduceTaskEvent(task, { type: 'ALIGNMENT_DONE', at: 7 });
    task = reduceTaskEvent(task, { type: 'QUALITY_STARTED', at: 8 });
    expect(task.stage).toBe('validating');
    task = reduceTaskEvent(task, { type: 'QUALITY_PASSED', at: 9 });
    expect(task).toMatchObject({ stage: 'completed', status: 'completed' });
  });

  it('rejects translation completion while mandatory blocks remain', () => {
    const task = reduceTaskEvent(createTaskSnapshot('p-incomplete', 1), {
      type: 'START_TRANSLATION', total: 2, at: 2,
    });
    expect(() => reduceTaskEvent(task, { type: 'TRANSLATION_DONE', at: 3 })).toThrow();
  });
});
