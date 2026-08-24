import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createTaskSnapshot } from '../../src/core/task/stateMachine';
import { createProjectRepository } from '../../src/core/project/repository';

let databaseSequence = 0;

function createTestRepository() {
  databaseSequence += 1;
  return createProjectRepository(`paper-parallel-test-${databaseSequence}`);
}

describe('project repository', () => {
  it('round-trips a task snapshot', async () => {
    const repo = createTestRepository();
    const task = createTaskSnapshot('a', 1000);

    await repo.saveTask(task);

    expect(await repo.loadTask('a')).toEqual(task);
    expect(await repo.loadTask('missing')).toBeUndefined();
  });

  it('clears only the selected project translation cache', async () => {
    const repo = createTestRepository();
    await repo.putTranslation({
      key: 'a:1', projectId: 'a', blockId: '1', translation: '甲', alignmentGroups: [], validatedAt: 1,
    });
    await repo.putTranslation({
      key: 'b:1', projectId: 'b', blockId: '1', translation: '乙', alignmentGroups: [], validatedAt: 1,
    });

    await repo.clearProjectTranslation('a');

    expect(await repo.findTranslation('a:1')).toBeUndefined();
    expect((await repo.findTranslation('b:1'))?.translation).toBe('乙');
  });

  it('persists the source PDF independently from translation cache', async () => {
    const repo = createTestRepository();
    const source = new Blob(['%PDF-source'], { type: 'application/pdf' });
    await repo.putArtifact({
      key: 'a:english-pdf', projectId: 'a', kind: 'english-pdf', blob: source, updatedAt: 1,
    });

    await repo.clearProjectTranslation('a');

    const stored = await repo.findArtifact('a:english-pdf');
    expect(stored?.kind).toBe('english-pdf');
    expect(await stored?.blob.text()).toBe('%PDF-source');
    expect(await repo.findArtifact('missing')).toBeUndefined();
  });
});
