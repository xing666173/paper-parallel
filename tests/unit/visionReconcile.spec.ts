import { describe, expect, it } from 'vitest';
import {
  authorPortraitAssetsFromBitmapRegions,
  reconcileVisionLayout,
} from '../../src/core/vision/reconcile';
import type { Doc } from '../../src/types/models';

describe('vision: deterministic layout reconciliation', () => {
  it('maps a confident figure box to source coordinates and its existing caption', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 190, 360, 260], column: 'left',
        captionBBox: [80, 470, 360, 35], confidence: 0.98,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toEqual([expect.objectContaining({
      id: 'vision-p1-figure-1', kind: 'figure', pageIndex: 0,
      rect: { x: 48.96, y: 150.48, w: 220.32, h: 205.92 },
      widthMode: 'column', captionUnitId: 'caption-1',
    })]);
  });

  it('does not promote a narrow centered panel to a spanning asset from the model label alone', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'figure', bbox: [350, 190, 300, 230], column: 'full', confidence: 0.99,
      }],
    }]);

    expect(result.assetRegions[0]?.widthMode).toBe('column');
  });

  it('expands a figure crop to include adjacent multi-line diagram labels', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'diagram-labels', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 280, y: 160, w: 220, h: 120 }, order: 0.5,
      text: 'Stream 1\nData Transfer\nGPU Computation\nMSM\nIdle',
      splitAllowed: true, widthMode: 'column',
    });
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'single', regions: [{
        type: 'figure', bbox: [500, 190, 160, 200], column: 'full', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]!.rect.x).toBeLessThanOrEqual(278);
    expect(result.assetRegions[0]!.rect.x + result.assetRegions[0]!.rect.w).toBeGreaterThanOrEqual(502);
  });

  it('keeps a complete wide Vision figure stable instead of expanding it to detached labels', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'detached-labels', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 6, y: 180, w: 45, h: 110 }, order: 0.5,
      text: '4 bit\n8 bit\n16 bit\n32 bit', splitAllowed: true, widthMode: 'column',
    });
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'figure', bbox: [100, 220, 800, 180], column: 'full', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.rect.x).toBeGreaterThan(50);
    expect(result.assetRegions[0]?.widthMode).toBe('span');
  });

  it('removes overlap between a code crop and its following figure crop', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'mixed', regions: [
        { type: 'code', bbox: [500, 150, 360, 360], column: 'right', confidence: 0.99 },
        { type: 'figure', bbox: [500, 400, 360, 260], column: 'right', confidence: 0.99 },
      ],
    }]);
    const code = result.assetRegions.find((asset) => asset.kind === 'code')!;
    const figure = result.assetRegions.find((asset) => asset.kind === 'figure')!;

    expect(result.unresolved).toEqual([]);
    expect(code.rect.y + code.rect.h).toBeLessThanOrEqual(figure.rect.y);
  });

  it('trims an algorithm title from the top of its immutable code crop', () => {
    const doc = fixtureDoc();
    doc.blocks = [{
      id: 'algorithm-caption', docId: 'en', type: 'caption', pageIndex: 0,
      rect: { x: 67, y: 94, w: 478, h: 14 }, order: 0,
      text: 'Algorithm 1 The Pippenger Algorithm', splitAllowed: false, widthMode: 'span',
    }];
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'single', regions: [{
        type: 'code', bbox: [110, 110, 780, 500], column: 'full',
        captionBBox: [110, 118, 780, 18], captionPosition: 'above', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toHaveLength(1);
    expect(result.assetRegions[0]).toMatchObject({ kind: 'code', captionUnitId: 'algorithm-caption' });
    expect(result.assetRegions[0]!.rect.y).toBeGreaterThanOrEqual(110);
  });

  it('links an algorithm title even when an older parsed document labeled it as prose', () => {
    const doc = fixtureDoc();
    doc.blocks = [{
      id: 'algorithm-caption', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 67, y: 94, w: 478, h: 14 }, order: 0,
      text: 'Algorithm 4 pBucketPointsReduction', splitAllowed: true, widthMode: 'span',
    }];
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'single', regions: [{
        type: 'code', bbox: [110, 110, 780, 500], column: 'full',
        captionBBox: [110, 118, 780, 18], captionPosition: 'above', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.captionUnitId).toBe('algorithm-caption');
  });

  it('matches a nearby approximate caption box and trims a figure crop that includes the real caption', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 190, 360, 320], column: 'left',
        captionBBox: [80, 440, 360, 20], confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toHaveLength(1);
    const asset = result.assetRegions[0]!;
    expect(asset.captionUnitId).toBe('caption-1');
    expect(asset.rect.y + asset.rect.h).toBeLessThanOrEqual(372);
  });

  it('reconciles a coarse Vision caption box to the only same-column PDF caption', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 190, 360, 390], column: 'left',
        captionBBox: [80, 600, 360, 20], confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.captionUnitId).toBe('caption-1');
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h).toBeLessThanOrEqual(370);
  });

  it('matches a materially displaced Vision caption when the horizontal column is unambiguous', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 190, 360, 500], column: 'left',
        captionBBox: [80, 650, 360, 20], confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.captionUnitId).toBe('caption-1');
  });

  it('links the nearest real caption when Vision omits caption_bbox', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 190, 360, 230], column: 'left', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.captionUnitId).toBe('caption-1');
  });

  it('uses the earliest caption boundary so the immutable crop never bakes in caption text', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 190, 360, 330], column: 'left',
        captionBBox: [80, 450, 360, 35], confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.rect.y).toBe(150.48);
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h)
      .toBeLessThanOrEqual(354.4);
  });

  it('trims prose below a table when character-line geometry exposes a large vertical gap', () => {
    const doc = fixtureDoc();
    const lines = [
      { y: 96, text: 'Method Throughput Area' },
      { y: 110, text: 'Baseline 1.0 12.4' },
      { y: 121, text: 'Ours 2.4 10.1' },
      { y: 132, text: 'Optimized 3.1 9.7' },
      { y: 145, text: 'memory access latency.' },
      { y: 172, text: 'Further analysis confirms the same trend.' },
    ];
    let sourceIndex = 0;
    doc.blocks.push({
      id: 'table-text', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 320, y: 96, w: 235, h: 86 }, order: 2,
      text: lines.map((line) => line.text).join('\n'), splitAllowed: true, widthMode: 'column',
      characterRects: lines.flatMap((line) => {
        const chars = [...line.text];
        const result = chars.map((ch, index) => ({
          ch, sourceIndex: sourceIndex + index, pageIndex: 0,
          rect: { x: 322 + index * 4.4, y: line.y, w: 4.2, h: 8 },
        }));
        sourceIndex += chars.length + 1;
        return result;
      }),
    });

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'table', bbox: [510, 110, 410, 130], column: 'right', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h)
      .toBeLessThan(145);
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h)
      .toBeGreaterThan(139);
  });

  it('keeps natural-language table cells and trims only the prose after the table', () => {
    const doc = fixtureDoc();
    const lines = [
      { y: 100, text: 'Implementations Platform Supported Operations' },
      { y: 114, text: 'cuZK GPU Groth BLS12-381' },
      { y: 128, text: 'Bellperson GPU Groth BLS12-381' },
      { y: 142, text: 'Hardcaml FPGA MSM NTT BLS12-377' },
      { y: 180, text: 'The following paragraph resumes the technical discussion.' },
    ];
    let sourceIndex = 0;
    doc.blocks.push({
      id: 'natural-table-text', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 55, y: 100, w: 500, h: 90 }, order: 2,
      text: lines.map((line) => line.text).join('\n'), splitAllowed: true, widthMode: 'span',
      characterRects: lines.flatMap((line) => {
        const chars = [...line.text];
        const result = chars.map((ch, index) => ({
          ch, sourceIndex: sourceIndex + index, pageIndex: 0,
          rect: { x: 58 + index * 4.4, y: line.y, w: 4.2, h: 8 },
        }));
        sourceIndex += chars.length + 1;
        return result;
      }),
    });

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'single', regions: [{
        type: 'table', bbox: [80, 110, 840, 150], column: 'full', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h).toBeGreaterThan(148);
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h).toBeLessThan(180);
  });

  it('accepts a low-confidence wide numeric table when PDF geometry independently corroborates it', () => {
    const doc = fixtureDoc();
    const header = 'Application Size CPU ASIC GPU Proof';
    const rows = Array.from({ length: 8 }, (_, index) => (
      `Workload-${index + 1} ${16384 * (index + 1)} 0.${index + 1}1 1.${index + 2}3 2.${index + 3}5 49.${index + 4}`
    ));
    doc.blocks.push(
      {
        id: 'wide-table-header', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 55, y: 90, w: 500, h: 18 }, order: 2,
        text: header, splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'wide-table-rows', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 55, y: 112, w: 500, h: 88 }, order: 3,
        text: rows.join('\n'), splitAllowed: true, widthMode: 'span',
      },
    );
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'table', bbox: [80, 95, 840, 170], column: 'full',
        captionBBox: [320, 70, 360, 20], confidence: 0.5,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toEqual([
      expect.objectContaining({ kind: 'table', widthMode: 'span', captionUnitId: undefined }),
    ]);
    expect(result.assetRegions[0]!.rect.y).toBeLessThan(90);
  });

  it('trims ordinary prose below a complete algorithm crop at the first large line gap', () => {
    const doc = fixtureDoc();
    const lines = [
      { y: 100, text: 'Algorithm 1 The Pippenger Algorithm' },
      { y: 114, text: 'Require: A scalar vector and window size.' },
      { y: 128, text: '1: for j to 1 do // Convert task into subtasks.' },
      { y: 142, text: '18: return Q' },
      { y: 184, text: 'The following paragraph resumes the ordinary technical discussion.' },
    ];
    let sourceIndex = 0;
    doc.blocks.push({
      id: 'algorithm-text', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 55, y: 100, w: 500, h: 95 }, order: 2,
      text: lines.map((line) => line.text).join('\n'), splitAllowed: true, widthMode: 'span',
      characterRects: lines.flatMap((line) => {
        const chars = [...line.text];
        const result = chars.map((ch, index) => ({
          ch, sourceIndex: sourceIndex + index, pageIndex: 0,
          rect: { x: 58 + index * 4.4, y: line.y, w: 4.2, h: 8 },
        }));
        sourceIndex += chars.length + 1;
        return result;
      }),
    });

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'single', regions: [{
        type: 'code', bbox: [80, 110, 840, 150], column: 'full', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h).toBeLessThan(180);
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h).toBeGreaterThan(145);
  });

  it('keeps raster clearance between a table crop and a caption immediately above it', () => {
    const doc = fixtureDoc();
    const caption = doc.blocks.find((block) => block.id === 'caption-1')!;
    caption.text = 'Table 1: Experimental Setup';
    caption.rect = { x: 320, y: 140, w: 220, h: 20 };
    doc.semanticUnits.find((unit) => unit.id === 'caption-1')!.sourceText = caption.text;

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'table', bbox: [500, 203, 400, 250], column: 'right', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]!.rect.y).toBeGreaterThanOrEqual(164);
  });

  it('trims an overlong table crop before the following table caption', () => {
    const doc = fixtureDoc();
    const ownCaption = doc.blocks.find((block) => block.id === 'caption-1')!;
    ownCaption.text = 'TABLE III';
    ownCaption.rect = { x: 60, y: 60, w: 60, h: 9 };
    doc.semanticUnits.find((unit) => unit.id === 'caption-1')!.sourceText = ownCaption.text;
    doc.blocks.push({
      id: 'caption-2', docId: 'en', type: 'caption', pageIndex: 0,
      rect: { x: 60, y: 205, w: 60, h: 9 }, order: 3,
      text: 'TABLE IV', splitAllowed: false, widthMode: 'column',
    });

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'table', bbox: [80, 90, 400, 200], column: 'left',
        captionBBox: [80, 70, 400, 20], confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h)
      .toBeLessThanOrEqual(202);
  });

  it('adds clearance above a figure when a preceding text block touches its crop edge', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'authors', docId: 'en', type: 'authors', pageIndex: 0,
      rect: { x: 170, y: 176, w: 360, h: 21.5 }, order: 1,
      text: 'Corresponding author: author@example.org', splitAllowed: true, widthMode: 'span',
    });

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'figure', bbox: [500, 250, 480, 230], column: 'right', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]!.rect.y).toBeGreaterThanOrEqual(199.5);
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h).toBeCloseTo(380.16);
  });

  it('trims a repeated running title carried by cross-page character geometry from a top figure', () => {
    const doc = fixtureDoc();
    const title = 'ZK-Tracer: A High-Performance Heterogeneous Accelerator';
    doc.blocks.push({
      id: 'cross-page-block', docId: 'en', type: 'paragraph', pageIndex: 1,
      rect: { x: 50, y: 650, w: 240, h: 50 }, order: 2,
      text: title, splitAllowed: true, widthMode: 'column',
      characterRects: [...title].map((ch, index) => ({
        ch, sourceIndex: index, pageIndex: 0,
        rect: { x: 330 + index * 3.2, y: 60, w: 3, h: 7 },
      })),
    });

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [500, 70, 430, 300], column: 'right', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]!.rect.y).toBeGreaterThanOrEqual(71);
  });

  it('deduplicates a nested subregion when Vision also returns the complete figure', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [
        {
          type: 'figure', bbox: [80, 190, 360, 260], column: 'left',
          captionBBox: [80, 470, 360, 35], confidence: 0.97,
        },
        {
          type: 'figure', bbox: [100, 220, 180, 120], column: 'left', confidence: 0.99,
        },
      ],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toHaveLength(1);
    expect(result.assetRegions[0]?.captionUnitId).toBe('caption-1');
  });

  it('uses a unique visible figure number to recover a materially displaced caption box', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'caption-6', docId: 'en', type: 'caption', pageIndex: 0,
      rect: { x: 330, y: 350, w: 220, h: 20 }, order: 2,
      text: 'Figure 6: Main Trace Unit', splitAllowed: false, widthMode: 'column',
    });
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'figure', bbox: [520, 470, 460, 280], column: 'right',
        captionBBox: [600, 755, 300, 15], visibleLabel: 'Figure 6',
        captionPosition: 'below', confidence: 0.95,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.captionUnitId).toBe('caption-6');
  });

  it('snaps a partially detected captioned figure to its exact raster XObject bounds', () => {
    const doc = fixtureDoc();
    doc.blocks = [{
      id: 'caption-6', docId: 'en', type: 'caption', pageIndex: 0,
      rect: { x: 386, y: 441, w: 104, h: 9 }, order: 1,
      text: 'Figure 6: Main Trace Unit', splitAllowed: false, widthMode: 'column',
    }];
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [520, 390, 430, 161], column: 'right',
        captionBBox: [630, 555, 170, 15], visibleLabel: 'Figure 6',
        captionPosition: 'below', confidence: 0.99,
      }],
    }], 0.8, new Map([[0, [
      { x: 53.8, y: 83.7, w: 504.4, h: 146 },
      { x: 318, y: 254.1, w: 240.2, h: 175.5 },
    ]] ]));

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.rect).toEqual({
      x: 318, y: 254.1, w: 240.2, h: 175.5,
    });
  });

  it('matches every figure title extracted into one multi-caption PDF block', () => {
    const doc = fixtureDoc();
    const lines = [
      { text: 'Figure 9: Parallelism Analysis', x: 50 },
      { text: 'Figure 10: MTU and PTU Speedup', x: 230 },
      { text: 'Figure 11: Ablation Study', x: 430 },
    ];
    let sourceIndex = 0;
    doc.blocks = [{
      id: 'merged-captions', docId: 'en', type: 'caption', pageIndex: 0,
      rect: { x: 50, y: 195, w: 500, h: 12 }, order: 0,
      text: lines.map((line) => line.text).join('\n'), splitAllowed: false, widthMode: 'span',
      characterRects: lines.flatMap((line) => {
        const characters = [...line.text].map((ch, index) => ({
          ch,
          sourceIndex: sourceIndex + index,
          pageIndex: 0,
          rect: { x: line.x + index * 4, y: 195, w: 3.8, h: 10 },
        }));
        sourceIndex += line.text.length + 1;
        return characters;
      }),
    }];
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'figure', bbox: [360, 100, 250, 140], column: 'right',
        captionBBox: [370, 250, 250, 20], visibleLabel: 'Figure 10',
        captionPosition: 'below', confidence: 0.95,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.captionUnitId).toBe('merged-captions');
  });

  it('keeps adjacent figures distinct when their captions share one PDF block', () => {
    const doc = fixtureDoc();
    const lines = [
      { text: 'Figure 9: Parallelism Analysis', x: 50 },
      { text: 'Figure 10: MTU and PTU Speedup', x: 230 },
    ];
    let sourceIndex = 0;
    doc.blocks = [{
      id: 'merged-captions', docId: 'en', type: 'caption', pageIndex: 0,
      rect: { x: 50, y: 195, w: 500, h: 12 }, order: 0,
      text: lines.map((line) => line.text).join('\n'), splitAllowed: false, widthMode: 'span',
      characterRects: lines.flatMap((line) => {
        const characters = [...line.text].map((ch, index) => ({
          ch,
          sourceIndex: sourceIndex + index,
          pageIndex: 0,
          rect: { x: line.x + index * 4, y: 195, w: 3.8, h: 10 },
        }));
        sourceIndex += line.text.length + 1;
        return characters;
      }),
    }];

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [
        {
          type: 'figure', bbox: [50, 100, 260, 150], column: 'left',
          captionBBox: [80, 245, 260, 20], visibleLabel: 'Figure 9',
          captionPosition: 'below', confidence: 0.95,
        },
        {
          type: 'figure', bbox: [320, 100, 260, 150], column: 'left',
          captionBBox: [320, 245, 260, 20], visibleLabel: 'Figure 10',
          captionPosition: 'below', confidence: 0.95,
        },
      ],
    }], 0.8, new Map([[0, [
      // One source XObject spans into the next plot and must not replace the
      // tight Figure 9 Vision box; Figure 10 has its own exact bitmap.
      { x: 51.8, y: 81.69, w: 264.13, h: 104.37 },
      { x: 198.91, y: 77.2, w: 182.53, h: 113.52 },
    ]]]));

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toHaveLength(2);
    expect(result.assetRegions.map((asset) => asset.captionUnitId))
      .toEqual(['merged-captions', 'merged-captions']);
    expect(result.assetRegions[0]!.rect.x + result.assetRegions[0]!.rect.w)
      .toBeLessThan(198.91);
  });

  it('retracts label-driven expansion that only grazes the preceding figure caption', () => {
    const doc = fixtureDoc();
    doc.blocks = [
      {
        id: 'caption-7', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 105, y: 264, w: 190, h: 12 }, order: 0,
        text: 'Figure 7: Previous diagram', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'figure-8-labels', docId: 'en', type: 'equation', pageIndex: 0,
        rect: { x: 60, y: 274, w: 220, h: 30 }, order: 1,
        text: 'Input\nStage 1\nStage 2\nOutput', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'caption-8', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 98, y: 382, w: 205, h: 12 }, order: 2,
        text: 'Figure 8: Batch Modular Inverse Unit', splitAllowed: false, widthMode: 'column',
      },
    ];
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'figure', bbox: [80, 350, 400, 130], column: 'left',
        captionBBox: [130, 485, 290, 20], visibleLabel: 'Figure 8',
        captionPosition: 'below', confidence: 0.95,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.captionUnitId).toBe('caption-8');
    expect(result.assetRegions[0]!.rect.y).toBeGreaterThanOrEqual(278);
  });

  it('still rejects a source figure box that originally covers a foreign caption', () => {
    const doc = fixtureDoc();
    doc.blocks = [
      {
        id: 'caption-7', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 105, y: 264, w: 190, h: 12 }, order: 0,
        text: 'Figure 7: Previous diagram', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'caption-8', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 98, y: 382, w: 205, h: 12 }, order: 1,
        text: 'Figure 8: Batch Modular Inverse Unit', splitAllowed: false, widthMode: 'column',
      },
    ];
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'figure', bbox: [80, 330, 400, 150], column: 'left',
        captionBBox: [130, 485, 290, 20], visibleLabel: 'Figure 8',
        captionPosition: 'below', confidence: 0.95,
      }],
    }]);

    expect(result.unresolved).toEqual([expect.objectContaining({ reason: 'caption-overlap' })]);
  });

  it('does not use a visible number when the PDF text layer contains duplicate caption identities', () => {
    const doc = fixtureDoc();
    doc.blocks.push(
      {
        id: 'caption-6a', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 330, y: 200, w: 220, h: 20 }, order: 2,
        text: 'Figure 6: First panel', splitAllowed: false, widthMode: 'column',
      },
      {
        id: 'caption-6b', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 330, y: 350, w: 220, h: 20 }, order: 3,
        text: 'Figure 6: Duplicate panel', splitAllowed: false, widthMode: 'column',
      },
    );
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'figure', bbox: [520, 470, 460, 280], column: 'right',
        captionBBox: [600, 755, 300, 15], visibleLabel: 'Figure 6',
        captionPosition: 'below', confidence: 0.95,
      }],
    }]);

    expect(result.unresolved).toEqual([expect.objectContaining({ reason: 'caption-unmatched' })]);
  });

  it('matches an IEEE Fig. caption embedded after diagram labels', () => {
    const doc = fixtureDoc();
    doc.blocks = doc.blocks.filter((block) => block.id !== 'body-1');
    const caption = doc.blocks.find((block) => block.id === 'caption-1')!;
    caption.type = 'paragraph';
    caption.text = 'Expand\nwitness\nDDR\nAccelerator\nFig. 10. The overall architecture of PipeZK.';
    caption.rect = { x: 50, y: 80, w: 220, h: 110 };
    let sourceIndex = 0;
    caption.characterRects = caption.text.split('\n').flatMap((line, lineIndex) => {
      const characters = [...line].map((ch, index) => ({
        ch, sourceIndex: sourceIndex + index, pageIndex: 0,
        rect: { x: 50 + index * 4, y: lineIndex === 4 ? 180 : 80 + lineIndex * 16, w: 3.8, h: 8 },
      }));
      sourceIndex += line.length + 1;
      return characters;
    });

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 100, 360, 100], column: 'left',
        captionBBox: [80, 225, 360, 20], confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]?.captionUnitId).toBe('caption-1');
  });

  it('drops a formula box that is actually a label nested inside a larger figure', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'mixed', regions: [
        {
          type: 'display_formula', bbox: [200, 220, 400, 70], column: 'full', confidence: 0.98,
        },
        {
          type: 'figure', bbox: [180, 230, 440, 260], column: 'full', confidence: 0.99,
        },
      ],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toHaveLength(1);
    expect(result.assetRegions[0]?.kind).toBe('figure');
  });

  it('fails closed for low confidence and page-edge assets', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [
        { type: 'figure', bbox: [80, 190, 360, 260], column: 'left', confidence: 0.4 },
        { type: 'figure', bbox: [0, 0, 400, 300], column: 'left', confidence: 0.99 },
      ],
    }]);

    expect(result.assetRegions).toEqual([]);
    expect(result.unresolved.map((item) => item.reason)).toEqual([
      'low-confidence', 'page-edge-touch',
    ]);
  });

  it('accepts a moderately confident asset only when its caption box is geometrically corroborated', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'figure', bbox: [80, 190, 360, 260], column: 'left',
        captionBBox: [80, 470, 360, 35], confidence: 0.5,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toEqual([expect.objectContaining({
      kind: 'figure', captionUnitId: 'caption-1',
    })]);
  });

  it('accepts a moderately confident figure when a coarse caption box is one line from the matching PDF caption', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'figure', bbox: [200, 301, 600, 150], column: 'full',
        captionBBox: [80, 460, 360, 15], confidence: 0.5,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toEqual([expect.objectContaining({
      kind: 'figure', captionUnitId: 'caption-1',
    })]);
  });

  it('accepts a moderately confident formula only when a local equation block corroborates it', () => {
    const doc = fixtureDoc();
    doc.blocks.push({
      id: 'equation-1', docId: 'en', type: 'equation', pageIndex: 0,
      rect: { x: 220, y: 520, w: 90, h: 18 }, order: 2,
      text: 'Q = kP = ∑ k_i P_i', splitAllowed: false, widthMode: 'column',
    });
    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'display_formula', bbox: [350, 640, 300, 130], column: 'full', confidence: 0.5,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toEqual([expect.objectContaining({ kind: 'formula' })]);
  });

  it('still rejects a moderately confident formula with no independent PDF equation evidence', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'mixed', regions: [{
        type: 'display_formula', bbox: [350, 640, 300, 130], column: 'full', confidence: 0.5,
      }],
    }]);

    expect(result.assetRegions).toEqual([]);
    expect(result.unresolved[0]?.reason).toBe('low-confidence');
  });

  it('accepts a low-confidence cluster of uncaptioned author portraits on a biography page', () => {
    const doc = fixtureDoc();
    doc.blocks = [{
      id: 'bios', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 180, y: 80, w: 360, h: 500 }, order: 0,
      text: [
        'Alice Smith received the Ph.D. degree from Example University.',
        'Bob Jones received the M.S. degree from Example University.',
        'Carol Lee received the B.Eng. degree from Example University.',
      ].join('\n'), splitAllowed: true, widthMode: 'span',
    }];
    doc.semanticUnits = [{
      id: 'bios', kind: 'paragraph', sourceText: doc.blocks[0]!.text,
      protectedTokens: [], layoutRegionId: 'region-1', order: 0,
    }];
    doc.layoutRegions[0]!.orderedUnitIds = ['bios'];

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'double', regions: [
        { type: 'figure', bbox: [40, 120, 130, 130], column: 'left', confidence: 0.5 },
        { type: 'figure', bbox: [40, 360, 130, 130], column: 'left', confidence: 0.5 },
        { type: 'figure', bbox: [40, 600, 130, 130], column: 'left', confidence: 0.5 },
        { type: 'figure', bbox: [500, 80, 130, 130], column: 'right', confidence: 0.5 },
        { type: 'figure', bbox: [500, 320, 130, 130], column: 'right', confidence: 0.5 },
        { type: 'figure', bbox: [500, 560, 130, 130], column: 'right', confidence: 0.5 },
      ],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions).toHaveLength(6);
    expect(result.assetRegions.every((asset) => asset.kind === 'figure' && !asset.captionUnitId)).toBe(true);
  });

  it('uses exact raster XObject rectangles for a cluster of author portraits', () => {
    const doc = fixtureDoc();
    doc.blocks = [{
      id: 'bios', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 45, y: 70, w: 510, h: 620 }, order: 0,
      text: [
        'Alice Smith received the Ph.D. degree from Example University.',
        'Bob Jones received the M.S. degree from Example University.',
        'Carol Lee received the B.Eng. degree from Example University.',
      ].join('\n'), splitAllowed: true, widthMode: 'span',
    }];
    const exact = [
      { x: 42, y: 176, w: 72, h: 90 }, { x: 42, y: 340, w: 72, h: 90 },
      { x: 42, y: 458, w: 72, h: 90 }, { x: 305, y: 67, w: 72, h: 90 },
      { x: 305, y: 169, w: 72, h: 90 }, { x: 305, y: 305, w: 72, h: 90 },
    ];

    const assets = authorPortraitAssetsFromBitmapRegions(doc, new Map([[0, exact]]));

    expect(assets).toHaveLength(6);
    expect(assets.map((asset) => asset.rect)).toEqual(exact);
    expect(assets.map((asset) => asset.id)).toEqual([
      'bitmap-p1-portrait-1', 'bitmap-p1-portrait-2', 'bitmap-p1-portrait-3',
      'bitmap-p1-portrait-4', 'bitmap-p1-portrait-5', 'bitmap-p1-portrait-6',
    ]);
  });

  it('rejects a repeated stack of thin full-width formula boxes hallucinated from body text lines', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0,
      layout: 'single',
      regions: Array.from({ length: 8 }, (_, index) => ({
        type: 'display_formula' as const,
        bbox: [110, 300 + index * 18, 780, 16] as [number, number, number, number],
        column: 'full' as const,
        confidence: 0.95,
      })),
    }]);

    expect(result.assetRegions).toEqual([]);
    expect(result.unresolved).toHaveLength(8);
    expect(result.unresolved.every((item) => item.reason === 'implausible-formula-cluster')).toBe(true);
  });

  it('rejects a repeated stack of thin column-width formula boxes hallucinated from text lines', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0,
      layout: 'double',
      regions: Array.from({ length: 12 }, (_, index) => ({
        type: 'display_formula' as const,
        bbox: [102, 190 + index * 18, 430, 32] as [number, number, number, number],
        column: 'left' as const,
        confidence: 0.95,
      })),
    }]);

    expect(result.assetRegions).toEqual([]);
    expect(result.unresolved).toHaveLength(12);
    expect(result.unresolved.every((item) => item.reason === 'implausible-formula-cluster')).toBe(true);
  });

  it('rejects one thin full-width text line mislabeled as a display formula', () => {
    const result = reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'single', regions: [{
        type: 'display_formula', bbox: [110, 300, 780, 16], column: 'full', confidence: 0.98,
      }],
    }]);

    expect(result.assetRegions).toEqual([]);
    expect(result.unresolved).toEqual([expect.objectContaining({ reason: 'implausible-formula-cluster' })]);
  });

  it('keeps a single-column display formula away from adjacent prose and includes its equation number', () => {
    const doc = fixtureDoc();
    doc.layoutMode = 'single';
    doc.layoutRegions = [{
      id: 'region-1', mode: 'full-width', sourcePage: 0,
      bounds: { x: 100, y: 70, w: 412, h: 650 }, orderedUnitIds: ['before', 'after'],
    }];
    const before = 'The preceding paragraph contains enough natural language words to be treated as ordinary body prose.';
    const after = 'The following paragraph also contains enough natural language words to be treated as ordinary body prose.';
    doc.blocks = [
      {
        id: 'before', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 100, y: 150, w: 412, h: 40 }, order: 0, text: before,
        splitAllowed: true, widthMode: 'span',
      },
      {
        id: 'after', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 100, y: 244, w: 412, h: 30 }, order: 1, text: after,
        splitAllowed: true, widthMode: 'span',
        characterRects: [...after].map((ch, index) => ({
          ch, sourceIndex: index, pageIndex: 0,
          rect: { x: 100 + index * 4, y: 244, w: 3.8, h: 9 },
        })),
      },
    ];

    const result = reconcileVisionLayout(doc, [{
      pageIndex: 0, layout: 'single', regions: [{
        type: 'display_formula', bbox: [340, 250, 320, 50], column: 'full', confidence: 0.99,
      }],
    }]);

    expect(result.unresolved).toEqual([]);
    expect(result.assetRegions[0]).toMatchObject({
      rect: { x: 100, w: 412 }, widthMode: 'span',
    });
    expect(result.assetRegions[0]!.rect.y + result.assetRegions[0]!.rect.h).toBeLessThanOrEqual(242);
  });

  it('ignores body text annotations and rejects missing or duplicate page analyses', () => {
    expect(reconcileVisionLayout(fixtureDoc(), [{
      pageIndex: 0, layout: 'double', regions: [{
        type: 'body_text', bbox: [80, 100, 360, 100], column: 'left', confidence: 0.99,
      }],
    }])).toEqual({ assetRegions: [], unresolved: [] });

    expect(() => reconcileVisionLayout(fixtureDoc(), [])).toThrow('缺少第 1 页');
    expect(() => reconcileVisionLayout(fixtureDoc(), [
      { pageIndex: 0, layout: 'double', regions: [] },
      { pageIndex: 0, layout: 'double', regions: [] },
    ])).toThrow('重复');
  });
});

