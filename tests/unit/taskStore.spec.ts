import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProjectRepository } from '../../src/core/project/repository';
import { createTaskSnapshot, reduceTaskEvent } from '../../src/core/task/stateMachine';
import { createTaskStore } from '../../src/stores/task';

let sequence = 0;

function setupStore() {
  sequence += 1;
  const repository = createProjectRepository(`task-store-test-${sequence}`);
  const useStore = createTaskStore({ repository }, `task-test-${sequence}`);
  return { store: useStore(), repository };
}

function runningTranslationTask(projectId = 'p1') {
  return reduceTaskEvent(createTaskSnapshot(projectId, 1), {
    type: 'START_TRANSLATION', total: 20, at: 2,
  });
}

describe('project task store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('projects fixed safe AI messages and bounds the log', () => {
    const { store } = setupStore();
    store.recordAiEvent({
      type: 'batch-started', at: 1, batchId: 'b1', blockIds: ['x'], modelId: 'deepseek-v4-flash',
    });
    store.recordAiEvent({
      type: 'error', at: 2, batchId: 'b1', message: 'server echoed sk-super-secret',
    });
    for (let index = 0; index < 205; index += 1) {
      store.recordAiEvent({ type: 'cache-hit', at: index + 3, blockId: `block-${index}` });
    }

    expect(store.aiLog).toHaveLength(200);
    expect(store.aiLog.at(-1)?.message).toContain('block-204');
    expect(JSON.stringify(store.aiLog)).not.toContain('sk-super-secret');
    expect(JSON.stringify(store.aiLog)).not.toContain('server echoed');
  });

  it('shows safe retry and adaptive-split reasons without exposing reasoning text', () => {
    const { store } = setupStore();
    store.recordAiEvent({
      type: 'batch-split', at: 1, batchId: 'batch-1', childBatchIds: ['batch-1a', 'batch-1b'],
      reason: '输出额度耗尽（reasoning_content=present）',
    });
    store.recordAiEvent({
      type: 'retry', at: 2, batchId: 'batch-1a', attempt: 1, reason: 'DeepSeek HTTP 503',
    });

    expect(store.aiLog.map((entry) => entry.message)).toEqual([
      '批次 batch-1 输出过长，已拆分为 batch-1a、batch-1b：输出额度耗尽（reasoning_content=present）',
      '批次 batch-1a 正在进行第 1 次重试：DeepSeek HTTP 503',
    ]);
    expect(store.lastResponseAt).toBe(1);
  });

  it('safely stops active work, preserves validated progress, and persists stopped state', async () => {
    const { store, repository } = setupStore();
    const task = reduceTaskEvent(runningTranslationTask(), {
      type: 'BLOCKS_VALIDATED', count: 7, at: 3,
    });
    const running = store.start(task, async (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    }));

    await store.safeStop();
    await running;

    expect(store.current?.status).toBe('stopped');
    expect(store.current?.progress.completed).toBe(7);
    expect((await repository.loadTask('p1'))?.status).toBe('stopped');
  });

  it('resumes a stopped task without resetting validated progress', async () => {
    const { store, repository } = setupStore();
    const task = reduceTaskEvent(
      reduceTaskEvent(
        reduceTaskEvent(runningTranslationTask(), { type: 'BLOCKS_VALIDATED', count: 7, at: 3 }),
        { type: 'STOP_REQUESTED', at: 4 },
      ),
      { type: 'STOPPED', at: 5 },
    );
    store.current = task;

    await store.resume(async () => undefined, 6);

    expect(store.current?.status).toBe('running');
    expect(store.current?.progress.completed).toBe(7);
    expect((await repository.loadTask('p1'))?.progress.completed).toBe(7);
  });

  it('clears only the current project translation cache', async () => {
    const { store, repository } = setupStore();
    store.current = runningTranslationTask('a');
    await repository.putTranslation({
      key: 'a:1', projectId: 'a', blockId: '1', translation: '甲', alignmentGroups: [], validatedAt: 1,
    });
    await repository.putTranslation({
      key: 'b:1', projectId: 'b', blockId: '1', translation: '乙', alignmentGroups: [], validatedAt: 1,
    });

    await store.clearTranslationCache();

    expect(await repository.findTranslation('a:1')).toBeUndefined();
    expect(await repository.findTranslation('b:1')).toBeDefined();
  });
});
