import { chatCompletion, type ChatCompletionOptions, type ChatCompletionResult } from '../translate/client';
import { buildVisionLayoutCacheKey } from '../project/cacheKey';
import { parseVisionPageAnalysis, type VisionPageAnalysis } from './protocol';
import { buildVisionLayoutPrompt, VISION_LAYOUT_PROMPT_VERSION } from './prompts';
import {
  PdfPageRenderTimeoutError,
  renderPdfPageAsPng,
  type PdfPageForVision,
  type RenderPdfPageOptions,
} from './render';

export const VISION_LAYOUT_MODEL = 'deepseek-v4-flash-vision-exp';
export const VISION_RENDER_VERSION = 'pdfjs-2x-white-v1';
export const VISION_LAYOUT_RENDER_SCALE = 2;
export const VISION_LAYOUT_FALLBACK_RENDER_SCALE = 1.25;
export const VISION_LAYOUT_LAST_RESORT_RENDER_SCALE = 0.8;
export const VISION_LAYOUT_RENDER_TIMEOUT_MS = 30_000;

export interface PdfDocumentForVision {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageForVision>;
}

export interface AnalyzePdfLayoutOptions {
  pdf: PdfDocumentForVision;
  baseUrl: string;
  apiKey: string;
  fileHash: string;
  signal?: AbortSignal;
  complete?: (options: ChatCompletionOptions) => Promise<ChatCompletionResult>;
  renderPage?: (page: PdfPageForVision, options?: RenderPdfPageOptions) => Promise<string>;
  loadCached?(key: string, pageIndex: number): Promise<unknown | undefined>;
  saveCached?(key: string, pageIndex: number, analysis: VisionPageAnalysis): Promise<void>;
  onPageStart?(event: { pageIndex: number; totalPages: number }): void;
  onPagePhase?(event: {
    pageIndex: number;
    totalPages: number;
    phase: 'render-retrying';
  }): void;
  onPage?(event: { pageIndex: number; totalPages: number; cached: boolean }): void;
}

export const VISION_LAYOUT_CONCURRENCY = 2;

export async function analyzePdfLayoutWithVision(options: AnalyzePdfLayoutOptions): Promise<VisionPageAnalysis[]> {
  if (!options.apiKey.trim()) throw new Error('Vision Exp 版式识别需要 DeepSeek API Key');
  const complete = options.complete ?? chatCompletion;
  const renderPage = options.renderPage ?? ((page, renderOptions) => renderPdfPageAsPng(page, renderOptions));
  const results: VisionPageAnalysis[] = Array.from({ length: options.pdf.numPages });
  // PDF.js can stall when multiple large page canvases are rasterized at once,
  // especially after several pages. Keep rasterization serial while allowing the
  // two Vision API requests to overlap after their images have been produced.
  let renderTail = Promise.resolve();
  const serializeRender = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = renderTail;
    let release!: () => void;
    renderTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const renderLayoutPage = async (pageIndex: number): Promise<string> => serializeRender(async () => {
    const renderAttempt = async (scale: number): Promise<string> => {
      if (options.signal?.aborted) throw new DOMException('已停止', 'AbortError');
      const page = await options.pdf.getPage(pageIndex + 1);
      try {
        return await renderPage(page, {
          scale,
          signal: options.signal,
          timeoutMs: VISION_LAYOUT_RENDER_TIMEOUT_MS,
        });
      } finally {
        try { page.cleanup?.(); } catch { /* release is best-effort */ }
      }
    };

    const scales = [
      VISION_LAYOUT_RENDER_SCALE,
      VISION_LAYOUT_FALLBACK_RENDER_SCALE,
      VISION_LAYOUT_LAST_RESORT_RENDER_SCALE,
    ];
    let lastTimeout: PdfPageRenderTimeoutError | undefined;
    for (const [index, scale] of scales.entries()) {
      try {
        return await renderAttempt(scale);
      } catch (error) {
        if (!(error instanceof PdfPageRenderTimeoutError) || options.signal?.aborted) throw error;
        lastTimeout = error;
        if (index === scales.length - 1) break;
        options.onPagePhase?.({
          pageIndex,
          totalPages: options.pdf.numPages,
          phase: 'render-retrying',
        });
      }
    }
    throw lastTimeout ?? new PdfPageRenderTimeoutError(VISION_LAYOUT_RENDER_TIMEOUT_MS);
  });

  const analyzePage = async (pageIndex: number): Promise<void> => {
    if (options.signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const cacheKey = buildVisionLayoutCacheKey({
      fileHash: options.fileHash,
      pageIndex,
      modelId: VISION_LAYOUT_MODEL,
      promptVersion: VISION_LAYOUT_PROMPT_VERSION,
      renderVersion: VISION_RENDER_VERSION,
    });
    const cached = await options.loadCached?.(cacheKey, pageIndex);
    if (cached !== undefined) {
      const analysis = parseVisionPageAnalysis(cached, pageIndex);
      results[pageIndex] = analysis;
      options.onPage?.({ pageIndex, totalPages: options.pdf.numPages, cached: true });
      return;
    }

    options.onPageStart?.({ pageIndex, totalPages: options.pdf.numPages });
    const imageUrl = await renderLayoutPage(pageIndex);
    const completion = await complete({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: VISION_LAYOUT_MODEL,
      thinkingMode: 'disabled',
      responseFormat: 'json_object',
      maxTokens: 2_048,
      timeoutMs: 90_000,
      signal: options.signal,
      messages: [{ role: 'user', content: [
        { type: 'text', text: buildVisionLayoutPrompt(pageIndex + 1) },
        { type: 'image_url', image_url: { url: imageUrl, detail: 'original' } },
      ] }],
    });
    const analysis = parseVisionPageAnalysis(completion.content, pageIndex);
    await options.saveCached?.(cacheKey, pageIndex, analysis);
    results[pageIndex] = analysis;
    options.onPage?.({ pageIndex, totalPages: options.pdf.numPages, cached: false });
  };

  let nextPageIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextPageIndex < options.pdf.numPages) {
      const pageIndex = nextPageIndex;
      nextPageIndex += 1;
      await analyzePage(pageIndex);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(VISION_LAYOUT_CONCURRENCY, options.pdf.numPages) },
    () => worker(),
  ));
  if (options.signal?.aborted) {
    throw new DOMException('已停止', 'AbortError');
  }
  return results;
}
