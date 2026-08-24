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
}

export interface DetectedAssetRegion {
  id: string;
  kind: ImmutableAssetKind;
  pageIndex: number;
  rect: Rect;
  widthMode: WidthMode;
  captionUnitId?: string;
  rawImage?: { bytes: Uint8Array; mimeType: ImmutableAssetMimeType };
}

export interface AssetExtractionDependencies {
  crop(region: DetectedAssetRegion): Promise<Blob>;
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
  return Promise.all(regions.map(async (region) => {
    const blob = region.rawImage
      ? new Blob([region.rawImage.bytes], { type: region.rawImage.mimeType })
      : await dependencies.crop(region);
    const mimeType = region.rawImage?.mimeType ?? 'image/png';
    if (blob.type && blob.type !== 'image/png' && blob.type !== 'image/jpeg') {
      throw new Error(`Unsupported immutable asset type: ${blob.type}`);
    }
    return createAsset({ ...region, blob, mimeType });
  }));
}
