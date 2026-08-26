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

export function parseNormalizedVisionBox(value: unknown, path: string): NormalizedVisionBox {
  let values: unknown[];
  if (Array.isArray(value)) {
    values = value;
  } else if (value && typeof value === 'object') {
    const box = value as Record<string, unknown>;
    values = [box.x, box.y, box.width, box.height];
  } else {
    throw new VisionProtocolError(`Vision JSON ${path} 必须为四个有限数字`);
  }
  if (values.length !== 4 || values.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new VisionProtocolError(`Vision JSON ${path} 必须为四个有限数字`);
  }
  let [x, y, width, height] = values as number[];
  if ([x, y, width, height].every((item) => item >= 0 && item <= 1)) {
    [x, y, width, height] = [x * 1000, y * 1000, width * 1000, height * 1000];
  }
  const validXywh = x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1000 && y + height <= 1000;
  if (!validXywh) {
    const [x1, y1, x2, y2] = values as number[];
    const unambiguousXyxy = x1 >= 0 && y1 >= 0 && x2 <= 1000 && y2 <= 1000 && x2 > x1 && y2 > y1;
    if (unambiguousXyxy) {
      [x, y, width, height] = [x1, y1, x2 - x1, y2 - y1];
    }
  }
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1000 || y + height > 1000) {
    throw new VisionProtocolError(`Vision JSON ${path} 超出 0..1000 页面范围`);
  }
  return [x, y, width, height];
}

function normalizedColumn(value: unknown, bbox: NormalizedVisionBox): VisionColumn {
  if (value === 'left' || value === 'right' || value === 'full') return value;
  const normalized = typeof value === 'string' ? value.toLowerCase().replace(/[ _]/g, '-') : '';
  if (['both', 'span', 'full-width', 'center', 'centre', 'middle'].includes(normalized)) return 'full';
  const [x, , width] = bbox;
  if (width >= 560 || (x < 450 && x + width > 550)) return 'full';
  return x + width / 2 < 500 ? 'left' : 'right';
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
    const bbox = parseNormalizedVisionBox(item.bbox, `regions[${index}].bbox`);
    return {
      type: enumValue(item.type, [
        'figure', 'table', 'display_formula', 'code', 'caption', 'header', 'footer', 'body_text',
      ] as const, `regions[${index}].type`),
      bbox,
      column: normalizedColumn(item.column, bbox),
      ...(captionValue === undefined ? {} : {
        captionBBox: parseNormalizedVisionBox(captionValue, `regions[${index}].caption_bbox`),
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
