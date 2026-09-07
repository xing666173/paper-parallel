import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProductionPipeline, type ProductionPipelineStages, type TranslationProgressUpdate } from '../../src/core/pipeline/productionPipeline';
import { createProjectRepository } from '../../src/core/project/repository';
import { createTaskSnapshot } from '../../src/core/task/stateMachine';

const pass = async (value: Record<string, unknown>) => value;
function stages(): ProductionPipelineStages {
  return {
    parse: async () => ({ requiredBlocks: 1 }), analyzeLayout: pass, buildGlossary: pass,
    translate: async (value) => ({ ...value, validatedBlocks: 1 }), compose: pass, compile: pass, align: pass,
    validate: async () => ({
      requiredBlocks: 1, validatedBlocks: 1, failedBlocks: 0, protectedContentPass: true,
      pdfCompiled: true, assetsPass: true, alignmentBuilt: true, persisted: true,
    }),
  };
}
let sequence = 0;
afterEach(() => vi.useRealTimers());

describe('pipeline cancellation and durable failure diagnostics', () => {
  it.each(['parse', 'analyzeLayout', 'buildGlossary', 'translate', 'compose', 'compile', 'align', 'validate'] as const)(
    'exits an unresponsive %s stage and unresponsive cleanup after cancellation', async (phase) => {
      const repository = createProjectRepository(`pipeline-cancel-${++sequence}`);
      const controller = new AbortController();
      const operations = stages();
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      operations[phase] = async () => { entered(); return await new Promise<never>(() => {}); };
      operations.dispose = vi.fn(async () => new Promise<void>(() => {}));
      const pipeline = runProductionPipeline({ snapshot: createTaskSnapshot('p1'), repository, signal: controller.signal, stages: operations });
      await ready;
      controller.abort();
      await expect(pipeline).rejects.toMatchObject({ name: 'AbortError' });
      expect(operations.dispose).toHaveBeenCalledOnce();
      expect(await repository.findArtifact('p1:structure-diagnostic')).toBeUndefined();
      expect((await repository.loadTask('p1'))?.status).not.toBe('completed');
    },
  );

  it('does not publish or persist translation progress after cancellation', async () => {
    const repository = createProjectRepository(`pipeline-late-progress-${++sequence}`);
    const save = vi.spyOn(repository, 'saveTask');
    const controller = new AbortController();
    const operations = stages();
    let report!: (event: TranslationProgressUpdate) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    operations.translate = async (_value, _signal, progress) => {
      report = progress!;
      entered();
      return await new Promise(() => {});
    };
    const snapshots = vi.fn();
    const pipeline = runProductionPipeline({ snapshot: createTaskSnapshot('p1'), repository, signal: controller.signal, stages: operations, onSnapshot: snapshots });
    await ready;
    controller.abort();
    await expect(pipeline).rejects.toMatchObject({ name: 'AbortError' });
    const snapshotCount = snapshots.mock.calls.length;
    const saveCount = save.mock.calls.length;
    report({ type: 'validated', count: 1 });
    await Promise.resolve();
    expect(snapshots).toHaveBeenCalledTimes(snapshotCount);
    expect(save).toHaveBeenCalledTimes(saveCount);
  });

  it.each(['parse', 'analyzeLayout'] as const)('saves safe generic %s diagnostics with the failing stage', async (phase) => {
    const repository = createProjectRepository(`pipeline-generic-diagnostic-${++sequence}`);
    const operations = stages();
    operations[phase] = async () => { throw new TypeError('page rendering failed sk-private-token'); };
    await expect(runProductionPipeline({
      snapshot: createTaskSnapshot('p1'), repository, signal: new AbortController().signal, stages: operations,
    })).rejects.toMatchObject({ name: 'TypeError' });
    const artifact = await repository.findArtifact('p1:structure-diagnostic');
    const diagnostic = JSON.parse(await artifact!.blob.text());
    expect(diagnostic).toMatchObject({
      schemaVersion: 1, projectId: 'p1', stage: phase === 'parse' ? 'parsing' : 'analyzing-layout', errorName: 'TypeError', issues: [],
    });
    expect(diagnostic.createdAt).toEqual(expect.any(Number));
    expect(diagnostic.message).toContain('page rendering failed');
    expect(diagnostic.message).not.toContain('sk-private-token');
  });

  it('preserves the original failure if writing diagnostics or the failed state also fails', async () => {
    const repository = createProjectRepository(`pipeline-diagnostic-storage-${++sequence}`);
    const save = repository.saveTask.bind(repository);
    vi.spyOn(repository, 'putArtifact').mockRejectedValue(new Error('diagnostic storage unavailable'));
    vi.spyOn(repository, 'saveTask').mockImplementation(async (snapshot) => {
      if (snapshot.status === 'failed') throw new Error('state storage unavailable');
      return save(snapshot);
    });
    const operations = stages();
    const failure = new Error('original parse failure');
    operations.parse = async () => { throw failure; };
    await expect(runProductionPipeline({
      snapshot: createTaskSnapshot('p1'), repository, signal: new AbortController().signal, stages: operations,
    })).rejects.toBe(failure);
  });
});
