import type { ProjectRepository } from '../project/repository';
import { canEnterReader, type CompletionSummary } from '../task/completion';
import type { TaskSnapshot, TaskStage } from '../../types/models';
import { safeErrorMessage } from '../security/errors';

export type PipelineValue = Record<string, unknown>;

export interface TranslationProgressUpdate {
  type: 'validated' | 'retry' | 'failed';
  count: number;
}

export interface ProductionPipelineStages {
  parse(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  analyzeLayout(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  buildGlossary(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  translate(
    value: PipelineValue,
    signal: AbortSignal,
    reportProgress?: (event: TranslationProgressUpdate) => void,
  ): Promise<PipelineValue>;
  compose(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  compile(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  align(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  validate(value: PipelineValue, signal: AbortSignal): Promise<CompletionSummary>;
  /** Releases PDF.js documents and other per-run resources on every terminal path. */
  dispose?(value: PipelineValue): Promise<void>;
}

export interface ProductionPipelineOptions {
  snapshot: TaskSnapshot;
  repository: ProjectRepository;
  signal: AbortSignal;
  stages: ProductionPipelineStages;
  onSnapshot?(snapshot: TaskSnapshot): void;
}

export interface ProductionPipelineResult {
  snapshot: TaskSnapshot;
  completion: CompletionSummary;
  value: PipelineValue;
}

function abortError(): DOMException {
  return new DOMException('任务已安全停止', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export async function runProductionPipeline(
  options: ProductionPipelineOptions,
): Promise<ProductionPipelineResult> {
  let snapshot: TaskSnapshot = { ...options.snapshot, progress: { ...options.snapshot.progress }, error: undefined };
  const resumableTranslationProgress = options.snapshot.stage === 'translating'
    ? { ...options.snapshot.progress }
    : undefined;
  const persist = async (notify = true): Promise<void> => {
    snapshot = { ...snapshot, progress: { ...snapshot.progress } };
    if (notify) options.onSnapshot?.(snapshot);
    await options.repository.saveTask(snapshot);
  };
  const enter = async (stage: TaskStage): Promise<void> => {
    throwIfAborted(options.signal);
    snapshot = {
      ...snapshot,
      stage,
      status: 'running',
      startedAt: snapshot.startedAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await persist();
  };
  const run = async (
    stage: TaskStage,
    operation: (value: PipelineValue, signal: AbortSignal) => Promise<PipelineValue>,
    value: PipelineValue,
  ): Promise<PipelineValue> => {
    await enter(stage);
    const next = await operation(value, options.signal);
    throwIfAborted(options.signal);
    return next;
  };
  let value: PipelineValue = { projectId: snapshot.projectId, settings: snapshot.settings };

  try {
    value = await run('parsing', options.stages.parse, value);
    value = await run('analyzing-layout', options.stages.analyzeLayout, value);
    value = await run('building-glossary', options.stages.buildGlossary, value);

    const requiredBlocks = Number(value.requiredBlocks) || 0;
    const baselineProgress = resumableTranslationProgress?.total === requiredBlocks
      ? { ...resumableTranslationProgress, total: requiredBlocks }
      : { completed: 0, total: requiredBlocks, retries: 0, failed: 0 };
    snapshot = { ...snapshot, progress: { ...baselineProgress } };
    await enter('translating');
    let progressPersistence = Promise.resolve();
    let observedCompleted = 0;
    let observedRetries = 0;
    let observedFailed = 0;
    const reportTranslationProgress = (event: TranslationProgressUpdate): void => {
      if (!Number.isInteger(event.count) || event.count < 1) return;
      if (event.type === 'validated') {
        observedCompleted += event.count;
      } else if (event.type === 'retry') {
        observedRetries += event.count;
      } else {
        observedFailed += event.count;
      }
      const completed = Math.min(requiredBlocks, Math.max(baselineProgress.completed, observedCompleted));
      const progress = {
        completed,
        total: requiredBlocks,
        retries: baselineProgress.retries + observedRetries,
        failed: Math.min(
          Math.max(0, requiredBlocks - completed),
          Math.max(baselineProgress.failed, observedFailed),
        ),
      };
      snapshot = { ...snapshot, progress, updatedAt: Date.now() };
      const progressSnapshot = { ...snapshot, progress: { ...snapshot.progress } };
      options.onSnapshot?.(progressSnapshot);
      progressPersistence = progressPersistence.then(() => options.repository.saveTask(progressSnapshot));
    };
    try {
      value = await options.stages.translate(value, options.signal, reportTranslationProgress);
    } finally {
      await progressPersistence;
    }
    snapshot = {
      ...snapshot,
      progress: {
        ...snapshot.progress,
        completed: Math.min(requiredBlocks, Number(value.validatedBlocks) || 0),
        failed: 0,
      },
      updatedAt: Date.now(),
    };
    await persist(false);

    value = await run('composing', options.stages.compose, value);
    value = await run('compiling', options.stages.compile, value);
    value = await run('aligning', options.stages.align, value);
    await enter('validating');
    const completion = await options.stages.validate(value, options.signal);
    throwIfAborted(options.signal);
    if (!canEnterReader(completion)) throw new Error('质量门未通过，不能自动进入阅读器');

    snapshot = { ...snapshot, stage: 'completed', status: 'completed', error: undefined, updatedAt: Date.now() };
    await persist();
    return { snapshot, completion, value };
  } catch (error) {
    if (options.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
    snapshot = {
      ...snapshot,
      status: 'failed',
      error: safeErrorMessage(error, 500),
      updatedAt: Date.now(),
    };
    await persist();
    throw error;
  } finally {
    try {
      await options.stages.dispose?.(value);
    } catch {
      // Cleanup must not replace the actual pipeline result or failure.
    }
  }
}
