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
      type: 'error', at: 2, batchId: 'b1', blockIds: ['x'], message: 'server echoed sk-super-secret',
    });
    const projectedError = store.aiLog.at(-1)?.message;
    for (let index = 0; index < 205; index += 1) {
      store.recordAiEvent({ type: 'cache-hit', at: index + 3, blockId: `block-${index}` });
    }

    expect(store.aiLog).toHaveLength(200);
    expect(store.aiLog.at(-1)?.message).toContain('block-204');
    expect(projectedError).toBe('批次 b1（x）失败');
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
      '批次 batch-1 响应异常，已拆分为 batch-1a、batch-1b：输出额度耗尽（reasoning_content=present）',
      '批次 batch-1a 正在进行第 1 次重试：DeepSeek HTTP 503',
    ]);
    expect(store.lastResponseAt).toBe(1);
  });

  it('logs rejected approximate Vision regions as local fallbacks instead of terminal failures', () => {
    const { store } = setupStore();
    store.recordAiEvent({
      type: 'vision-layout-fallback', at: 9, page: 3, region: 2, reason: 'caption-unmatched',
    });

    expect(store.aiLog.at(-1)?.message).toBe(
      'Vision Exp 第 3 页区域 2 未通过本地几何门（caption-unmatched），已改用 PDF 文字层回退识别',
    );
    expect(store.lastResponseAt).toBe(9);
  });

  it('shows page-level progress as soon as visual layout analysis starts', () => {
    const { store } = setupStore();
    store.recordAiEvent({ type: 'vision-layout-page-started', at: 10, page: 1, totalPages: 8 });

    expect(store.aiLog.at(-1)?.message).toBe('Vision Exp 版式识别：开始分析第 1/8 页');
    expect(store.lastResponseAt).toBe(10);

    store.recordAiEvent({
      type: 'vision-layout-page-phase', at: 11, page: 5, totalPages: 8, phase: 'render-retrying',
    });
    expect(store.aiLog.at(-1)?.message).toContain('第 5/8 页首次渲染超时');
    expect(store.lastResponseAt).toBe(11);

    store.recordAiEvent({
      type: 'vision-layout-page-phase', at: 12, page: 6, totalPages: 8, phase: 'analysis-retrying',
    });
    expect(store.aiLog.at(-1)?.message).toContain('第 6/8 页响应无效，正在自动重试');

    store.recordAiEvent({
      type: 'vision-layout-page-phase', at: 13, page: 6, totalPages: 8, phase: 'analysis-paused',
    });
    expect(store.aiLog.at(-1)?.message).toContain('任务已暂停并保留已验证页面');
  });

  it('shows page-level progress as soon as final visual review starts', () => {
    const { store } = setupStore();
    store.recordAiEvent({ type: 'vision-review-page-started', at: 11, page: 2, totalPages: 7 });

    expect(store.aiLog.at(-1)?.message).toBe('Vision Exp 成品质检：开始检查第 2/7 页');
    expect(store.lastResponseAt).toBe(11);
  });

  it('reports the exact final-review page when its hard deadline expires', () => {
    const { store } = setupStore();
    store.recordAiEvent({ type: 'vision-review-page-timeout', at: 12, page: 3, totalPages: 11, timeoutMs: 90_000 });

    expect(store.aiLog.at(-1)?.message).toBe('Vision Exp 成品质检：第 3/11 页超过 90 秒，已跳过该页并继续');
    expect(store.lastResponseAt).toBe(12);
  });

  it('reports a heartbeat while a final-review page is still waiting', () => {
    const { store } = setupStore();
    store.recordAiEvent({ type: 'vision-review-page-waiting', at: 13, page: 2, totalPages: 11, elapsedMs: 30_400 });

    expect(store.aiLog.at(-1)?.message).toBe('Vision Exp 成品质检：第 2/11 页仍在等待（30 秒）');
    expect(store.lastResponseAt).toBe(13);
  });

  it('reports when all final-review pages have returned', () => {
    const { store } = setupStore();
    store.recordAiEvent({ type: 'vision-review-completed', at: 14, reviewedPages: 11, issueCount: 3 });

    expect(store.aiLog.at(-1)?.message).toBe('Vision Exp 成品质检：已返回 11 页，共发现 3 个可见问题');
    expect(store.lastResponseAt).toBe(14);
  });

  it('reports final visual-gate and persistence phases', () => {
    const { store } = setupStore();
    store.recordAiEvent({ type: 'quality-finalizing', at: 15, visualPass: true, severeIssueCount: 0 });
    expect(store.aiLog.at(-1)?.message).toBe('质量门通过，正在保存中文 PDF 与对齐数据');
    store.recordAiEvent({ type: 'quality-persisted', at: 16 });
    expect(store.aiLog.at(-1)?.message).toBe('中文 PDF 与对齐数据已保存');
  });

  it('reports the active sub-phase of a final-review page', () => {
    const { store } = setupStore();
    store.recordAiEvent({
      type: 'vision-review-page-phase', at: 12, page: 6, totalPages: 11, phase: 'rendered',
    });

    expect(store.aiLog.at(-1)?.message).toBe('Vision Exp 成品质检：第 6/11 页已渲染，正在连接 API');
    expect(store.lastResponseAt).toBe(12);
  });

  it('reports a final-review protocol failure before the task unwinds', () => {
    const { store } = setupStore();
    store.recordAiEvent({
      type: 'vision-review-page-invalid', at: 13, page: 7, totalPages: 11,
      reason: 'Vision 成品质检 target_page 与请求页面不一致',
    });

    expect(store.aiLog.at(-1)?.message).toBe(
      'Vision Exp 成品质检：第 7/11 页响应校验失败：Vision 成品质检 target_page 与请求页面不一致',
    );
  });

  it('coalesces streaming heartbeats while keeping the latest phase visible', () => {
    const { store } = setupStore();
    store.recordAiEvent({
      type: 'batch-started', at: 1, batchId: 'batch-1', blockIds: ['b1'], modelId: 'deepseek-v4-pro',
    });
    store.recordAiEvent({
      type: 'batch-progress', at: 2, batchId: 'batch-1', phase: 'reasoning', receivedContentChars: 0,
    });
    store.recordAiEvent({
      type: 'batch-progress', at: 3, batchId: 'batch-1', phase: 'reasoning', receivedContentChars: 0,
    });
    store.recordAiEvent({
      type: 'batch-progress', at: 4, batchId: 'batch-1', phase: 'content', receivedContentChars: 128,
    });

    expect(store.aiLog).toHaveLength(2);
    expect(store.aiLog.at(-1)).toMatchObject({
      at: 4,
      type: 'batch-progress',
      message: '批次 batch-1 正在流式接收：生成译文中（已接收 128 个字符）',
    });
    expect(store.lastResponseAt).toBe(4);
  });

  it('keeps concurrent batch heartbeats separate', () => {
    const { store } = setupStore();
    store.recordAiEvent({
      type: 'batch-progress', at: 1, batchId: 'batch-1', phase: 'reasoning', receivedContentChars: 0,
    });
    store.recordAiEvent({
      type: 'batch-progress', at: 2, batchId: 'batch-2', phase: 'reasoning', receivedContentChars: 0,
    });
    store.recordAiEvent({
      type: 'batch-progress', at: 3, batchId: 'batch-1', phase: 'content', receivedContentChars: 64,
    });

    expect(store.aiLog).toHaveLength(2);
    expect(store.aiLog.map((entry) => entry.batchId)).toEqual(['batch-2', 'batch-1']);
    expect(store.aiLog.at(-1)?.message).toContain('已接收 64 个字符');
  });

  it('restores the current project AI log after a page reload', async () => {
    const { store, repository } = setupStore();
    store.current = runningTranslationTask('persisted-log');
    store.recordAiEvent({
      type: 'vision-review-page', at: 100, page: 7, totalPages: 24, issueCount: 0,
    });
    await store.flushAiLogPersistence();

    sequence += 1;
    const reloadedStore = createTaskStore(
      { repository },
      `task-reloaded-${sequence}`,
    )();
    await reloadedStore.restoreAiLog('persisted-log');

    expect(reloadedStore.aiLog).toEqual([expect.objectContaining({
      at: 100, page: 7, totalPages: 24,
      message: 'Vision Exp 成品质检：第 7/24 页已完成，发现 0 个可见问题',
    })]);
    expect(reloadedStore.lastResponseAt).toBe(100);
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

  it('serializes live visual-attempt persistence before safe stop and preserves its budget', async () => {
    const { store, repository } = setupStore();
    store.current = runningTranslationTask('vision-live');
    store.recordAiEvent({
      type: 'vision-layout-page-started', at: 10, page: 2, totalPages: 4,
    });
    store.recordAiEvent({
      type: 'vision-correction-started', at: 11, page: 2, totalPages: 4,
      round: 1, correctionCallsUsed: 1, maxCorrectionCalls: 4,
      errorCode: 'source-plan.caption-overlap',
    });
    store.recordAiEvent({
      type: 'vision-correction-completed', at: 12, page: 2, totalPages: 4,
      round: 1, correctionCallsUsed: 1, maxCorrectionCalls: 4,
      promptTokens: 120, completionTokens: 30,
    });

    await store.safeStop(13);

    const persisted = await repository.loadTask('vision-live');
    expect(persisted).toMatchObject({
      status: 'stopped',
      visionAttempt: {
        phase: 'correction-full-page', pageIndex: 1, totalPages: 4,
        correctionRound: 1, correctionCallsUsed: 1, maxCorrectionCalls: 4,
        promptTokens: 120, completionTokens: 30,
        errorCode: 'source-plan.caption-overlap',
      },
    });
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

  it('resumes a failed task from its validated cache without resetting progress', async () => {
    const repository = createProjectRepository('task-store-resume-failed');
    setActivePinia(createPinia());
    const useStore = createTaskStore({ repository }, 'resume-failed-task');
    const store = useStore();
    const task = reduceTaskEvent(runningTranslationTask(), {
      type: 'BLOCKS_VALIDATED', count: 7, at: 3_000,
    });
    store.current = {
      ...task, status: 'failed', error: 'one block failed', updatedAt: 4_000,
    };
    const seen: number[] = [];

    await store.resume(async () => { seen.push(store.current?.progress.completed ?? -1); }, 5_000);

    expect(seen).toEqual([7]);
    expect(store.current).toMatchObject({
      status: 'running', error: undefined,
      progress: { completed: 7, total: 20 },
    });
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
