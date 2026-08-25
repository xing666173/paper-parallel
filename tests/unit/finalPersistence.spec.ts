import { describe, expect, it, vi } from 'vitest';
import { persistValidatedOutputs } from '../../src/core/quality/finalPersistence';

describe('validated output persistence', () => {
  it('does not persist any final artifact when a quality gate fails', async () => {
    const putArtifact = vi.fn();
    const saveAlignmentManifest = vi.fn();
    await expect(persistValidatedOutputs({
      contentGate: {
        pass: false, coverage: 0, chineseCharacters: 0,
        issues: [{ code: 'translation-coverage-low', message: '译文覆盖不足' }],
      },
      alignmentPass: true,
      alignmentError: '',
      artifacts: [{ key: 'pdf' }],
      manifest: { projectId: 'p1' },
      putArtifact,
      saveAlignmentManifest,
    })).rejects.toThrow('译文覆盖不足');
    expect(putArtifact).not.toHaveBeenCalled();
    expect(saveAlignmentManifest).not.toHaveBeenCalled();
  });

  it('persists artifacts and alignment only after both deterministic gates pass', async () => {
    const order: string[] = [];
    await persistValidatedOutputs({
      contentGate: { pass: true, coverage: 1, chineseCharacters: 20, issues: [] },
      alignmentPass: true,
      alignmentError: '',
      artifacts: [{ key: 'pdf' }, { key: 'source' }],
      manifest: { projectId: 'p1' },
      putArtifact: async (artifact) => { order.push(String(artifact.key)); },
      saveAlignmentManifest: async () => { order.push('manifest'); },
    });
    expect(order).toEqual(['pdf', 'source', 'manifest']);
  });
});
