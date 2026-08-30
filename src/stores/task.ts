import { markRaw, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { createProjectRepository, type ProjectRepository } from '../core/project/repository';
import type { ThroughputSample } from '../core/task/metrics';
import type { CompletionSummary } from '../core/task/completion';
import { reduceTaskEvent } from '../core/task/stateMachine';
import type { AiLogEvent } from '../core/translate/events';
import type { TaskSnapshot } from '../types/models';
import { safeErrorMessage } from '../core/security/errors';
import type { ProjectAiLogEntry } from '../core/project/db';

export interface TaskStoreDependencies {
  repository: ProjectRepository;
}

export interface AiLogEntry extends ProjectAiLogEntry {}

export type TaskRunner = (signal: AbortSignal) => Promise<void>;

function projectAiMessage(event: AiLogEvent): string {
  switch (event.type) {
    case 'vision-layout-page-started':
      return `Vision Exp 版式识别：开始分析第 ${event.page}/${event.totalPages} 页`;
    case 'vision-layout-page-phase':
      return event.phase === 'render-retrying'
        ? `Vision Exp 版式识别：第 ${event.page}/${event.totalPages} 页首次渲染超时，已释放资源并降低分辨率重试`
        : event.phase === 'analysis-retrying'
          ? `Vision Exp 版式识别：第 ${event.page}/${event.totalPages} 页响应无效，正在自动重试`
          : `Vision Exp 版式识别：第 ${event.page}/${event.totalPages} 页连续响应无效，已降级到 PDF 文字层与本地几何识别`;
    case 'vision-layout-page':
      return `Vision Exp 版式识别：第 ${event.page}/${event.totalPages} 页${event.cached ? '（缓存命中）' : '已完成'}`;
    case 'vision-layout-fallback':
      return `Vision Exp 第 ${event.page} 页区域 ${event.region} 未通过本地几何门（${event.reason}），已改用 PDF 文字层回退识别`;
    case 'vision-review-page-started':
      return `Vision Exp 成品质检：开始检查第 ${event.page}/${event.totalPages} 页`;
    case 'vision-review-page-phase': {
      const phase = event.phase === 'render-retrying'
        ? '首次渲染超时，正在释放资源并以低分辨率重试'
        : event.phase === 'rendered'
        ? '已渲染，正在连接 API'
        : event.phase === 'connected'
          ? 'API 已连接，等待模型输出'
          : event.phase === 'content'
            ? '正在接收模型输出'
            : event.phase === 'retrying'
              ? '首次请求异常，正在自动重试'
              : '模型输出已返回，正在校验';
      return `Vision Exp 成品质检：第 ${event.page}/${event.totalPages} 页${phase}`;
    }
    case 'vision-review-page-invalid':
      return `Vision Exp 成品质检：第 ${event.page}/${event.totalPages} 页响应校验失败：${event.reason}`;
    case 'vision-review-page-waiting':
      return `Vision Exp 成品质检：第 ${event.page}/${event.totalPages} 页仍在等待（${Math.floor(event.elapsedMs / 1_000)} 秒）`;
    case 'vision-review-page-timeout':
      return `Vision Exp 成品质检：第 ${event.page}/${event.totalPages} 页超过 ${Math.ceil(event.timeoutMs / 1_000)} 秒，已跳过该页并继续`;
    case 'vision-review-page':
      return `Vision Exp 成品质检：第 ${event.page}/${event.totalPages} 页已完成，发现 ${event.issueCount} 个可见问题`;
    case 'vision-review-completed':
      return `Vision Exp 成品质检：已返回 ${event.reviewedPages} 页，共发现 ${event.issueCount} 个可见问题`;
    case 'quality-finalizing':
      return event.visualPass
        ? '质量门通过，正在保存中文 PDF 与对齐数据'
        : `视觉质量门未通过（${event.severeIssueCount} 个高置信严重问题），正在结束任务`;
    case 'quality-persisted':
      return '中文 PDF 与对齐数据已保存';
    case 'batch-started':
      return `开始批次 ${event.batchId}，共 ${event.blockIds.length} 个文本块`;
    case 'batch-received':
      return `批次 ${event.batchId} 已返回，用时 ${event.elapsedMs} ms`;
    case 'batch-progress': {
      const phase = event.phase === 'connected'
        ? '已建立连接'
        : event.phase === 'reasoning'
          ? '模型思考中'
          : `生成译文中（已接收 ${event.receivedContentChars} 个字符）`;
      return `批次 ${event.batchId} 正在流式接收：${phase}`;
    }
    case 'batch-validated':
      return `批次 ${event.batchId} 校验通过`;
    case 'cache-hit':
      return `缓存命中：${event.blockId}`;
    case 'cache-written':
      return `已保存：${event.blockId}`;
    case 'batch-split':
      return `批次 ${event.batchId} 响应异常，已拆分为 ${event.childBatchIds.join('、')}：${safeErrorMessage(event.reason, 180)}`;
    case 'retry':
      return `批次 ${event.batchId} 正在进行第 ${event.attempt} 次重试：${safeErrorMessage(event.reason, 180)}`;
    case 'error':
      return `批次 ${event.batchId}（${event.blockIds.join('、')}）失败`;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createTaskStore(dependencies: TaskStoreDependencies, id = 'task') {
  return defineStore(id, () => {
    const current = ref<TaskSnapshot | null>(null);
    const aiLog = ref<AiLogEntry[]>([]);
    const abortController = shallowRef<AbortController | null>(null);
    const throughputSamples = ref<ThroughputSample[]>([]);
    const lastResponseAt = ref<number | null>(null);
    const completionSummary = ref<CompletionSummary | null>(null);
    let runningPromise: Promise<void> | null = null;
    let activeRunToken: symbol | null = null;
    let aiLogProjectId: string | null = null;
    let aiLogPersistence = Promise.resolve();

    function queueAiLogPersistence(): void {
      const projectId = current.value?.projectId;
      if (!projectId) return;
      aiLogProjectId = projectId;
      const entries = aiLog.value.map((entry) => ({ ...entry }));
      aiLogPersistence = aiLogPersistence
        .then(() => dependencies.repository.saveAiLog(projectId, entries))
        .catch(() => undefined);
    }

    async function restoreAiLog(projectId: string): Promise<void> {
      if (aiLogProjectId === projectId && aiLog.value.length > 0) return;
      await aiLogPersistence;
      const entries = await dependencies.repository.loadAiLog(projectId);
      aiLog.value = entries.slice(-200);
      aiLogProjectId = projectId;
      lastResponseAt.value = aiLog.value.at(-1)?.at ?? null;
    }

    async function flushAiLogPersistence(): Promise<void> {
      await aiLogPersistence;
    }

    function recordAiEvent(event: AiLogEvent): void {
      const entry: AiLogEntry = {
        at: event.at,
        type: event.type,
        ...('batchId' in event ? { batchId: event.batchId } : {}),
        ...('page' in event ? {
          page: event.page,
          ...('totalPages' in event ? { totalPages: event.totalPages } : {}),
        } : {}),
        ...('reviewedPages' in event ? { reviewedPages: event.reviewedPages } : {}),
        message: projectAiMessage(event),
      };
      if (event.type === 'batch-progress') {
        for (let index = aiLog.value.length - 1; index >= 0; index -= 1) {
          const previous = aiLog.value[index];
          if (previous?.type === 'batch-progress' && previous.batchId === event.batchId) {
            aiLog.value.splice(index, 1);
            break;
          }
        }
      }
      aiLog.value.push(entry);
      if (aiLog.value.length > 200) aiLog.value.splice(0, aiLog.value.length - 200);
      queueAiLogPersistence();
      if (
        event.type === 'batch-received'
        || event.type === 'batch-progress'
        || event.type === 'batch-split'
        || event.type === 'vision-layout-page-started'
        || event.type === 'vision-layout-page-phase'
        || event.type === 'vision-layout-page'
        || event.type === 'vision-layout-fallback'
        || event.type === 'vision-review-page-started'
        || event.type === 'vision-review-page-phase'
        || event.type === 'vision-review-page-invalid'
        || event.type === 'vision-review-page-waiting'
        || event.type === 'vision-review-page-timeout'
        || event.type === 'vision-review-page'
        || event.type === 'vision-review-completed'
        || event.type === 'quality-finalizing'
        || event.type === 'quality-persisted'
      ) {
        lastResponseAt.value = event.at;
        if (event.type === 'batch-received' && event.completionTokens > 0 && event.elapsedMs > 0) {
          throughputSamples.value.push({ tokens: event.completionTokens, elapsedMs: event.elapsedMs });
          if (throughputSamples.value.length > 8) throughputSamples.value.splice(0, throughputSamples.value.length - 8);
        }
      }
    }

    function launch(runner: TaskRunner): Promise<void> {
      const controller = markRaw(new AbortController());
      const runToken = Symbol('task-run');
      abortController.value = controller;
      activeRunToken = runToken;
      const promise = (async () => {
        try {
          await runner(controller.signal);
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) return;
          if (current.value) {
            current.value = reduceTaskEvent(current.value, {
              type: 'FAILED', error: error instanceof Error ? error.message : String(error), at: Date.now(),
            });
            await dependencies.repository.saveTask(current.value);
          }
          throw error;
        } finally {
          if (abortController.value === controller) abortController.value = null;
          if (activeRunToken === runToken) {
            activeRunToken = null;
            runningPromise = null;
          }
        }
      })();
      runningPromise = promise;
      return promise;
    }

    function start(snapshot: TaskSnapshot, runner: TaskRunner): Promise<void> {
      if (aiLogProjectId !== snapshot.projectId) {
        aiLog.value = [];
        aiLogProjectId = snapshot.projectId;
      }
      current.value = snapshot;
      return launch(runner);
    }

    async function safeStop(at = Date.now()): Promise<void> {
      if (!current.value || current.value.status !== 'running') return;
      current.value = reduceTaskEvent(current.value, { type: 'STOP_REQUESTED', at });
      await dependencies.repository.saveTask(current.value);
      abortController.value?.abort();
      await runningPromise;
      if (current.value.status !== 'stopping') return;
      current.value = reduceTaskEvent(current.value, { type: 'STOPPED', at: Date.now() });
      await dependencies.repository.saveTask(current.value);
    }

    async function resume(runner: TaskRunner, at = Date.now()): Promise<void> {
      if (!current.value) throw new Error('No task is available to resume');
      current.value = reduceTaskEvent(current.value, { type: 'RESUME', at });
      await dependencies.repository.saveTask(current.value);
      await launch(runner);
    }

    async function recoverInterruptedStop(at = Date.now()): Promise<void> {
      if (
        !current.value
        || current.value.status !== 'stopping'
        || abortController.value
        || runningPromise
      ) return;
      current.value = reduceTaskEvent(current.value, { type: 'STOPPED', at });
      await dependencies.repository.saveTask(current.value);
    }

    async function clearTranslationCache(): Promise<void> {
      if (!current.value) return;
      await dependencies.repository.clearProjectTranslation(current.value.projectId);
    }

    return {
      current,
      aiLog,
      abortController,
      throughputSamples,
      lastResponseAt,
      completionSummary,
      start,
      safeStop,
      resume,
      recoverInterruptedStop,
      clearTranslationCache,
      recordAiEvent,
      restoreAiLog,
      flushAiLogPersistence,
    };
  });
}

export const useTaskStore = createTaskStore({ repository: createProjectRepository() });
