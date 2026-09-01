import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildProjectPackage } from '../../src/core/project/package';
import { createProjectRepository } from '../../src/core/project/repository';
import { createTaskSnapshot } from '../../src/core/task/stateMachine';

describe('secret-free recoverable project package', () => {
  it('includes recoverable artifacts and excludes secrets and log internals', async () => {
    const repository = createProjectRepository('project-package-test');
    await repository.saveTask({
      ...createTaskSnapshot('p1', 1),
      settings: {
        sourceFileName: 'source-paper.pdf', sourceFileHash: 'task-sha256',
        modelId: 'deepseek-v4-flash', thinkingMode: 'disabled',
        targetLayoutPolicy: 'single-column', layoutProfileVersion: 'zh-single-column-v1',
      },
    });
    for (const [kind, content, type] of [
      ['english-pdf', '%PDF-en', 'application/pdf'],
      ['chinese-pdf', '%PDF-zh', 'application/pdf'],
      ['typst-source', '#set page(width: 10cm)', 'text/plain'],
      ['quality-report', '{"schemaVersion":1,"pass":true}', 'application/json'],
    ] as const) {
      await repository.putArtifact({
        key: `p1:${kind}`, projectId: 'p1', kind,
        blob: new Blob([content], { type }), updatedAt: 1,
      });
    }
    await repository.putTranslation({
      key: 'p1:b1', projectId: 'p1', blockId: 'b1', translation: '翻译。',
      alignmentGroups: [{ sourceSentenceIds: ['b1-s-1'], targetSegments: ['翻译。'] }], validatedAt: 1,
    });
    await repository.saveAlignmentManifest({
      schemaVersion: 1, projectId: 'p1', createdAt: 1, units: [],
      stats: { total: 0, aligned: 0, lowConfidence: 0, unmatched: 0, coverage: 1 },
    });

    const blob = await buildProjectPackage('p1', repository, {
      project: { name: 'Paper', sourceFileHash: 'abc', modelId: 'deepseek-v4-flash', thinkingMode: 'disabled', pageCounts: { en: 8, zh: 11 } },
      glossary: [{ source: 'trace', target: '执行轨迹' }],
      sourceUnits: [{ id: 'b1-s-1', text: 'Trace.' }],
      targetUnits: [{ id: 'b1-g-1-t-1', text: '执行轨迹。' }],
      assets: { assets: [] }, audit: { issues: [] },
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual([
      'alignment.json', 'assets.json', 'audit.json', 'chinese.pdf', 'english.pdf',
      'glossary.json', 'project.json', 'quality-report.json', 'source-units.json', 'target-units.json',
      'translation.json', 'translation.typ',
    ].sort());
    const texts = await Promise.all(Object.values(zip.files)
      .filter((file) => !file.dir && !file.name.endsWith('.pdf'))
      .map((file) => file.async('string')));
    expect(texts.join('\n')).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(texts.join('\n')).not.toContain('Authorization');
    expect(texts.join('\n')).not.toContain('reasoning_content');
    expect(JSON.parse(await zip.file('project.json')!.async('string'))).toMatchObject({
      schemaVersion: 2, modelId: 'deepseek-v4-flash', pageCounts: { en: 8, zh: 11 },
      targetLayoutPolicy: 'single-column', layoutProfileVersion: 'zh-single-column-v1',
    });
    expect(await zip.file('quality-report.json')!.async('string')).toContain('"pass":true');

    const defaultBlob = await buildProjectPackage('p1', repository);
    const defaultZip = await JSZip.loadAsync(await defaultBlob.arrayBuffer());
    expect(JSON.parse(await defaultZip.file('project.json')!.async('string'))).toMatchObject({
      name: 'source-paper.pdf', sourceFileHash: 'task-sha256',
      modelId: 'deepseek-v4-flash', thinkingMode: 'disabled',
      targetLayoutPolicy: 'single-column', layoutProfileVersion: 'zh-single-column-v1',
    });
  });

  it('rejects sensitive fields or key-looking values before generating the ZIP', async () => {
    const repository = createProjectRepository('project-package-secret-test');
    await repository.putArtifact({ key: 'p2:english-pdf', projectId: 'p2', kind: 'english-pdf', blob: new Blob(['%PDF']), updatedAt: 1 });
    await repository.putArtifact({ key: 'p2:chinese-pdf', projectId: 'p2', kind: 'chinese-pdf', blob: new Blob(['%PDF']), updatedAt: 1 });
    await expect(buildProjectPackage('p2', repository, {
      audit: { authorization: 'sk-sensitive-value' },
    })).rejects.toThrow('项目包包含敏感字段');
  });
});
