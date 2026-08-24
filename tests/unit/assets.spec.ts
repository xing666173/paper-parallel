import { describe, expect, it, vi } from 'vitest';
import {
  buildAssetManifest,
  extractImmutableAssets,
  isTranslatableAssetKind,
} from '../../src/core/assets/extract';
import { verifyAssetHash } from '../../src/core/assets/hash';

describe('immutable paper assets', () => {
  it.each(['figure', 'table', 'formula', 'code', 'page-furniture'] as const)(
    'marks %s as immutable and non-translatable',
    (kind) => expect(isTranslatableAssetKind(kind)).toBe(false),
  );

  it('keeps captions outside immutable bytes and records a verifiable hash', async () => {
    const manifest = await buildAssetManifest([{
      id: 'fig-1', kind: 'figure', pageIndex: 0,
      rect: { x: 100, y: 200, w: 300, h: 180 },
      bytes: new Uint8Array([1, 2, 3]), captionUnitId: 'fig-1-caption',
    }]);
    expect(manifest.assets[0]?.captionUnitId).toBe('fig-1-caption');
    expect(manifest.assets[0]).not.toHaveProperty('translatedBytes');
    expect(await verifyAssetHash(manifest.assets[0]!)).toBe(true);
  });

  it('prefers decoded source pixels and losslessly crops composite regions', async () => {
    const crop = vi.fn(async () => new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' }));
    const assets = await extractImmutableAssets([
      {
        id: 'fig-raw', kind: 'figure', pageIndex: 0,
        rect: { x: 1, y: 2, w: 3, h: 4 }, widthMode: 'column',
        rawImage: { bytes: new Uint8Array([1, 2]), mimeType: 'image/png' },
      },
      {
        id: 'eq-crop', kind: 'formula', pageIndex: 0,
        rect: { x: 5, y: 6, w: 7, h: 8 }, widthMode: 'span',
      },
    ], { crop });

    expect(crop).toHaveBeenCalledOnce();
    expect(Array.from(new Uint8Array(await assets[0]!.blob.arrayBuffer()))).toEqual([1, 2]);
    expect(Array.from(new Uint8Array(await assets[1]!.blob.arrayBuffer()))).toEqual([9, 8, 7]);
  });
});
