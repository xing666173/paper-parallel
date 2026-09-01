import type { Rect, WidthMode } from '../../types/models';
import { hashBlob } from './hash';
import type {
  AssetManifest, ImmutableAsset, ImmutableAssetKind, ImmutableAssetMimeType,
} from './types';

export interface AssetManifestInput {
  id: string;
  kind: ImmutableAssetKind;
  pageIndex: number;
  rect: Rect;
  bytes: Uint8Array;
  mimeType?: ImmutableAssetMimeType;
  widthMode?: WidthMode;
  captionUnitId?: string;
  crossPageAssetGroupId?: string;
}

export interface DetectedAssetRegion {
  id: string;
  kind: ImmutableAssetKind;
  pageIndex: number;
  rect: Rect;
  widthMode: WidthMode;
  captionUnitId?: string;
  crossPageAssetGroupId?: string;
  /** Source-page glyph boxes to paint white in a conventional rectangular crop. */
  eraseRects?: Rect[];
  /**
   * Source-page areas to composite onto white after reconstructing a split
   * formula. This avoids erasing accents or limits whose ink overlaps a
   * neighbouring text glyph box.
   */
  preserveRects?: Rect[];
  /** Exact source-text ranges represented by a reconstructed glyph crop. */
  sourceCharacterRanges?: Array<{ blockId: string; start: number; end: number }>;
  /** Flattened text hint used only to identify a formula in a noisy source crop. */
  formulaHint?: string;
  /** The reconstructed source glyphs prove that a large operator is required. */
  requiresLargeOperator?: boolean;
  rawImage?: { bytes: Uint8Array; mimeType: ImmutableAssetMimeType };
}

export interface AssetExtractionDependencies {
  crop(region: DetectedAssetRegion): Promise<Blob>;
  /** Limits full-page raster canvases kept alive at the same time. */
  concurrency?: number;
}

export function isTranslatableAssetKind(_kind: ImmutableAssetKind): false {
  return false;
}

async function createAsset(
  input: Omit<AssetManifestInput, 'bytes'> & { blob: Blob },
): Promise<ImmutableAsset> {
  const mimeType = input.mimeType ?? 'image/png';
  return {
    id: input.id,
    kind: input.kind,
    sourcePage: input.pageIndex,
    sourceRect: { ...input.rect },
    mimeType,
    blob: input.blob,
    sha256: await hashBlob(input.blob),
    widthMode: input.widthMode ?? 'column',
    captionUnitId: input.captionUnitId,
    crossPageAssetGroupId: input.crossPageAssetGroupId,
  };
}

export async function buildAssetManifest(
  inputs: readonly AssetManifestInput[],
): Promise<AssetManifest> {
  const assets = await Promise.all(inputs.map((input) => createAsset({
    ...input,
    blob: new Blob([input.bytes], { type: input.mimeType ?? 'image/png' }),
  })));
  return { assets };
}

export async function extractImmutableAssets(
  regions: readonly DetectedAssetRegion[],
  dependencies: AssetExtractionDependencies,
): Promise<ImmutableAsset[]> {
  const concurrency = dependencies.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Asset extraction concurrency must be a positive integer');
  }
  const assets: ImmutableAsset[] = Array.from({ length: regions.length });
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < regions.length) {
      const index = nextIndex;
      nextIndex += 1;
      const region = regions[index]!;
      const blob = region.rawImage
        ? new Blob([region.rawImage.bytes], { type: region.rawImage.mimeType })
        : await dependencies.crop(region);
      const mimeType = region.rawImage?.mimeType ?? 'image/png';
      if (blob.type && blob.type !== 'image/png' && blob.type !== 'image/jpeg') {
        throw new Error(`Unsupported immutable asset type: ${blob.type}`);
      }
      assets[index] = await createAsset({ ...region, blob, mimeType });
    }
  };
  const settled = await Promise.allSettled(Array.from(
    { length: Math.min(concurrency, regions.length) },
    () => worker(),
  ));
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  return assets;
}
