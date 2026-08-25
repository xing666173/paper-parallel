import type { AlignmentManifest } from '../align/manifest';
import { chatCompletion, type ChatCompletionOptions, type ChatCompletionResult } from '../translate/client';
import { buildVisionFinalReviewPrompt } from './prompts';
import { renderPdfPageAsPng, type PdfPageForVision } from './render';
import { VISION_LAYOUT_MODEL, type PdfDocumentForVision } from './analyze';
import { parseNormalizedVisionBox } from './protocol';

export type VisionFinalIssueType =
  | 'missing_text' | 'clipped_text' | 'overlap' | 'unreadable_glyphs'
  | 'untranslated_body' | 'layout_collapse' | 'layout_drift'
  | 'asset_changed' | 'asset_missing' | 'formula_changed' | 'table_changed';

export interface VisionFinalIssue {
  targetPageIndex: number;
  type: VisionFinalIssueType;
  severity: 'severe' | 'warning';
  bbox: [number, number, number, number];
  confidence: number;
  evidence: string;
}

export interface VisionFinalPageReport {
  targetPageIndex: number;
  pass: boolean;
  issues: VisionFinalIssue[];
}

export interface VisionFinalReport {
  pass: boolean;
  issues: VisionFinalIssue[];
  reviewedPages: number;
}

function rootObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    try { parsed = JSON.parse(fenced ? fenced[1] : trimmed); } catch { throw new Error('Vision 成品质检 JSON 无法解析'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Vision 成品质检 JSON 必须为对象');
  return parsed as Record<string, unknown>;
}

const ISSUE_TYPES: readonly VisionFinalIssueType[] = [
  'missing_text', 'clipped_text', 'overlap', 'unreadable_glyphs', 'untranslated_body',
  'layout_collapse', 'layout_drift', 'asset_changed', 'asset_missing', 'formula_changed', 'table_changed',
];

export function parseVisionFinalPageReport(value: unknown, expectedTargetPageIndex: number): VisionFinalPageReport {
  const root = rootObject(value);
  if (!Number.isInteger(root.target_page) || root.target_page !== expectedTargetPageIndex + 1) {
    throw new Error('Vision 成品质检 target_page 与请求页面不一致');
  }
  if (!Array.isArray(root.issues)) throw new Error('Vision 成品质检 issues 必须为数组');
  const issues = root.issues.map((raw, index): VisionFinalIssue => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Vision 成品质检 issues[${index}] 必须为对象`);
    const item = raw as Record<string, unknown>;
    if (typeof item.type !== 'string' || !ISSUE_TYPES.includes(item.type as VisionFinalIssueType)) {
      throw new Error(`Vision 成品质检 issues[${index}].type 无效`);
    }
    if (item.severity !== 'severe' && item.severity !== 'warning') throw new Error(`Vision 成品质检 issues[${index}].severity 无效`);
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new Error(`Vision 成品质检 issues[${index}].confidence 无效`);
    }
    if (typeof item.evidence !== 'string' || !item.evidence.trim()) throw new Error(`Vision 成品质检 issues[${index}].evidence 缺失`);
    return {
      targetPageIndex: expectedTargetPageIndex,
      type: item.type as VisionFinalIssueType,
      severity: item.severity,
      bbox: parseNormalizedVisionBox(item.bbox, `issues[${index}].bbox`),
      confidence: item.confidence,
      evidence: item.evidence.trim().slice(0, 300),
    };
  });
  return {
    targetPageIndex: expectedTargetPageIndex,
    pass: !issues.some((issue) => issue.severity === 'severe' && issue.confidence >= 0.8),
    issues,
  };
}

export function buildTargetSourcePageMap(
  manifest: AlignmentManifest,
  targetPageCount: number,
  sourcePageCount: number,
): number[][] {
  return Array.from({ length: targetPageCount }, (_, targetPageIndex) => {
    const scores = new Map<number, number>();
    for (const unit of manifest.units) {
      const target = unit.target.find((set) => set.page === targetPageIndex);
      if (!target) continue;
      for (const source of unit.source) {
        scores.set(source.page, (scores.get(source.page) ?? 0) + Math.max(1, target.rects.length) * Math.max(1, source.rects.length));
      }
    }
    const ranked = [...scores.entries()]
      .filter(([page]) => page >= 0 && page < sourcePageCount)
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 2)
      .map(([page]) => page);
    if (ranked.length) return ranked;
    return [Math.min(sourcePageCount - 1, Math.floor(targetPageIndex / Math.max(1, targetPageCount) * sourcePageCount))];
  });
}

export interface RunVisionFinalReviewOptions {
  sourcePdf: PdfDocumentForVision;
  targetPdf: PdfDocumentForVision;
  manifest: AlignmentManifest;
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  complete?: (options: ChatCompletionOptions) => Promise<ChatCompletionResult>;
  renderPage?: (page: PdfPageForVision, role: 'source' | 'target', pageIndex: number) => Promise<string>;
  onPageStart?(event: { targetPageIndex: number; totalPages: number }): void;
  onPage?(event: { targetPageIndex: number; totalPages: number; issueCount: number }): void;
}

export const VISION_FINAL_REVIEW_CONCURRENCY = 2;

export async function runVisionFinalReview(options: RunVisionFinalReviewOptions): Promise<VisionFinalReport> {
  if (!options.apiKey.trim()) throw new Error('Vision Exp 成品质检需要 DeepSeek API Key');
  const complete = options.complete ?? chatCompletion;
  const renderPage = options.renderPage ?? ((page) => renderPdfPageAsPng(page));
  const mapping = buildTargetSourcePageMap(options.manifest, options.targetPdf.numPages, options.sourcePdf.numPages);
  const sourceImages = new Map<number, Promise<string>>();
  const pageIssues: VisionFinalIssue[][] = Array.from({ length: options.targetPdf.numPages }, () => []);

  const getSourceImage = (sourcePageIndex: number): Promise<string> => {
    const cached = sourceImages.get(sourcePageIndex);
    if (cached) return cached;
    const rendered = options.sourcePdf.getPage(sourcePageIndex + 1)
      .then((page) => renderPage(page, 'source', sourcePageIndex));
    sourceImages.set(sourcePageIndex, rendered);
    return rendered;
  };

  const reviewPage = async (targetPageIndex: number): Promise<void> => {
    if (options.signal?.aborted) throw new DOMException('已停止', 'AbortError');
    options.onPageStart?.({ targetPageIndex, totalPages: options.targetPdf.numPages });
    const sourcePageIndices = mapping[targetPageIndex]!;
    const content: NonNullable<ChatCompletionOptions['messages'][number]['content']> extends infer _T ? any[] : never = [
      { type: 'text', text: buildVisionFinalReviewPrompt(targetPageIndex + 1, sourcePageIndices.map((page) => page + 1)) },
    ];
    for (const sourcePageIndex of sourcePageIndices) {
      const image = await getSourceImage(sourcePageIndex);
      content.push({ type: 'text', text: `SOURCE PAGE ${sourcePageIndex + 1}` });
      content.push({ type: 'image_url', image_url: { url: image, detail: 'original' } });
    }
    const targetImage = await renderPage(await options.targetPdf.getPage(targetPageIndex + 1), 'target', targetPageIndex);
    content.push({ type: 'text', text: `TARGET PAGE ${targetPageIndex + 1}` });
    content.push({ type: 'image_url', image_url: { url: targetImage, detail: 'original' } });
    const requestReview = (compact: boolean) => complete({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: VISION_LAYOUT_MODEL,
      thinkingMode: 'disabled',
      responseFormat: 'json_object',
      maxTokens: compact ? 1_024 : 2_048,
      timeoutMs: 90_000,
      signal: options.signal,
      messages: [{ role: 'user', content: [
        { type: 'text', text: buildVisionFinalReviewPrompt(
          targetPageIndex + 1,
          sourcePageIndices.map((page) => page + 1),
          compact,
        ) },
        ...content.slice(1),
      ] }],
    });
    let completion: ChatCompletionResult;
    try {
      completion = await requestReview(false);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'DeepSeekOutputLimitError') throw error;
      completion = await requestReview(true);
    }
    const pageReport = parseVisionFinalPageReport(completion.content, targetPageIndex);
    pageIssues[targetPageIndex] = pageReport.issues;
    options.onPage?.({ targetPageIndex, totalPages: options.targetPdf.numPages, issueCount: pageReport.issues.length });
  };

  let nextTargetPageIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextTargetPageIndex < options.targetPdf.numPages) {
      const targetPageIndex = nextTargetPageIndex;
      nextTargetPageIndex += 1;
      await reviewPage(targetPageIndex);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(VISION_FINAL_REVIEW_CONCURRENCY, options.targetPdf.numPages) },
    () => worker(),
  ));
  const issues = pageIssues.flat();

  if (options.signal?.aborted) {
    throw new DOMException('已停止', 'AbortError');
  }
  return {
    pass: !issues.some((issue) => issue.severity === 'severe' && issue.confidence >= 0.8),
    issues,
    reviewedPages: options.targetPdf.numPages,
  };
}
