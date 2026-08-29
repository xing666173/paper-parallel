import { describe, expect, it, vi } from 'vitest';
import {
  buildTargetSourcePageMap,
  parseVisionFinalPageReport,
  runVisionFinalReview,
  VISION_FINAL_REVIEW_RENDER_SCALE,
} from '../../src/core/vision/finalReview';
import { buildVisionFinalReviewPrompt } from '../../src/core/vision/prompts';
import { PdfPageRenderTimeoutError } from '../../src/core/vision/render';

describe('vision: final PDF review', () => {
  it('allows sparse natural pagination while keeping visible corruption blocking', () => {
    const prompt = buildVisionFinalReviewPrompt(8, [7, 8]);
    expect(prompt).toContain('sparse target page');
    expect(prompt).toContain('Do not call content missing merely from page density');
    expect(prompt).toContain('duplicated figure, table, formula, or algorithm');
    expect(prompt).toContain('scattered baseline text');
  });

  it('renders dense academic pages above CSS-pixel resolution for legible inspection', () => {
    expect(VISION_FINAL_REVIEW_RENDER_SCALE).toBeGreaterThanOrEqual(1.5);
  });
  it('derives failure from a confident visibly clipped finding instead of trusting a model pass flag', () => {
    const report = parseVisionFinalPageReport({
      target_page: 1,
      pass: true,
      issues: [{
        type: 'clipped_text', severity: 'severe', bbox: [0, 0, 1000, 1000],
        confidence: 0.98, evidence: 'Text strokes are cut at the page boundary.',
      }],
    }, 0);
    expect(report.pass).toBe(false);
    expect(report.issues[0]).toMatchObject({ targetPageIndex: 0, type: 'clipped_text' });
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

  it('blocks explicit garbled glyphs and high-confidence isolated rows instead of accepting a bad PDF', () => {
    const unreadable = parseVisionFinalPageReport({
      target_page: 1,
      issues: [{
        type: 'unreadable_glyphs', severity: 'warning', bbox: [1, 1, 20, 20],
        confidence: 0.7, evidence: '顶部公式符号显示为乱码',
      }],
    }, 0);
    const isolated = parseVisionFinalPageReport({
      target_page: 1,
      issues: [{
        type: 'layout_drift', severity: 'warning', bbox: [1, 1, 20, 20],
        confidence: 0.9, evidence: '页面中部出现孤立文本行',
      }],
    }, 0);

    expect(unreadable.pass).toBe(false);
    expect(unreadable.issues[0]?.severity).toBe('severe');
    expect(isolated.pass).toBe(false);
    expect(isolated.issues[0]?.severity).toBe('severe');
  });

  it('merges repeated findings with the same type and evidence', () => {
    const report = parseVisionFinalPageReport({
      target_page: 1,
      issues: Array.from({ length: 6 }, (_, index) => ({
        type: 'unreadable_glyphs', severity: 'severe',
        bbox: [75, 280 + index * 20, 180, 10], confidence: 0.9,
        evidence: '图2中部分文字模糊，难以辨认',
      })),
    }, 0);

    expect(report.issues).toHaveLength(1);
  });

  it('does not let a page-local missing-asset guess veto natural repagination', () => {
    const report = parseVisionFinalPageReport({
      target_page: 1,
      issues: [{
        type: 'asset_missing', severity: 'severe', bbox: [1, 1, 20, 20],
        confidence: 0.99, evidence: 'Source-only figure is absent here.',
      }],
    }, 0);

    expect(report.pass).toBe(true);
    expect(report.issues[0]?.severity).toBe('warning');
  });

  it('does not let page-local missing-text density guesses veto globally verified content', () => {
    const report = parseVisionFinalPageReport({
      target_page: 10,
      issues: [{
        type: 'missing_text', severity: 'severe', bbox: [1, 1, 998, 998],
        confidence: 0.99, evidence: 'Large portions of source text missing.',
      }],
    }, 9);

    expect(report.pass).toBe(true);
    expect(report.issues[0]?.severity).toBe('warning');
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

  it('keeps a valid finding when Vision omits its optional evidence sentence', () => {
    const issue = parseVisionFinalPageReport({
      target_page: 1,
      issues: [{
        type: 'overlap', severity: 'warning', bbox: [10, 20, 30, 40], confidence: 0.8,
      }],
    }, 0).issues[0];

    expect(issue?.evidence).toBe('overlap（模型未提供说明）');
  });

  it('accepts a valid JSON object wrapped in incidental model prose', () => {
    const report = parseVisionFinalPageReport(
      'Here is the requested result:\n```json\n{"target_page":1,"issues":[]}\n```\nDone.',
      0,
    );
    expect(report).toEqual({ targetPageIndex: 0, pass: true, issues: [] });
  });

  it('keeps a finding and uses a conservative full-page box when Vision returns invalid coordinates', () => {
    const issue = parseVisionFinalPageReport({
      target_page: 1,
      issues: [{
        type: 'clipped_text', severity: 'severe', bbox: [-10, 20, 1_200, 980],
        confidence: 0.95, evidence: 'Text is clipped.',
      }],
    }, 0).issues[0];

    expect(issue?.bbox).toEqual([0, 0, 1000, 1000]);
    expect(issue?.severity).toBe('severe');
  });

  it('maps naturally repaginated target pages to the two dominant aligned source pages', () => {
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
      model: 'deepseek-v4-flash-vision-exp', thinkingMode: 'disabled', responseFormat: 'json_object', stream: false,
    });
    const images = requests[0].messages[0].content.filter((part: any) => part.type === 'image_url');
    expect(images).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,source-0', detail: 'original' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,target-0', detail: 'original' } },
    ]);
    expect(renderPage).toHaveBeenCalledWith(expect.anything(), 'source', 0, expect.objectContaining({
      scale: 1.5, timeoutMs: 30_000,
    }));
    expect(requests[0].messages[0].content[0].text).toContain(
      'Do not report small or fine English labels inside verified immutable assets as unreadable merely because they are dense',
    );
  });

  it('releases a stalled page render and retries it at a lower scale before calling Vision', async () => {
    const page = {
      getViewport: () => ({ width: 1, height: 1 }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: vi.fn(),
    };
    const scales: number[] = [];
    const phases: string[] = [];
    const renderPage = vi.fn(async (
      _page: unknown,
      _role: string,
      _index: number,
      renderOptions?: { scale: number },
    ) => {
      scales.push(renderOptions?.scale ?? 0);
      if (scales.length === 1) throw new PdfPageRenderTimeoutError(30_000);
      return 'data:image/png;base64,page';
    });

    const report = await runVisionFinalReview({
      sourcePdf: { numPages: 1, getPage: async () => page },
      targetPdf: { numPages: 1, getPage: async () => page },
      manifest: { units: [] } as any,
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test',
      renderPage,
      onPagePhase: (event) => phases.push(event.phase),
      complete: async () => ({
        content: '{"target_page":1,"issues":[]}',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    });

    expect(report).toMatchObject({ pass: true, reviewedPages: 1 });
    expect(scales).toEqual([1.5, 1, 1.5]);
    expect(phases).toContain('render-retrying');
    expect(phases).toContain('rendered');
    expect(page.cleanup).toHaveBeenCalled();
  });

  it('requires a focused second review before a severe visual guess can block the PDF', async () => {
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
        return requests.length === 1
          ? {
            content: JSON.stringify({
              target_page: 1,
              issues: [{
                type: 'clipped_text', severity: 'severe', bbox: [50, 60, 450, 40],
                confidence: 0.9, evidence: 'Acknowledgement text clipped at top left',
              }],
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          }
          : { content: '{"target_page":1,"issues":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[1].messages[0].content[0].text).toContain('glyph strokes are visibly cut');
    expect(report.pass).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('still blocks a severe defect that the focused second review confirms', async () => {
    const requests: any[] = [];
    const page = { getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }) };
    const severe = JSON.stringify({
      target_page: 1,
      issues: [{
        type: 'overlap', severity: 'severe', bbox: [100, 200, 400, 200],
        confidence: 0.95, evidence: 'Body text overlaps the figure',
      }],
    });
    const report = await runVisionFinalReview({
      sourcePdf: { numPages: 1, getPage: async () => page },
      targetPdf: { numPages: 1, getPage: async () => page },
      manifest: { units: [] } as any,
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test',
      renderPage: async () => 'data:image/png;base64,page',
      complete: async (request: any) => {
        requests.push(request);
        return { content: severe, usage: { promptTokens: 1, completionTokens: 1 } };
      },
    });

    expect(requests).toHaveLength(2);
    expect(report.pass).toBe(false);
    expect(report.issues).toHaveLength(1);
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

  it('retries a malformed visual JSON report once with the compact request', async () => {
    const requests: any[] = [];
    const invalidReasons: string[] = [];
    const phases: string[] = [];
    const page = { getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }) };
    const report = await runVisionFinalReview({
      sourcePdf: { numPages: 1, getPage: async () => page },
      targetPdf: { numPages: 1, getPage: async () => page },
      manifest: { units: [] } as any,
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test',
      renderPage: async () => 'data:image/png;base64,page',
      onPageInvalid: ({ reason }) => invalidReasons.push(reason),
      onPagePhase: ({ phase }) => phases.push(phase),
      complete: async (request: any) => {
        requests.push(request);
        return requests.length === 1
          ? { content: '{not-json', usage: { promptTokens: 1, completionTokens: 1 } }
          : { content: '{"target_page":1,"issues":[]}', usage: { promptTokens: 1, completionTokens: 1 } };
      },
    });

    expect(report.pass).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[0].content[0].text).toContain('at most 3 severe issues');
    expect(invalidReasons).toEqual(['Vision 成品质检 JSON 无法解析']);
    expect(phases).toContain('retrying');
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

  it('marks an entirely unreviewed document as failed after its page deadline', async () => {
    const page = { getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }) };
    const report = await runVisionFinalReview({
      sourcePdf: { numPages: 1, getPage: async () => page },
      targetPdf: { numPages: 1, getPage: async () => page },
      manifest: { units: [] } as any,
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test',
      pageTimeoutMs: 20,
      renderPage: async () => 'data:image/png;base64,page',
      onPageTimeout: () => { throw new Error('diagnostic callback failed'); },
      complete: async () => new Promise(() => undefined),
    });

    expect(report).toMatchObject({ pass: false, reviewedPages: 0 });
    expect(report.issues).toEqual([expect.objectContaining({
      type: 'review_incomplete', severity: 'severe', targetPageIndex: 0,
    })]);
  });

  it('continues after one timed-out page when the rest of the document is reviewed', async () => {
    const page = { getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }) };
    let calls = 0;
    const report = await runVisionFinalReview({
      sourcePdf: { numPages: 3, getPage: async () => page },
      targetPdf: { numPages: 3, getPage: async () => page },
      manifest: { units: [] } as any,
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test',
      pageTimeoutMs: 20,
      renderPage: async () => 'data:image/png;base64,page',
      complete: async (request: any) => {
        calls += 1;
        if (calls === 1) return new Promise(() => undefined);
        const targetPage = Number(request.messages[0].content[0].text.match(/translated target page (\d+)/)?.[1] ?? '0');
        return {
          content: JSON.stringify({ target_page: targetPage, issues: [] }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    });

    expect(report).toMatchObject({ pass: true, reviewedPages: 2 });
    expect(report.issues).toEqual([expect.objectContaining({
      type: 'review_incomplete', severity: 'warning', targetPageIndex: 0,
    })]);
  });
});
