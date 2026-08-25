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
});
