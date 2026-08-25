import { describe, expect, it, vi } from 'vitest';
import {
  buildTargetSourcePageMap,
  parseVisionFinalPageReport,
  runVisionFinalReview,
} from '../../src/core/vision/finalReview';

describe('vision: final PDF review', () => {
  it('derives failure from a confident severe finding instead of trusting a model pass flag', () => {
    const report = parseVisionFinalPageReport({
      target_page: 1,
      pass: true,
      issues: [{
        type: 'missing_text', severity: 'severe', bbox: [0, 0, 1000, 1000],
        confidence: 0.98, evidence: 'The target page is blank.',
      }],
    }, 0);
    expect(report.pass).toBe(false);
    expect(report.issues[0]).toMatchObject({ targetPageIndex: 0, type: 'missing_text' });
  });

  it('does not block on warnings or low-confidence severe guesses', () => {
    expect(parseVisionFinalPageReport({
      target_page: 2,
      issues: [
        { type: 'layout_drift', severity: 'warning', bbox: [1, 1, 20, 20], confidence: 0.99, evidence: 'Minor spacing.' },
        { type: 'asset_changed', severity: 'severe', bbox: [1, 1, 20, 20], confidence: 0.5, evidence: 'Uncertain.' },
      ],
    }, 1).pass).toBe(true);
  });

  it('maps naturally repaginated target pages to the dominant aligned source pages', () => {
    const mapping = buildTargetSourcePageMap({
      units: [
        { source: [{ page: 0, rects: [{}] }], target: [{ page: 0, rects: [{}] }] },
        { source: [{ page: 1, rects: [{}] }], target: [{ page: 0, rects: [{}, {}] }] },
        { source: [{ page: 2, rects: [{}] }], target: [{ page: 1, rects: [{}] }] },
      ],
    } as any, 2, 3);
    expect(mapping).toEqual([[1, 0], [2]]);
  });

  it('reviews source/target images with Vision Exp, thinking disabled and original detail', async () => {
    const requests: any[] = [];
    const page = { getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }) };
    const renderPage = vi.fn(async (_page: unknown, role: string, index: number) => `data:image/png;base64,${role}-${index}`);
    const report = await runVisionFinalReview({
      sourcePdf: { numPages: 1, getPage: async () => page },
      targetPdf: { numPages: 1, getPage: async () => page },
      manifest: { units: [] } as any,
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test',
      renderPage,
      complete: async (request: any) => {
        requests.push(request);
        return { content: '{"target_page":1,"issues":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
      },
    });

    expect(report).toEqual({ pass: true, issues: [], reviewedPages: 1 });
    expect(requests[0]).toMatchObject({
      model: 'deepseek-v4-flash-vision-exp', thinkingMode: 'disabled', responseFormat: 'json_object',
    });
    const images = requests[0].messages[0].content.filter((part: any) => part.type === 'image_url');
    expect(images).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,source-0', detail: 'original' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,target-0', detail: 'original' } },
    ]);
  });
});
