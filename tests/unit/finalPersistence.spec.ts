import { describe, expect, it, vi } from 'vitest';
import { persistValidatedOutputs } from '../../src/core/quality/finalPersistence';

describe('validated output persistence', () => {
  it('does not persist any final artifact when a quality gate fails', async () => {
    const commit = vi.fn();
    await expect(persistValidatedOutputs({
      contentGate: {
        pass: false, coverage: 0, chineseCharacters: 0,
        issues: [{ code: 'translation-coverage-low', message: '译文覆盖不足' }],
      },
      alignmentPass: true,
      alignmentError: '',
      visualPass: true,
      visualError: '',
      artifacts: [{ key: 'pdf' }],
      manifest: { projectId: 'p1' },
      commit,
    })).rejects.toThrow('译文覆盖不足');
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not persist when Vision Exp finds a severe final-page defect', async () => {
    const commit = vi.fn();
    await expect(persistValidatedOutputs({
      contentGate: { pass: true, coverage: 1, chineseCharacters: 20, issues: [] },
      alignmentPass: true,
      alignmentError: '',
      visualPass: false,
      visualError: '第 2 页存在大面积正文缺失',
      artifacts: [{ key: 'pdf' }],
      manifest: { projectId: 'p1' },
      commit,
    })).rejects.toThrow('视觉质检未通过');
    expect(commit).not.toHaveBeenCalled();
  });

  it('persists artifacts and alignment only after both deterministic gates pass', async () => {
    const commit = vi.fn(async () => undefined);
    const artifacts = [{ key: 'pdf' }, { key: 'source' }];
    const manifest = { projectId: 'p1' };
    await persistValidatedOutputs({
      contentGate: { pass: true, coverage: 1, chineseCharacters: 20, issues: [] },
      alignmentPass: true,
      alignmentError: '',
      visualPass: true,
      visualError: '',
      artifacts,
      manifest,
      commit,
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(artifacts, manifest);
  });
});
