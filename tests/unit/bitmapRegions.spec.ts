import { describe, expect, it } from 'vitest';
import { OPS } from '../../src/core/pdf/runtime';
import { extractBitmapRegions } from '../../src/core/pdf/bitmapRegions';

describe('PDF bitmap region extraction', () => {
  it('recovers exact image rectangles from the graphics-state transform stack', () => {
    const regions = extractBitmapRegions({
      fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      argsArray: [[], [72, 0, 0, 90, 42, 176], ['portrait', 320, 400], []],
    }, [1, 0, 0, 1, 0, 0]);

    expect(regions).toEqual([{ x: 42, y: 176, w: 72, h: 90 }]);
  });

  it('applies the PDF.js page viewport transform to image corners', () => {
    const regions = extractBitmapRegions({
      fnArray: [OPS.transform, OPS.paintImageXObject],
      argsArray: [[20, 0, 0, 30, 10, 40], ['image', 20, 30]],
    }, [1, 0, 0, -1, 0, 100]);

    expect(regions).toEqual([{ x: 10, y: 30, w: 20, h: 30 }]);
  });
});
