import { describe, expect, it } from 'vitest';
import { computeInvalidationPlan } from '../../src/core/project/invalidationGraph';
import type { ProjectArtifactRecord, TranslationCacheRecord } from '../../src/core/project/db';

function artifact(
  key: string,
  kind: ProjectArtifactRecord['kind'],
  pageIndices?: number[],
): ProjectArtifactRecord {
  return {
    key, projectId: 'p1', kind, blob: new Blob(), updatedAt: 1,
    dependencies: pageIndices ? { pageIndices } : undefined,
  };
}

const translations: TranslationCacheRecord[] = [
  { key: 'tr:a', projectId: 'p1', blockId: 'a', translation: '甲', alignmentGroups: [], validatedAt: 1 },
  { key: 'tr:b', projectId: 'p1', blockId: 'b', translation: '乙', alignmentGroups: [], validatedAt: 1 },
];

describe('project dependency invalidation graph', () => {
  it('invalidates one changed page plan and every downstream formal output transactionally', () => {
    const result = computeInvalidationPlan({
      projectId: 'p1', facets: ['page-plan'], pageIndices: [1],
    }, [
      artifact('en', 'english-pdf'),
      artifact('raw:1', 'raw-vision-response', [1]),
      artifact('accepted:0', 'accepted-page-plan', [0]),
      artifact('accepted:1', 'accepted-page-plan', [1]),
      artifact('vision-diagnostic', 'vision-diagnostic', [0, 1]),
      artifact('structure-diagnostic', 'structure-diagnostic'),
      artifact('pdf', 'chinese-pdf'),
      artifact('quality', 'quality-report'),
    ], translations);
    expect(result.artifactKeys).toEqual([
      'accepted:1', 'pdf', 'quality', 'structure-diagnostic',
    ]);
    expect(result.translationKeys).toEqual([]);
  });

  it('invalidates caption plans and geometry diagnostics without deleting raw evidence', () => {
    const artifacts = [
      artifact('raw:1', 'raw-vision-response', [1]),
      artifact('accepted:1', 'accepted-page-plan', [1]),
      artifact('vision-diagnostic', 'vision-diagnostic', [0, 1]),
      artifact('formula:1', 'formula-ocr', [1]),
    ];
    expect(computeInvalidationPlan({
      projectId: 'p1', facets: ['caption-link'], pageIndices: [1],
    }, artifacts, translations).artifactKeys).toEqual(['accepted:1']);
    expect(computeInvalidationPlan({
      projectId: 'p1', facets: ['asset-geometry'], pageIndices: [1],
    }, artifacts, translations).artifactKeys).toEqual(['formula:1']);
  });

  it('preserves unchanged translations for layout-only changes and targets semantic changes', () => {
    expect(computeInvalidationPlan({
      projectId: 'p1', facets: ['layout-only'], pageIndices: [0],
    }, [artifact('pdf', 'chinese-pdf')], translations)).toEqual({
      artifactKeys: ['pdf'], translationKeys: [],
    });
    expect(computeInvalidationPlan({
      projectId: 'p1', facets: ['semantic-content'], sourceUnitIds: ['b'],
    }, [], translations).translationKeys).toEqual(['tr:b']);
  });
});
