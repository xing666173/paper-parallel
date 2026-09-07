import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createTaskStore } from '../../src/stores/task';
import { createTaskSnapshot, reduceTaskEvent } from '../../src/core/task/stateMachine';
import type { ProjectRepository } from '../../src/core/project/repository';

let sequence = 0;
function runningTask(projectId = 'p1') {
  return reduceTaskEvent(createTaskSnapshot(projectId), { type: 'START_TRANSLATION', total: 20, at: 1 });
}
function storeWithSave(saveTask = vi.fn(async () => undefined)) {
  const repository = { saveTask } as unknown as ProjectRepository;
  return { repository, store: createTaskStore({ repository }, `lifecycle-${++sequence}`)() };
}

describe('task ownership and stopping', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('aborts before any local save and remains stopped when storage rejects', async () => {
    let signal!: AbortSignal;
    const saveTask = vi.fn(async () => {
      expect(signal.aborted).toBe(true);
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const { store } = storeWithSave(saveTask);
    const running = store.start(runningTask(), async (value) => {
      signal = value;
      await new Promise(() => {});
    });
    await store.safeStop();
    await running;
    expect(store.current?.status).toBe('stopped');
    expect(store.current?.error).toContain('本地状态保存失败');
    expect(store.abortController).toBeNull();
  });

  it('rejects late running snapshots during and after a stop while preserving validated progress', async () => {
    const { store } = storeWithSave();
    let signal!: AbortSignal;
    const task = { ...runningTask(), progress: { completed: 7, total: 20, retries: 0, failed: 0 } };
    const running = store.start(task, async (value) => { signal = value; await new Promise(() => {}); });
    const stopping = store.safeStop();
    expect(store.acceptSnapshot({ ...task, progress: { ...task.progress, completed: 8 } }, signal)).toBe(false);
    await stopping;
    await running;
    expect(store.acceptSnapshot(task, signal)).toBe(false);
    expect(store.current).toMatchObject({ status: 'stopped', progress: { completed: 7 } });
  });

  it('ignores an earlier run snapshot and late failure after a new task starts', async () => {
    const { store } = storeWithSave();
    let oldSignal!: AbortSignal;
    let rejectOld!: (error: Error) => void;
    const first = store.start(runningTask('old'), async (signal) => {
      oldSignal = signal;
      await new Promise((_resolve, reject) => { rejectOld = reject; });
    });
    const second = store.start(runningTask('new'), async () => new Promise(() => {}));
    expect(oldSignal.aborted).toBe(true);
    expect(store.acceptSnapshot({ ...runningTask('new'), status: 'completed' }, oldSignal)).toBe(false);
    rejectOld(new Error('old failure'));
    await first;
    expect(store.current).toMatchObject({ projectId: 'new', status: 'running' });
    await store.safeStop();
    await second;
  });

  it('recovers a saved running task but leaves an owned live task running', async () => {
    const { store } = storeWithSave();
    store.current = runningTask();
    await store.recoverInterruptedStop();
    expect(store.current.status).toBe('stopped');
    const running = store.start(runningTask(), async () => new Promise(() => {}));
    await store.recoverInterruptedStop();
    expect(store.current.status).toBe('running');
    await store.safeStop();
    await running;
  });
});
