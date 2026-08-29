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

  it('converts fractional 0..1 xywh geometry into the 0..1000 protocol space', () => {
    expect(parseVisionPageAnalysis({
      page: 1,
      layout: 'single',
      regions: [{
        type: 'figure',
        bbox: { x: 0.08, y: 0.18, width: 0.84, height: 0.03 },
        column: 'full',
        confidence: 0.95,
      }],
    }, 0).regions[0].bbox).toEqual([80, 180, 840, 30]);
  });

  it('repairs an ambiguous xyxy asset box that otherwise lands exactly on the page edge', () => {
    expect(parseVisionPageAnalysis({
      page: 1,
      layout: 'mixed',
      regions: [{
        type: 'table',
        bbox: { x: 214, y: 304, width: 786, height: 266 },
        column: 'full',
        caption_bbox: { x: 330, y: 286, width: 554, height: 14 },
        confidence: 0.95,
      }],
    }, 0).regions[0]).toMatchObject({
      bbox: [214, 304, 572, 266],
      captionBBox: [330, 286, 554, 14],
    });
  });

  it.each([
    [95, 0.95],
    ['95%', 0.95],
    ['0.95', 0.95],
    ['95/100', 0.95],
    ['high', 0.95],
    ['confidence: 0.95', 0.95],
    [{ score: 95 }, 0.95],
    [[0.95], 0.95],
  ])('normalizes confidence %p returned by Vision Exp', (confidence, expected) => {
    const analysis = parseVisionPageAnalysis({
      page: 1,
      layout: 'double',
      regions: [{
        type: 'figure', bbox: [100, 200, 400, 300], column: 'left', confidence,
      }],
    }, 0);

    expect(analysis.regions[0]?.confidence).toBe(expected);
  });

  it('uses conservative confidence when the provider returns unusable advisory metadata', () => {
    const analysis = parseVisionPageAnalysis({
      page: 1,
      layout: 'single',
      regions: [{
        type: 'figure', bbox: [100, 200, 400, 300], column: 'full', confidence: 'not reported',
      }],
    }, 0);

    expect(analysis.regions[0]?.confidence).toBe(0.5);
  });

  it('infers a recoverable column label from validated normalized geometry', () => {
    const regions = parseVisionPageAnalysis({
      page: 1, layout: 'mixed', regions: [
        { type: 'figure', bbox: [50, 100, 400, 200], column: 'column-1', confidence: 0.9 },
        { type: 'figure', bbox: [550, 100, 400, 200], column: 'column-2', confidence: 0.9 },
        { type: 'table', bbox: [100, 400, 800, 200], column: 'both', confidence: 0.9 },
      ],
    }, 0).regions;

    expect(regions.map((region) => region.column)).toEqual(['left', 'right', 'full']);
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
