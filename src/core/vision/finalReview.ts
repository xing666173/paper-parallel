import type { AlignmentManifest } from '../align/manifest';
import { chatCompletion, type ChatCompletionOptions, type ChatCompletionResult } from '../translate/client';
import { buildVisionFinalConfirmationPrompt, buildVisionFinalReviewPrompt } from './prompts';
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
  const parsedIssues = root.issues.map((raw, index): VisionFinalIssue => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Vision 成品质检 issues[${index}] 必须为对象`);
    const item = raw as Record<string, unknown>;
    if (typeof item.type !== 'string' || !ISSUE_TYPES.includes(item.type as VisionFinalIssueType)) {
      throw new Error(`Vision 成品质检 issues[${index}].type 无效`);
    }
    if (item.severity !== 'severe' && item.severity !== 'warning') throw new Error(`Vision 成品质检 issues[${index}].severity 无效`);
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new Error(`Vision 成品质检 issues[${index}].confidence 无效`);
    }
    const evidence = typeof item.evidence === 'string' && item.evidence.trim()
      ? item.evidence.trim().slice(0, 300)
      : `${item.type}（模型未提供说明）`;
    let bbox: [number, number, number, number];
    try {
      bbox = parseNormalizedVisionBox(item.bbox, `issues[${index}].bbox`);
    } catch {
      bbox = [0, 0, 1000, 1000];
    }
    return {
      targetPageIndex: expectedTargetPageIndex,
      type: item.type as VisionFinalIssueType,
      // Asset markers and source hashes are checked deterministically before
      // this page review. With natural repagination, a source-page asset can
      // legitimately appear on an adjacent target page, so a page-local
      // "missing" guess must not veto the whole document.
      severity: item.type === 'asset_missing' ? 'warning' : item.severity,
      bbox,
      confidence: item.confidence,
      evidence,
    };
  });
  const seen = new Set<string>();
  const issues = parsedIssues.filter((issue) => {
    const key = `${issue.type}\u0000${issue.evidence.trim().toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
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
      .slice(0, 1)
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
  pageTimeoutMs?: number;
  complete?: (options: ChatCompletionOptions) => Promise<ChatCompletionResult>;
  renderPage?: (page: PdfPageForVision, role: 'source' | 'target', pageIndex: number) => Promise<string>;
  onPageStart?(event: { targetPageIndex: number; totalPages: number }): void;
  onPagePhase?(event: {
    targetPageIndex: number; totalPages: number;
    phase: 'rendered' | 'connected' | 'content' | 'retrying' | 'returned';
  }): void;
  onPageInvalid?(event: { targetPageIndex: number; totalPages: number; reason: string }): void;
  onPageWait?(event: { targetPageIndex: number; totalPages: number; elapsedMs: number }): void;
  onPageTimeout?(event: { targetPageIndex: number; totalPages: number; timeoutMs: number }): void;
  onPage?(event: { targetPageIndex: number; totalPages: number; issueCount: number }): void;
}

export const VISION_FINAL_REVIEW_CONCURRENCY = 1;
export const VISION_FINAL_REVIEW_PAGE_TIMEOUT_MS = 90_000;
export const VISION_FINAL_REVIEW_RENDER_SCALE = 1.5;

async function withPageDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  outerSignal: AbortSignal,
  pageIndex: number,
  totalPages: number,
  timeoutMs: number,
  onTimeout?: () => void,
  onWait?: (elapsedMs: number) => void,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = () => new Error(
    `Vision Exp 成品质检第 ${pageIndex + 1}/${totalPages} 页超过 ${Math.ceil(timeoutMs / 1_000)} 秒，已取消该页请求`,
  );
  const onOuterAbort = () => controller.abort();
  if (outerSignal.aborted) controller.abort();
  else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const startedAt = clock();
  let lastReportedWait = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setInterval(() => {
      const elapsedMs = clock() - startedAt;
      const waitBucket = Math.floor(elapsedMs / 15_000);
      if (waitBucket > lastReportedWait) {
        lastReportedWait = waitBucket;
        try { onWait?.(elapsedMs); } catch { /* diagnostics must never disable the watchdog */ }
      }
      if (elapsedMs < timeoutMs) return;
      timedOut = true;
      controller.abort();
      reject(timeoutError());
      try { onTimeout?.(); } catch { /* cancellation already happened */ }
    }, Math.min(1_000, Math.max(10, timeoutMs)));
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    if (timedOut) throw timeoutError();
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

export async function runVisionFinalReview(options: RunVisionFinalReviewOptions): Promise<VisionFinalReport> {
  if (!options.apiKey.trim()) throw new Error('Vision Exp 成品质检需要 DeepSeek API Key');
  const complete = options.complete ?? chatCompletion;
  const renderPage = options.renderPage
    ?? ((page) => renderPdfPageAsPng(page, { scale: VISION_FINAL_REVIEW_RENDER_SCALE }));
  const pageIssues: VisionFinalIssue[][] = Array.from({ length: options.targetPdf.numPages }, () => []);
  const runController = new AbortController();
  const onOuterAbort = () => runController.abort();
  if (options.signal?.aborted) runController.abort();
  else options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const runSignal = runController.signal;
  const performPageReview = async (targetPageIndex: number, pageSignal: AbortSignal): Promise<void> => {
    if (pageSignal.aborted) throw new DOMException('已停止', 'AbortError');
    options.onPageStart?.({ targetPageIndex, totalPages: options.targetPdf.numPages });
    // Cross-page source/target image pairs are ambiguous after natural Chinese
    // repagination. Immutable assets are checked by hash and alignment markers;
    // this pass inspects the rendered target page for visible production defects.
    const sourcePageIndices: number[] = [];
    const content: NonNullable<ChatCompletionOptions['messages'][number]['content']> extends infer _T ? any[] : never = [
      { type: 'text', text: buildVisionFinalReviewPrompt(targetPageIndex + 1, sourcePageIndices.map((page) => page + 1)) },
    ];
    const targetImage = await renderPage(await options.targetPdf.getPage(targetPageIndex + 1), 'target', targetPageIndex);
    options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'rendered' });
    content.push({ type: 'text', text: `TARGET PAGE ${targetPageIndex + 1}` });
    content.push({ type: 'image_url', image_url: { url: targetImage, detail: 'original' } });
    const requestReview = (compact: boolean) => {
      let contentReported = false;
      return complete({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: VISION_LAYOUT_MODEL,
      thinkingMode: 'disabled',
      responseFormat: 'json_object',
      stream: false,
      maxTokens: compact ? 384 : 768,
      timeoutMs: 30_000,
      hardTimeoutMs: compact ? 30_000 : 45_000,
      signal: pageSignal,
      onStreamProgress: (progress) => {
        if (progress.phase === 'connected') {
          options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'connected' });
        } else if (progress.phase === 'content' && !contentReported) {
          contentReported = true;
          options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'content' });
        }
      },
      messages: [{ role: 'user', content: [
        { type: 'text', text: buildVisionFinalReviewPrompt(
          targetPageIndex + 1,
          sourcePageIndices.map((page) => page + 1),
          compact,
        ) },
        ...content.slice(1),
      ] }],
      });
    };
    let completion: ChatCompletionResult;
    try {
      completion = await requestReview(false);
    } catch (error) {
      if (!(error instanceof Error)
        || !['DeepSeekOutputLimitError', 'DeepSeekTimeoutError', 'TypeError'].includes(error.name)) throw error;
      options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'retrying' });
      completion = await requestReview(true);
    }
    options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'returned' });
    if (pageSignal.aborted) throw new DOMException('已停止', 'AbortError');
    let pageReport: VisionFinalPageReport;
    try {
      pageReport = parseVisionFinalPageReport(completion.content, targetPageIndex);
    } catch (error) {
      options.onPageInvalid?.({
        targetPageIndex,
        totalPages: options.targetPdf.numPages,
        reason: error instanceof Error ? error.message : '未知响应格式错误',
      });
      throw error;
    }
    const severeCandidates = pageReport.issues.filter(
      (issue) => issue.severity === 'severe' && issue.confidence >= 0.8,
    );
    if (severeCandidates.length) {
      let contentReported = false;
      const confirmation = await complete({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: VISION_LAYOUT_MODEL,
        thinkingMode: 'disabled',
        responseFormat: 'json_object',
        stream: false,
        maxTokens: 384,
        timeoutMs: 30_000,
        hardTimeoutMs: 45_000,
        signal: pageSignal,
        onStreamProgress: (progress) => {
          if (progress.phase === 'connected') {
            options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'connected' });
          } else if (progress.phase === 'content' && !contentReported) {
            contentReported = true;
            options.onPagePhase?.({ targetPageIndex, totalPages: options.targetPdf.numPages, phase: 'content' });
          }
        },
        messages: [{ role: 'user', content: [
          {
            type: 'text',
            text: buildVisionFinalConfirmationPrompt(
              targetPageIndex + 1,
              severeCandidates.map((issue) => ({
                type: issue.type,
                bbox: issue.bbox,
                evidence: issue.evidence,
              })),
            ),
          },
          { type: 'text', text: `TARGET PAGE ${targetPageIndex + 1}` },
          { type: 'image_url', image_url: { url: targetImage, detail: 'original' } },
        ] }],
      });
      const confirmationReport = parseVisionFinalPageReport(confirmation.content, targetPageIndex);
      const candidateTypes = new Set(severeCandidates.map((issue) => issue.type));
      pageReport = {
        targetPageIndex,
        issues: [
          ...pageReport.issues.filter((issue) => !severeCandidates.includes(issue)),
          ...confirmationReport.issues.filter((issue) => candidateTypes.has(issue.type)),
        ],
        pass: confirmationReport.pass,
      };
    }
    pageIssues[targetPageIndex] = pageReport.issues;
    options.onPage?.({ targetPageIndex, totalPages: options.targetPdf.numPages, issueCount: pageReport.issues.length });
  };

  const reviewPage = (targetPageIndex: number): Promise<void> => withPageDeadline(
    (pageSignal) => performPageReview(targetPageIndex, pageSignal),
    runSignal,
    targetPageIndex,
    options.targetPdf.numPages,
    options.pageTimeoutMs ?? VISION_FINAL_REVIEW_PAGE_TIMEOUT_MS,
    () => options.onPageTimeout?.({
      targetPageIndex,
      totalPages: options.targetPdf.numPages,
      timeoutMs: options.pageTimeoutMs ?? VISION_FINAL_REVIEW_PAGE_TIMEOUT_MS,
    }),
    (elapsedMs) => options.onPageWait?.({
      targetPageIndex,
      totalPages: options.targetPdf.numPages,
      elapsedMs,
    }),
  );

  let nextTargetPageIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextTargetPageIndex < options.targetPdf.numPages) {
      const targetPageIndex = nextTargetPageIndex;
      nextTargetPageIndex += 1;
      await reviewPage(targetPageIndex);
    }
  };
  try {
    await Promise.all(Array.from(
      { length: Math.min(VISION_FINAL_REVIEW_CONCURRENCY, options.targetPdf.numPages) },
      () => worker(),
    ));
  } catch (error) {
    runController.abort();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
  const issues = pageIssues.flat();

  if (runSignal.aborted) {
    throw new DOMException('已停止', 'AbortError');
  }
  return {
    pass: !issues.some((issue) => issue.severity === 'severe' && issue.confidence >= 0.8),
    issues,
    reviewedPages: options.targetPdf.numPages,
  };
}
