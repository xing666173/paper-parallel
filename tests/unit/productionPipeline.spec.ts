import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  runProductionPipeline,
  type ProductionPipelineStages,
} from '../../src/core/pipeline/productionPipeline';
import { createProjectRepository } from '../../src/core/project/repository';
import { createTaskSnapshot } from '../../src/core/task/stateMachine';
import { RecoverablePipelineError } from '../../src/core/task/recoverable';
import { MarkerInvariantError } from '../../src/core/pipeline/markerInvariants';

describe('recoverable production pipeline orchestration', () => {
  it('persists every real stage and completes only after all quality gates pass', async () => {
    const repository = createProjectRepository('production-pipeline-test');
    const visited: string[] = [];
    const stages = stageDoubles(visited);
    const snapshots: string[] = [];
    const result = await runProductionPipeline({
      snapshot: { ...createTaskSnapshot('p1', 1), settings: settings() },
      repository,
      signal: new AbortController().signal,
      stages,
      onSnapshot: (snapshot) => snapshots.push(`${snapshot.stage}:${snapshot.status}`),
    });

    expect(visited).toEqual(['parse', 'analyzeLayout', 'buildGlossary', 'translate', 'compose', 'compile', 'align', 'validate']);
    expect(snapshots).toEqual([
      'parsing:running', 'analyzing-layout:running', 'building-glossary:running',
      'translating:running', 'composing:running', 'compiling:running',
      'aligning:running', 'validating:running', 'completed:completed',
    ]);
    expect(result.snapshot).toMatchObject({ stage: 'completed', status: 'completed' });
    expect(result.completion).toMatchObject({ requiredBlocks: 2, validatedBlocks: 2, pdfCompiled: true, alignmentBuilt: true });
    expect(await repository.loadTask('p1')).toEqual(result.snapshot);
  });

  it('stops before starting another stage when aborted and never marks completion', async () => {
    const repository = createProjectRepository('production-pipeline-abort-test');
    const controller = new AbortController();
    const visited: string[] = [];
    const stages = stageDoubles(visited);
    stages.translate = vi.fn(async (value) => { controller.abort(); return { ...value, validatedBlocks: 2 }; });

    await expect(runProductionPipeline({
      snapshot: { ...createTaskSnapshot('p2', 1), settings: settings() },
      repository, signal: controller.signal, stages,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(visited).toEqual(['parse', 'analyzeLayout', 'buildGlossary']);
    expect((await repository.loadTask('p2'))?.stage).toBe('translating');
    expect((await repository.loadTask('p2'))?.status).toBe('running');
  });

  it('rejects a quality result with unmatched required alignment', async () => {
    const repository = createProjectRepository('production-pipeline-quality-test');
    const stages = stageDoubles([]);
    stages.validate = vi.fn(async () => ({
      requiredBlocks: 2, validatedBlocks: 2, failedBlocks: 0,
      protectedContentPass: true, pdfCompiled: true, assetsPass: true,
      alignmentBuilt: false, persisted: true,
    }));
    await expect(runProductionPipeline({
      snapshot: { ...createTaskSnapshot('p3', 1), settings: settings() },
      repository, signal: new AbortController().signal, stages,
    })).rejects.toThrow('质量门未通过');
    expect((await repository.loadTask('p3'))).toMatchObject({ stage: 'validating', status: 'failed' });
  });

  it('publishes a failed snapshot before a slow failure-state write completes', async () => {
    const base = createProjectRepository('production-pipeline-slow-failure-save-test');
    let releaseFailureSave: (() => void) | undefined;
    const repository = {
      ...base,
      saveTask: vi.fn((snapshot) => snapshot.status === 'failed'
        ? new Promise<void>((resolve) => { releaseFailureSave = resolve; })
        : base.saveTask(snapshot)),
    };
    const stages = stageDoubles([]);
    stages.validate = vi.fn(async () => { throw new Error('visual gate failed'); });
    const snapshots: string[] = [];
    const run = runProductionPipeline({
      snapshot: { ...createTaskSnapshot('slow-failure', 1), settings: settings() },
      repository,
      signal: new AbortController().signal,
      stages,
      onSnapshot: (snapshot) => snapshots.push(`${snapshot.status}:${snapshot.error ?? ''}`),
    });

    await vi.waitFor(() => expect(snapshots.at(-1)).toBe('failed:visual gate failed'));
    releaseFailureSave?.();
    await expect(run).rejects.toThrow('visual gate failed');
  });

  it('keeps live validated, retry, and failed counts when translation later fails', async () => {
    const repository = createProjectRepository('production-pipeline-progress-failure-test');
    const stages = stageDoubles([]);
    stages.buildGlossary = vi.fn(async (value) => ({ ...value, requiredBlocks: 3 }));
    stages.translate = vi.fn(async (
      _value: Record<string, unknown>,
      _signal: AbortSignal,
      report?: (event: { type: 'validated' | 'retry' | 'failed'; count: number }) => void,
    ) => {
      report?.({ type: 'validated', count: 2 });
      report?.({ type: 'retry', count: 1 });
      report?.({ type: 'failed', count: 1 });
      throw new Error('one block failed');
    });

    await expect(runProductionPipeline({
      snapshot: { ...createTaskSnapshot('p4', 1), settings: settings() },
      repository, signal: new AbortController().signal, stages,
    })).rejects.toThrow('one block failed');

    expect(await repository.loadTask('p4')).toMatchObject({
      stage: 'translating', status: 'failed',
      progress: { completed: 2, total: 3, retries: 1, failed: 1 },
    });
  });

  it('does not erase prior translation progress when a resumed cache read fails', async () => {
    const repository = createProjectRepository('production-pipeline-resume-progress-test');
    const stages = stageDoubles([]);
    stages.buildGlossary = vi.fn(async (value) => ({ ...value, requiredBlocks: 3 }));
    stages.translate = vi.fn(async () => { throw new Error('cache read failed'); });
    const snapshot = {
      ...createTaskSnapshot('p5', 1),
      stage: 'translating' as const,
      status: 'failed' as const,
      progress: { completed: 2, total: 3, retries: 1, failed: 1 },
      settings: settings(),
    };

    await expect(runProductionPipeline({
      snapshot, repository, signal: new AbortController().signal, stages,
    })).rejects.toThrow('cache read failed');

    expect(await repository.loadTask('p5')).toMatchObject({
      stage: 'translating', status: 'failed',
      progress: { completed: 2, total: 3, retries: 1, failed: 1 },
    });
  });

  it('redacts API-key-shaped values before persisting a task failure', async () => {
    const repository = createProjectRepository('production-pipeline-secret-error-test');
    const stages = stageDoubles([]);
    stages.translate = vi.fn(async () => {
      throw new Error('proxy echoed sk-super-secret-value');
    });

    await expect(runProductionPipeline({
      snapshot: { ...createTaskSnapshot('p6', 1), settings: settings() },
      repository, signal: new AbortController().signal, stages,
    })).rejects.toThrow('proxy echoed');

    const persisted = await repository.loadTask('p6');
    expect(persisted?.error).toContain('[redacted]');
    expect(persisted?.error).not.toContain('sk-super-secret-value');
  });

  it('persists exhausted remote work as a resumable pause instead of a failed task', async () => {
    const repository = createProjectRepository('production-pipeline-recoverable-pause-test');
    const stages = stageDoubles([]);
    stages.analyzeLayout = vi.fn(async () => {
      throw new RecoverablePipelineError(
        'vision-correction-budget-exhausted',
        'page 2 needs another user-authorized analysis',
        {
          phase: 'correction-local-crop', pageIndex: 1, totalPages: 8,
          correctionRound: 2, remainingPageRounds: 0, validatedPages: 7,
          failedPages: [1], cachedPages: 6, correctionCallsUsed: 2,
          maxCorrectionCalls: 2, promptTokens: 100, completionTokens: 20,
          errorCode: 'source-plan.correction-rounds-exhausted',
        },
      );
    });

    await expect(runProductionPipeline({
      snapshot: { ...createTaskSnapshot('pause', 1), settings: settings() },
      repository, signal: new AbortController().signal, stages,
    })).rejects.toMatchObject({ name: 'RecoverablePipelineError' });
    expect(await repository.loadTask('pause')).toMatchObject({
      stage: 'analyzing-layout', status: 'paused',
      pauseReason: 'vision-correction-budget-exhausted',
      settings: { maxVisionCorrectionCalls: 2 },
      visionAttempt: { failedPages: [1], correctionCallsUsed: 2, maxCorrectionCalls: 2 },
    });
  });

  it('does not carry a stale pause reason into a resumed successful run', async () => {
    const repository = createProjectRepository('production-pipeline-resume-clears-pause-test');
    const stages = stageDoubles([]);
    const result = await runProductionPipeline({
      snapshot: {
        ...createTaskSnapshot('resume-clears-pause', 1),
        status: 'paused',
        pauseReason: 'network-retries-exhausted',
        error: 'old transient error',
        settings: settings(),
      },
      repository,
      signal: new AbortController().signal,
      stages,
    });

    expect(result.snapshot).toMatchObject({ status: 'completed', stage: 'completed' });
    expect(result.snapshot.pauseReason).toBeUndefined();
    expect((await repository.loadTask('resume-clears-pause'))?.pauseReason).toBeUndefined();
  });

  it('persists structured local invariant diagnostics without routing them to Vision', async () => {
    const repository = createProjectRepository('production-pipeline-structure-diagnostic-test');
    const stages = stageDoubles([]);
    stages.compose = vi.fn(async () => {
      throw new MarkerInvariantError([{
        stage: 'pre-typst', code: 'local-structural.duplicate-target-marker',
        entityId: 'duplicate', firstSource: 'required', conflictSource: 'required',
        message: 'duplicate marker', fingerprint: 'pre-typst|duplicate',
      }]);
    });
    await expect(runProductionPipeline({
      snapshot: { ...createTaskSnapshot('structure', 1), settings: settings() },
      repository, signal: new AbortController().signal, stages,
    })).rejects.toMatchObject({ name: 'MarkerInvariantError' });
    const artifact = await repository.findArtifact('structure:structure-diagnostic');
    expect(artifact?.kind).toBe('structure-diagnostic');
    expect(await artifact?.blob.text()).toContain('local-structural.duplicate-target-marker');
  });

  it('releases per-run resources after both success and failure', async () => {
    const successRepository = createProjectRepository('production-pipeline-dispose-success-test');
    const successStages = stageDoubles([]);
    successStages.dispose = vi.fn(async () => undefined);
    await runProductionPipeline({
      snapshot: { ...createTaskSnapshot('dispose-success', 1), settings: settings() },
      repository: successRepository, signal: new AbortController().signal, stages: successStages,
    });
    expect(successStages.dispose).toHaveBeenCalledOnce();

    const failureRepository = createProjectRepository('production-pipeline-dispose-failure-test');
    const failureStages = stageDoubles([]);
    failureStages.translate = vi.fn(async () => { throw new Error('translation failed'); });
    failureStages.dispose = vi.fn(async () => undefined);
    await expect(runProductionPipeline({
      snapshot: { ...createTaskSnapshot('dispose-failure', 1), settings: settings() },
      repository: failureRepository, signal: new AbortController().signal, stages: failureStages,
    })).rejects.toThrow('translation failed');
    expect(failureStages.dispose).toHaveBeenCalledOnce();
  });
});

function settings() {
  return { modelId: 'deepseek-v4-flash', thinkingMode: 'disabled' as const, sourceFileName: 'paper.pdf', sourceFileHash: 'hash' };
}

function stageDoubles(visited: string[]): ProductionPipelineStages {
  const step = (name: string, extra = {}) => vi.fn(async (value: Record<string, unknown> = {}) => {
    visited.push(name); return { ...value, ...extra };
  });
  return {
    parse: step('parse', { requiredBlocks: 2 }),
    analyzeLayout: step('analyzeLayout'),
    buildGlossary: step('buildGlossary'),
    translate: step('translate', { validatedBlocks: 2 }),
    compose: step('compose'), compile: step('compile'), align: step('align'),
    validate: vi.fn(async () => {
      visited.push('validate');
      return {
        requiredBlocks: 2, validatedBlocks: 2, failedBlocks: 0,
        protectedContentPass: true, pdfCompiled: true, assetsPass: true,
        alignmentBuilt: true, persisted: true,
      };
    }),
  };
}
