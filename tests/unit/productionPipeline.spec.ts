import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { runProductionPipeline } from '../../src/core/pipeline/productionPipeline';
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
});

function settings() {
  return { modelId: 'deepseek-v4-flash', thinkingMode: 'disabled' as const, sourceFileName: 'paper.pdf', sourceFileHash: 'hash' };
}

function stageDoubles(visited: string[]) {
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
