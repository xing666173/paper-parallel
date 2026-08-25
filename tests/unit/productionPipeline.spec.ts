import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  runProductionPipeline,
  type ProductionPipelineStages,
} from '../../src/core/pipeline/productionPipeline';
import { createProjectRepository } from '../../src/core/project/repository';
import { createTaskSnapshot } from '../../src/core/task/stateMachine';

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
