import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { buildAlignmentManifest } from '../../src/core/align/manifest';
import { runAlignmentGate } from '../../src/core/quality/alignmentGate';
import { createProjectRepository } from '../../src/core/project/repository';
import type { AlignmentRectSet, AlignmentUnit } from '../../src/types/models';

const source: AlignmentRectSet[] = [{ page: 0, rects: [{ x: 1, y: 2, w: 3, h: 4 }] }];
const marker: AlignmentRectSet[] = [{ page: 1, rects: [{ x: 5, y: 6, w: 7, h: 8 }] }];

describe('quality-gated alignment manifest', () => {
  it('prefers complete marker geometry and records fallback confidence', () => {
    const group = unit({
      id: 'p1-g-1', parentId: 'p1', kind: 'semantic-group', relation: 'n:1',
      sourceUnitIds: ['s1', 's2'], targetUnitIds: ['p1-g-1-t-1'], source,
    });
    const asset = unit({
      id: 'asset-1', kind: 'asset', relation: 'asset',
      sourceUnitIds: ['asset-1'], targetUnitIds: ['asset-1'], source,
    });
    const manifest = buildAlignmentManifest({
      projectId: 'p1', units: [group, asset], createdAt: 10,
      markers: new Map([['p1-g-1-t-1', marker]]),
      fallback: new Map([['asset-1', { status: 'aligned', rects: marker, confidence: 0.82 }]]),
    });

    expect(manifest.units[0]).toMatchObject({ id: 'p1-g-1', relation: 'n:1', confidence: 1, status: 'aligned' });
    expect(manifest.units[1]).toMatchObject({ id: 'asset-1', confidence: 0.82, status: 'low-confidence' });
    expect(manifest.stats).toMatchObject({ total: 2, aligned: 1, lowConfidence: 1, unmatched: 0 });
  });

  it('reports every unmatched unit instead of dropping it', () => {
    const manifest = buildAlignmentManifest({
      projectId: 'p1', createdAt: 10,
      units: [unit({ id: 's2', sourceUnitIds: ['s2'], targetUnitIds: ['t2'], source })],
      markers: new Map(), fallback: new Map(),
    });
    const gate = runAlignmentGate(manifest);
    expect(gate.pass).toBe(false);
    expect(gate.issues).toEqual([expect.objectContaining({ code: 'target-geometry-missing', unitId: 's2' })]);
  });

  it('does not mark target-only geometry as aligned', () => {
    const manifest = buildAlignmentManifest({
      projectId: 'p1', createdAt: 10,
      units: [unit({ id: 'right-only', sourceUnitIds: ['s1'], targetUnitIds: ['t1'] })],
      markers: new Map([['t1', marker]]), fallback: new Map(),
    });

    expect(manifest.units[0]).toMatchObject({
      id: 'right-only', source: [], target: marker,
      status: 'unmatched', confidence: 0, fallbackReason: 'source-geometry-missing',
    });
    expect(manifest.stats).toMatchObject({ aligned: 0, unmatched: 1, coverage: 0 });
    expect(runAlignmentGate(manifest).issues).toContainEqual(expect.objectContaining({
      code: 'source-geometry-missing', unitId: 'right-only', severity: 'error',
    }));
  });

  it('collapses unreliable child groups to a verified paragraph fallback', () => {
    const child = unit({
      id: 'p1-g-1', parentId: 'p1', kind: 'semantic-group', relation: '1:1',
      sourceUnitIds: ['s1'], targetUnitIds: ['t1'], source,
    });
    const manifest = buildAlignmentManifest({
      projectId: 'p1', createdAt: 10, units: [child], markers: new Map(), fallback: new Map(),
      paragraphFallback: new Map([['p1', {
        source, target: marker, confidence: 0.98,
        sourceText: 'Source paragraph.', targetText: '中文段落。',
      }]]),
    });

    expect(manifest.units).toContainEqual(expect.objectContaining({
      id: 'p1', kind: 'block', relation: 'paragraph-fallback', status: 'aligned',
      fallbackReason: 'group-geometry-low-confidence',
    }));
    expect(manifest.units.some((candidate) => candidate.id === 'p1-g-1')).toBe(false);
    expect(runAlignmentGate(manifest)).toMatchObject({ pass: true, verified: false });
  });

  it('persists and restores the versioned manifest artifact', async () => {
    const repo = createProjectRepository('alignment-manifest-test');
    const manifest = buildAlignmentManifest({
      projectId: 'persisted', createdAt: 10, units: [], markers: new Map(), fallback: new Map(),
    });
    await repo.saveAlignmentManifest(manifest);
    expect(await repo.loadAlignmentManifest('persisted')).toEqual(manifest);
  });
});

function unit(overrides: Partial<AlignmentUnit>): AlignmentUnit {
  return {
    id: 'u1', kind: 'block', relation: 'block',
    sourceUnitIds: [], targetUnitIds: [], source: [], target: [],
    confidence: 0, status: 'unmatched', ...overrides,
  };
}
