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

  it('accepts explicit normalized xywh issue boxes', () => {
    expect(parseVisionFinalPageReport({
      target_page: 1,
      issues: [{
        type: 'clipped_text', severity: 'warning',
        bbox: { x: 100, y: 200, width: 300, height: 40 },
        confidence: 0.9, evidence: 'Possible clipping.',
      }],
    }, 0).issues[0]?.bbox).toEqual([100, 200, 300, 40]);
  });

  it('maps naturally repaginated target pages to the single dominant aligned source page', () => {
    const mapping = buildTargetSourcePageMap({
      units: [
        { source: [{ page: 0, rects: [{}] }], target: [{ page: 0, rects: [{}] }] },
        { source: [{ page: 1, rects: [{}] }], target: [{ page: 0, rects: [{}, {}] }] },
        { source: [{ page: 2, rects: [{}] }], target: [{ page: 1, rects: [{}] }] },
      ],
    } as any, 2, 3);
    expect(mapping).toEqual([[1], [2]]);
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
      { type: 'image_url', image_url: { url: 'data:image/png;base64,target-0', detail: 'original' } },
    ]);
    expect(renderPage).not.toHaveBeenCalledWith(expect.anything(), 'source', expect.anything());
  });

  it('retries an overlong visual report with a compact severe-only request', async () => {
    const requests: any[] = [];
    const page = { getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }) };
    const report = await runVisionFinalReview({
      sourcePdf: { numPages: 1, getPage: async () => page },
      targetPdf: { numPages: 1, getPage: async () => page },
      manifest: { units: [] } as any,
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test',
      renderPage: async () => 'data:image/png;base64,page',
      complete: async (request: any) => {
        requests.push(request);
        if (requests.length === 1) {
          const error = new Error('finish_reason=length');
          error.name = 'DeepSeekOutputLimitError';
          throw error;
        }
        return { content: '{"target_page":1,"issues":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
      },
    });

    expect(report.pass).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[0].content[0].text).toContain('at most 3 severe issues');
  });

  it('reviews heavy multimodal pages sequentially, reports starts immediately, and preserves page order', async () => {
    const page = { getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }) };
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];
    const completed: number[] = [];
    const run = runVisionFinalReview({
      sourcePdf: { numPages: 3, getPage: async () => page },
      targetPdf: { numPages: 3, getPage: async () => page },
      manifest: { units: [] } as any,
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test',
      renderPage: async (_page, role, index) => `data:image/png;base64,${role}-${index}`,
      onPageStart: ({ targetPageIndex }) => started.push(targetPageIndex),
      onPage: ({ targetPageIndex }) => completed.push(targetPageIndex),
      complete: async (request: any) => {
        const targetPage = Number(request.messages[0].content[0].text.match(/translated target page (\d+)/)?.[1] ?? '0');
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => resolvers.push(resolve));
        active -= 1;
        return {
          content: JSON.stringify({
            target_page: targetPage,
            issues: [{
              type: 'layout_drift', severity: 'warning', bbox: [0, 0, 10, 10],
              confidence: 0.9, evidence: `page-${targetPage}`,
            }],
          }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    });

    await vi.waitFor(() => expect(started).toEqual([0]));
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0]!();
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[2]!();

    const report = await run;
    expect(maxActive).toBe(1);
    expect(completed).toEqual([0, 1, 2]);
    expect(report.issues.map((issue) => issue.evidence)).toEqual(['page-1', 'page-2', 'page-3']);
  });

  it('enforces a hard total deadline for each reviewed page', async () => {
    const page = { getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }) };
    await expect(runVisionFinalReview({
      sourcePdf: { numPages: 1, getPage: async () => page },
      targetPdf: { numPages: 1, getPage: async () => page },
      manifest: { units: [] } as any,
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test',
      pageTimeoutMs: 20,
      renderPage: async () => 'data:image/png;base64,page',
      onPageTimeout: () => { throw new Error('diagnostic callback failed'); },
      complete: async () => new Promise(() => undefined),
    })).rejects.toThrow('第 1/1 页超过 1 秒');
  });
});
