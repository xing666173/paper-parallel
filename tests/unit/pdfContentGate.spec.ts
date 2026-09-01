import { describe, expect, it } from 'vitest';
import { findAssetFooterOverflows, runPdfContentGate } from '../../src/core/quality/pdfContentGate';

describe('compiled PDF content gate', () => {
  it('rejects a raster/source-fragment PDF that contains none of the validated Chinese translations', () => {
    const result = runPdfContentGate({
      pageTexts: ['Currently hardware acceleration research Figure 1 zkVM workflow'],
      expectedTranslations: [
        '目前，硬件加速研究主要集中于后端证明阶段。',
        '我们提出了用于执行轨迹生成的异构加速器。',
      ],
      maximumPages: 20,
    });

    expect(result.pass).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'chinese-text-missing', 'translation-coverage-low',
    ]);
  });

  it('rejects empty pages and pathological page expansion', () => {
    const result = runPdfContentGate({
      pageTexts: ['中文标题和正文。', '', '', '', ''],
      expectedTranslations: ['中文标题和正文。'],
      maximumPages: 3,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'blank-page', 'page-count-excessive',
    ]);
  });

  it('rejects an immutable image that overflows into the reserved footer', () => {
    const result = runPdfContentGate({
      pageTexts: ['中文正文和图注。'],
      pageDrawableCounts: [10],
      pageBitmapRegions: [[{ x: 312, y: 590, w: 239, h: 164 }]],
      pageSizes: [{ width: 612, height: 792 }],
      expectedTranslations: ['中文正文和图注。'],
      maximumPages: 2,
    });

    expect(result.issues).toContainEqual({
      code: 'asset-footer-overflow',
      message: '中文 PDF 存在越过正文底线的图片，可能被页脚裁切：1',
    });
  });

  it('returns the exact overflowing bitmap regions for deterministic repair mapping', () => {
    expect(findAssetFooterOverflows([
      [
        { x: 40, y: 80, w: 200, h: 100 },
        { x: 312, y: 590, w: 239, h: 164 },
      ],
      [{ x: 30, y: 600, w: 100, h: 80 }],
    ], [
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ])).toEqual([{
      pageIndex: 0,
      rect: { x: 312, y: 590, w: 239, h: 164 },
      page: { width: 612, height: 792 },
    }]);
  });

  it('passes a readable naturally paginated Chinese paper with high translation coverage', () => {
    expect(runPdfContentGate({
      pageTexts: [
        '论文标题。摘要：零知识虚拟机是关键技术。',
        '我们提出了用于执行轨迹生成的异构加速器。图 1：工作流。',
      ],
      expectedTranslations: [
        '论文标题。',
        '零知识虚拟机是关键技术。',
        '我们提出了用于执行轨迹生成的异构加速器。',
        '图 1：工作流。',
      ],
      maximumPages: 12,
    })).toEqual({
      pass: true,
      coverage: 1,
      chineseCharacters: 40,
      issues: [],
    });
  });

  it('tolerates PDF line-breaking punctuation without accepting source-only text', () => {
    expect(runPdfContentGate({
      pageTexts: ['译文：Zero Knowledge VM Trace Generation'],
      expectedTranslations: ['译文：Zero-Knowledge VM Trace Generation。'],
      maximumPages: 3,
    }).pass).toBe(true);
    expect(runPdfContentGate({
      pageTexts: ['Zero-Knowledge VM Trace Generation'],
      expectedTranslations: ['译文：Zero-Knowledge VM Trace Generation。'],
      maximumPages: 3,
    }).pass).toBe(false);
  });
});
