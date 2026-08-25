import { describe, expect, it, vi } from 'vitest';
import { analyzePdfLayoutWithVision } from '../../src/core/vision/analyze';

describe('vision: pre-layout analysis', () => {
  it('always uses Vision Exp with thinking disabled and original image detail', async () => {
    const requests: any[] = [];
    const complete = vi.fn(async (request: any) => {
      requests.push(request);
      return { content: '{"page":1,"layout":"double","regions":[]}', usage: { promptTokens: 10, completionTokens: 3 } };
    });
    const page = { getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }) };

    const result = await analyzePdfLayoutWithVision({
      pdf: { numPages: 1, getPage: async () => page },
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', fileHash: 'sha256:paper',
      complete, renderPage: async () => 'data:image/png;base64,PAGE',
    });

    expect(result).toEqual([{ pageIndex: 0, layout: 'double', regions: [] }]);
    expect(requests[0]).toMatchObject({
      model: 'deepseek-v4-flash-vision-exp', thinkingMode: 'disabled', responseFormat: 'json_object',
    });
    expect(requests[0].messages[0].content[1]).toEqual({
      type: 'image_url', image_url: { url: 'data:image/png;base64,PAGE', detail: 'original' },
    });
  });

  it('uses a validated per-page cache without rendering or calling the API', async () => {
    const complete = vi.fn();
    const renderPage = vi.fn();
    const result = await analyzePdfLayoutWithVision({
      pdf: { numPages: 1, getPage: vi.fn() },
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', fileHash: 'sha256:paper',
      complete, renderPage,
      loadCached: async () => ({ page: 1, layout: 'single', regions: [] }),
    });

    expect(result[0]?.layout).toBe('single');
    expect(renderPage).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('analyzes at most two pages concurrently, reports starts, and returns page order', async () => {
    const page = { getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }) };
    const resolvers: Array<() => void> = [];
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const run = analyzePdfLayoutWithVision({
      pdf: { numPages: 3, getPage: async () => page },
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', fileHash: 'sha256:paper',
      renderPage: async () => 'data:image/png;base64,PAGE',
      onPageStart: ({ pageIndex }) => started.push(pageIndex),
      complete: async (request: any) => {
        const pageNumber = Number(request.messages[0].content[0].text.match(/source page (\d+)/)?.[1] ?? '0');
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => resolvers.push(resolve));
        active -= 1;
        return {
          content: JSON.stringify({ page: pageNumber, layout: 'single', regions: [] }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    resolvers[0]!();
    resolvers[2]!();

    expect((await run).map((analysis) => analysis.pageIndex)).toEqual([0, 1, 2]);
    expect(maxActive).toBe(2);
  });
});