function fixtureDoc(): Doc {
  return {
    id: 'en', role: 'en', pageCount: 1,
    pages: [{ pageIndex: 0, width: 612, height: 792, columns: [] }],
    blocks: [
      {
        id: 'body-1', docId: 'en', type: 'paragraph', pageIndex: 0,
        rect: { x: 50, y: 80, w: 220, h: 50 }, order: 0,
        text: 'A normal body paragraph that should remain translated text.',
        splitAllowed: true, widthMode: 'column',
      },
      {
        id: 'caption-1', docId: 'en', type: 'caption', pageIndex: 0,
        rect: { x: 49, y: 372, w: 220, h: 28 }, order: 1,
        text: 'Figure 1: Workflow', splitAllowed: false, widthMode: 'column',
      },
    ],
    layoutRegions: [{
      id: 'region-1', mode: 'double', sourcePage: 0,
      bounds: { x: 49, y: 70, w: 514, h: 660 }, orderedUnitIds: ['body-1', 'caption-1'],
    }],
    semanticUnits: [
      { id: 'body-1', kind: 'paragraph', sourceText: 'A normal body paragraph that should remain translated text.', protectedTokens: [], layoutRegionId: 'region-1', order: 0 },
      { id: 'caption-1', kind: 'caption', sourceText: 'Figure 1: Workflow', protectedTokens: [], layoutRegionId: 'region-1', order: 1 },
    ],
    layoutMode: 'double', meta: { paperWidth: 612, paperHeight: 792 },
  };
}
