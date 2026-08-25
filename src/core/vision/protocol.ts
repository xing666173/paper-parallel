export type VisionRegionType =
  | 'figure'
  | 'table'
  | 'display_formula'
  | 'code'
  | 'caption'
  | 'header'
  | 'footer'
  | 'body_text';

export type VisionColumn = 'left' | 'right' | 'full';
export type NormalizedVisionBox = [number, number, number, number];

export interface VisionRegion {
  type: VisionRegionType;
  /** x, y, width, height in the normalized 0..1000 page coordinate space. */
  bbox: NormalizedVisionBox;
  column: VisionColumn;
  captionBBox?: NormalizedVisionBox;
  confidence: number;
}

export interface VisionPageAnalysis {
  pageIndex: number;
  layout: 'single' | 'double' | 'mixed';
  regions: VisionRegion[];
}

export class VisionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionProtocolError';
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    throw new VisionProtocolError('Vision JSON 无法解析');
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VisionProtocolError(`Vision JSON ${path} 必须为对象`);
  }
  return value as Record<string, unknown>;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new VisionProtocolError(`Vision JSON ${path} 取值无效`);
  }
  return value as T;
}

function normalizedBox(value: unknown, path: string): NormalizedVisionBox {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new VisionProtocolError(`Vision JSON ${path} 必须为四个有限数字`);
  }
  const [x, y, width, height] = value as number[];
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1000 || y + height > 1000) {
    throw new VisionProtocolError(`Vision JSON ${path} 超出 0..1000 页面范围`);
  }
  return [x, y, width, height];
}

export function parseVisionPageAnalysis(value: unknown, expectedPageIndex: number): VisionPageAnalysis {
  const root = record(parseJson(value), 'root');
  const page = root.page;
  if (!Number.isInteger(page) || page !== expectedPageIndex + 1) {
    throw new VisionProtocolError('Vision JSON page 与请求页面不一致');
  }
  const layout = enumValue(root.layout, ['single', 'double', 'mixed'] as const, 'layout');
  if (!Array.isArray(root.regions)) throw new VisionProtocolError('Vision JSON regions 必须为数组');

  const regions = root.regions.map((input, index): VisionRegion => {
    const item = record(input, `regions[${index}]`);
    const confidence = item.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new VisionProtocolError(`Vision JSON regions[${index}].confidence 必须在 0..1`);
    }
    const captionValue = item.caption_bbox ?? item.captionBBox;
    return {
      type: enumValue(item.type, [
        'figure', 'table', 'display_formula', 'code', 'caption', 'header', 'footer', 'body_text',
      ] as const, `regions[${index}].type`),
      bbox: normalizedBox(item.bbox, `regions[${index}].bbox`),
      column: enumValue(item.column, ['left', 'right', 'full'] as const, `regions[${index}].column`),
      ...(captionValue === undefined ? {} : {
        captionBBox: normalizedBox(captionValue, `regions[${index}].caption_bbox`),
      }),
      confidence,
    };
  });

  return { pageIndex: expectedPageIndex, layout, regions };
}

export function serializeVisionPageAnalysis(analysis: VisionPageAnalysis): Record<string, unknown> {
  return {
    page: analysis.pageIndex + 1,
    layout: analysis.layout,
    regions: analysis.regions.map((region) => ({
      type: region.type,
      bbox: [...region.bbox],
      column: region.column,
      ...(region.captionBBox ? { caption_bbox: [...region.captionBBox] } : {}),
      confidence: region.confidence,
    })),
  };
}
