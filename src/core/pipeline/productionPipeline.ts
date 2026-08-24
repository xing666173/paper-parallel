import type { ProjectRepository } from '../project/repository';
import { canEnterReader, type CompletionSummary } from '../task/completion';
import type { TaskSnapshot, TaskStage } from '../../types/models';

export type PipelineValue = Record<string, unknown>;

export interface ProductionPipelineStages {
  parse(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  analyzeLayout(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  buildGlossary(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  translate(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  compose(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  compile(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  align(value: PipelineValue, signal: AbortSignal): Promise<PipelineValue>;
  validate(value: PipelineValue, signal: AbortSignal): Promise<CompletionSummary>;
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
  const persist = async (notify = true): Promise<void> => {
    snapshot = { ...snapshot, progress: { ...snapshot.progress } };
    await options.repository.saveTask(snapshot);
    if (notify) options.onSnapshot?.(snapshot);
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

  try {
    let value: PipelineValue = { projectId: snapshot.projectId, settings: snapshot.settings };
    value = await run('parsing', options.stages.parse, value);
    value = await run('analyzing-layout', options.stages.analyzeLayout, value);
    value = await run('building-glossary', options.stages.buildGlossary, value);

    const requiredBlocks = Number(value.requiredBlocks) || 0;
    snapshot = { ...snapshot, progress: { completed: 0, total: requiredBlocks, retries: 0, failed: 0 } };
    value = await run('translating', options.stages.translate, value);
    snapshot = {
      ...snapshot,
      progress: {
        ...snapshot.progress,
        completed: Math.min(requiredBlocks, Number(value.validatedBlocks) || 0),
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
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    };
    await persist();
    throw error;
  }
}
