import { describe, expect, it } from 'vitest';
import { runPdfContentGate } from '../../src/core/quality/pdfContentGate';

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
});
