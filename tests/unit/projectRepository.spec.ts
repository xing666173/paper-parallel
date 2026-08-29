import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
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

  it('persists task settings received through a Vue reactive proxy', async () => {
    const repo = createTestRepository();
    const task = reactive({
      ...createTaskSnapshot('reactive-task', 1000),
      settings: {
        modelId: 'deepseek-v4-flash',
        thinkingMode: 'disabled' as const,
        sourceFileName: 'paper.pdf',
        sourceFileHash: 'abc123',
      },
    });

    await expect(repo.saveTask(task)).resolves.toBeUndefined();
    expect((await repo.loadTask('reactive-task'))?.settings).toEqual({
      modelId: 'deepseek-v4-flash',
      thinkingMode: 'disabled',
      sourceFileName: 'paper.pdf',
      sourceFileHash: 'abc123',
    });
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

  it('persists and restores the AI task log independently for each project', async () => {
    const repo = createTestRepository();
    await repo.saveAiLog('a', [{
      at: 10, type: 'vision-review-page', page: 3, totalPages: 8,
      message: 'Vision Exp 成品质检：第 3/8 页已完成，发现 0 个可见问题',
    }]);

    expect(await repo.loadAiLog('a')).toEqual([expect.objectContaining({
      page: 3, totalPages: 8,
    })]);
    expect(await repo.loadAiLog('b')).toEqual([]);
    await repo.clearAiLog('a');
    expect(await repo.loadAiLog('a')).toEqual([]);
  });

  it('清除当前项目派生数据时保留英文 PDF 并隔离其他项目', async () => {
    const repo = createTestRepository();
    for (const [projectId, kind] of [
      ['a', 'english-pdf'], ['a', 'chinese-pdf'], ['a', 'alignment-manifest'],
      ['b', 'chinese-pdf'],
    ] as const) {
      await repo.putArtifact({
        key: `${projectId}:${kind}`, projectId, kind,
        blob: new Blob([`${projectId}:${kind}`]), updatedAt: 1,
      });
    }
    await repo.putTranslation({
      key: 'a:1', projectId: 'a', blockId: '1', translation: '甲', alignmentGroups: [], validatedAt: 1,
    });

    await repo.clearProjectDerivedData('a');

    expect(await repo.findArtifact('a:english-pdf')).toBeDefined();
    expect(await repo.findArtifact('a:chinese-pdf')).toBeUndefined();
    expect(await repo.findArtifact('a:alignment-manifest')).toBeUndefined();
    expect(await repo.findArtifact('b:chinese-pdf')).toBeDefined();
    expect(await repo.findTranslation('a:1')).toBeUndefined();
  });
});
