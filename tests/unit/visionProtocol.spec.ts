import { describe, expect, it } from 'vitest';
import {
  parseVisionPageAnalysis,
  serializeVisionPageAnalysis,
  VisionProtocolError,
} from '../../src/core/vision/protocol';

describe('vision: page analysis protocol', () => {
  it('normalizes strict normalized geometry without changing coordinates', () => {
    expect(parseVisionPageAnalysis({
      page: 2,
      layout: 'mixed',
      regions: [{
        type: 'figure', bbox: [80, 210, 420, 310], column: 'left',
        caption_bbox: [80, 530, 420, 45], confidence: 0.97,
      }],
    }, 1)).toEqual({
      pageIndex: 1,
      layout: 'mixed',
      regions: [{
        type: 'figure', bbox: [80, 210, 420, 310], column: 'left',
        captionBBox: [80, 530, 420, 45], confidence: 0.97,
      }],
    });
  });

  it('accepts explicit xywh objects and repairs an unambiguous normalized xyxy array', () => {
    expect(parseVisionPageAnalysis({
      page: 1,
      layout: 'mixed',
      regions: [
        { type: 'figure', bbox: { x: 80, y: 210, width: 420, height: 310 }, column: 'left', confidence: 0.97 },
        { type: 'table', bbox: [520, 210, 940, 700], column: 'right', confidence: 0.96 },
        { type: 'code', bbox: { x: 600, y: 300, width: 920, height: 760 }, column: 'right', confidence: 0.95 },
      ],
    }, 0).regions.map((region) => region.bbox)).toEqual([
      [80, 210, 420, 310],
      [520, 210, 420, 490],
      [600, 300, 320, 460],
    ]);
  });

  it.each([
    [{ page: 1, layout: 'double', regions: [{ type: 'figure', bbox: [0, 1, 1001, 20], column: 'left', confidence: 1 }] }, 'bbox'],
    [{ page: 1, layout: 'double', regions: [{ type: 'photo', bbox: [1, 1, 20, 20], column: 'left', confidence: 1 }] }, 'type'],
    [{ page: 1, layout: 'columns', regions: [] }, 'layout'],
    [{ page: 2, layout: 'single', regions: [] }, 'page'],
  ])('rejects invalid model geometry or enums without echoing response data', (input, field) => {
    expect(() => parseVisionPageAnalysis(input, 0)).toThrowError(expect.objectContaining({
      name: 'VisionProtocolError',
      message: expect.stringContaining(field),
    }));
  });

  it('parses a fenced JSON object and rejects non-JSON output', () => {
    expect(parseVisionPageAnalysis('```json\n{"page":1,"layout":"single","regions":[]}\n```', 0))
      .toEqual({ pageIndex: 0, layout: 'single', regions: [] });
    expect(() => parseVisionPageAnalysis('private prose instead of JSON', 0))
      .toThrow(VisionProtocolError);
  });

  it('serializes the normalized analysis into the same strict cache protocol', () => {
    const normalized = parseVisionPageAnalysis({
      page: 1, layout: 'single', regions: [{
        type: 'table', bbox: [100, 200, 800, 300], column: 'full',
        caption_bbox: [100, 160, 800, 30], confidence: 0.9,
      }],
    }, 0);
    expect(serializeVisionPageAnalysis(normalized)).toEqual({
      page: 1, layout: 'single', regions: [{
        type: 'table', bbox: [100, 200, 800, 300], column: 'full',
        caption_bbox: [100, 160, 800, 30], confidence: 0.9,
      }],
    });
  });
});
