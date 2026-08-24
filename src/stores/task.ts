import { markRaw, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { createProjectRepository, type ProjectRepository } from '../core/project/repository';
import type { ThroughputSample } from '../core/task/metrics';
import type { CompletionSummary } from '../core/task/completion';
import { reduceTaskEvent } from '../core/task/stateMachine';
import type { AiLogEvent } from '../core/translate/events';
import type { TaskSnapshot } from '../types/models';

export interface TaskStoreDependencies {
  repository: ProjectRepository;
}

export interface AiLogEntry {
  at: number;
  type: AiLogEvent['type'];
  message: string;
}

export type TaskRunner = (signal: AbortSignal) => Promise<void>;

function projectAiMessage(event: AiLogEvent): string {
  const safeReason = (reason: string) => reason
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 180);
  switch (event.type) {
    case 'batch-started':
      return `开始批次 ${event.batchId}，共 ${event.blockIds.length} 个文本块`;
    case 'batch-received':
      return `批次 ${event.batchId} 已返回，用时 ${event.elapsedMs} ms`;
    case 'batch-validated':
      return `批次 ${event.batchId} 校验通过`;
    case 'cache-hit':
      return `缓存命中：${event.blockId}`;
    case 'cache-written':
      return `已保存：${event.blockId}`;
    case 'batch-split':
      return `批次 ${event.batchId} 响应异常，已拆分为 ${event.childBatchIds.join('、')}：${safeReason(event.reason)}`;
    case 'retry':
      return `批次 ${event.batchId} 正在进行第 ${event.attempt} 次重试：${safeReason(event.reason)}`;
    case 'error':
      return `批次 ${event.batchId} 失败`;
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

    function recordAiEvent(event: AiLogEvent): void {
      aiLog.value.push({ at: event.at, type: event.type, message: projectAiMessage(event) });
      if (aiLog.value.length > 200) aiLog.value.splice(0, aiLog.value.length - 200);
      if (event.type === 'batch-received' || event.type === 'batch-split') {
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
      clearTranslationCache,
      recordAiEvent,
    };
  });
}

export const useTaskStore = createTaskStore({ repository: createProjectRepository() });
