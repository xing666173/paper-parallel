import { describe, expect, it } from 'vitest';
import { runCompositionGate } from '../../src/core/quality/compositionGate';

describe('composition quality gate', () => {
  it('fails changed assets and missing markers deterministically', () => {
    const result = runCompositionGate({
      pdfHeader: '%PDF-',
      preview: '<svg></svg>',
      sourceAssetHashes: { 'fig-1': 'aaa', 'eq-1': 'bbb' },
      targetAssetHashes: { 'fig-1': 'ccc', 'eq-1': 'bbb' },
      requiredMarkerIds: ['title', 'fig-1', 'eq-1'],
      emittedMarkerIds: ['title', 'eq-1'],
      layoutRegionOrder: ['front', 'body'],
      emittedRegionOrder: ['front', 'body'],
    });
    expect(result.pass).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'asset-hash-mismatch', 'marker-missing',
    ]);
  });

  it('passes only exact PDF, asset, marker and region coverage', () => {
    expect(runCompositionGate({
      pdfHeader: '%PDF-', preview: '<svg><text>中文</text></svg>',
      sourceAssetHashes: { 'fig-1': 'aaa' }, targetAssetHashes: { 'fig-1': 'aaa' },
      requiredMarkerIds: ['title', 'fig-1'], emittedMarkerIds: ['title', 'fig-1'],
      layoutRegionOrder: ['front', 'body'], emittedRegionOrder: ['front', 'body'],
    })).toEqual({ pass: true, issues: [] });
  });
});
