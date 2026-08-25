import { chatCompletion, type ChatCompletionOptions, type ChatCompletionResult } from '../translate/client';
import { buildVisionLayoutCacheKey } from '../project/cacheKey';
import { parseVisionPageAnalysis, type VisionPageAnalysis } from './protocol';
import { buildVisionLayoutPrompt, VISION_LAYOUT_PROMPT_VERSION } from './prompts';
import { renderPdfPageAsPng, type PdfPageForVision } from './render';

export const VISION_LAYOUT_MODEL = 'deepseek-v4-flash-vision-exp';
export const VISION_RENDER_VERSION = 'pdfjs-2x-white-v1';

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
  renderPage?: (page: PdfPageForVision) => Promise<string>;
  loadCached?(key: string, pageIndex: number): Promise<unknown | undefined>;
  saveCached?(key: string, pageIndex: number, analysis: VisionPageAnalysis): Promise<void>;
  onPage?(event: { pageIndex: number; totalPages: number; cached: boolean }): void;
}

export async function analyzePdfLayoutWithVision(options: AnalyzePdfLayoutOptions): Promise<VisionPageAnalysis[]> {
  if (!options.apiKey.trim()) throw new Error('Vision Exp 版式识别需要 DeepSeek API Key');
  const complete = options.complete ?? chatCompletion;
  const renderPage = options.renderPage ?? ((page) => renderPdfPageAsPng(page));
  const results: VisionPageAnalysis[] = [];

  for (let pageIndex = 0; pageIndex < options.pdf.numPages; pageIndex += 1) {
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
      results.push(analysis);
      options.onPage?.({ pageIndex, totalPages: options.pdf.numPages, cached: true });
      continue;
    }

    const page = await options.pdf.getPage(pageIndex + 1);
    const imageUrl = await renderPage(page);
    const completion = await complete({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: VISION_LAYOUT_MODEL,
      thinkingMode: 'disabled',
      responseFormat: 'json_object',
      maxTokens: 8_192,
      timeoutMs: 120_000,
      signal: options.signal,
      messages: [{ role: 'user', content: [
        { type: 'text', text: buildVisionLayoutPrompt(pageIndex + 1) },
        { type: 'image_url', image_url: { url: imageUrl, detail: 'original' } },
      ] }],
    });
    const analysis = parseVisionPageAnalysis(completion.content, pageIndex);
    await options.saveCached?.(cacheKey, pageIndex, analysis);
    results.push(analysis);
    options.onPage?.({ pageIndex, totalPages: options.pdf.numPages, cached: false });
  }
  return results;
}
