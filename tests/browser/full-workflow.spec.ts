import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { assertEveryPdfPageHasContent, assertPdfContainsText } from './helpers/pdfAssertions';

const FIXTURE = 'tests/fixtures/mixed-layout-paper.pdf';
const FAKE_KEY = 'sk-browser-e2e-placeholder';

interface PromptBlock {
  blockId: string;
  source: string;
  sourceSentences: Array<{ id: string; text: string }>;
}

async function mockDeepSeek(
  page: Page,
  options: {
    firstTranslationDelayMs?: number;
    firstProtocolError?: boolean;
    firstValidationError?: boolean;
    visualRounds?: Array<'pass' | 'repairable'>;
  } = {},
): Promise<{
  translatedBatches: () => number;
  translationRequests: () => Array<{ maxTokens: number; thinking: string; blockCount: number; stream: boolean }>;
  visualReviewRounds: () => number;
}> {
  let translatedBatches = 0;
  let visualReviewRounds = 0;
  const activeVisualRound = new Map<number, number>();
  const translationRequests: Array<{
    maxTokens: number; thinking: string; blockCount: number; stream: boolean;
  }> = [];

  await page.route('https://api.deepseek.com/models', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${FAKE_KEY}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'deepseek-v4-flash' },
          { id: 'deepseek-v4-flash-vision-exp' },
          { id: 'deepseek-v4-pro' },
        ],
      }),
    });
  });

  await page.route('https://api.deepseek.com/chat/completions', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${FAKE_KEY}`);
    const request = route.request().postDataJSON() as {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
      max_tokens: number;
      thinking?: { type?: string };
      stream?: boolean;
    };
    const userContent = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const userMessage = typeof userContent === 'string'
      ? userContent
      : userContent.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
    let content = 'pong';

    if (Array.isArray(userContent) && userMessage.includes('inspecting one rendered page')) {
      const pageNumber = Number(userMessage.match(/source page (\d+)/i)?.[1] ?? 1);
      content = JSON.stringify({ page: pageNumber, layout: 'mixed', regions: [] });
    } else if (Array.isArray(userContent) && userMessage.includes('final visual quality inspector')) {
      const targetPage = Number(userMessage.match(/translated target page (\d+)/i)?.[1] ?? 1);
      if (targetPage === 1) visualReviewRounds += 1;
      const round = targetPage === 1 ? visualReviewRounds : 0;
      activeVisualRound.set(targetPage, round);
      const outcome = targetPage === 1 ? options.visualRounds?.[round - 1] : 'pass';
      content = JSON.stringify({
        target_page: targetPage,
        issues: outcome === 'repairable' ? [{
          type: 'layout_drift', severity: 'severe',
          bbox: { x: 0, y: 0, width: 1000, height: 1000 },
          confidence: 0.99, evidence: `isolated layout unit round ${round}`,
        }] : [],
      });
    } else if (Array.isArray(userContent) && userMessage.includes('Independently re-check')) {
      const targetPage = Number(userMessage.match(/target page (\d+)/i)?.[1] ?? 1);
      const round = activeVisualRound.get(targetPage) ?? 0;
      const outcome = targetPage === 1 ? options.visualRounds?.[round - 1] : 'pass';
      content = JSON.stringify({
        target_page: targetPage,
        issues: outcome === 'repairable' ? [{
          type: 'layout_drift', severity: 'severe',
          bbox: { x: 0, y: 0, width: 1000, height: 1000 },
          confidence: 0.99, evidence: `isolated layout unit round ${round}`,
        }] : [],
      });
    } else if (userMessage !== 'Reply with pong.') {
      const prompt = JSON.parse(userMessage) as { blocks: PromptBlock[] };
      translatedBatches += 1;
      translationRequests.push({
        maxTokens: request.max_tokens,
        thinking: request.thinking?.type ?? 'missing',
        blockCount: prompt.blocks.length,
        stream: request.stream === true,
      });
      if (translatedBatches === 1 && options.firstTranslationDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.firstTranslationDelayMs));
      }
      content = translatedBatches === 1 && options.firstProtocolError
        ? JSON.stringify({
          blocks: [{
            block_id: prompt.blocks[0]?.blockId,
            translation: 'malformed response',
            alignment_groups: 42,
            new_terms: [],
            warnings: [],
          }],
        })
        : JSON.stringify({
          blocks: prompt.blocks.map((block, blockIndex) => {
            const translation = `译文：${block.source}`;
            return {
              block_id: block.blockId,
              translation,
              alignment_groups: [{
                source_sentence_ids: translatedBatches === 1
                  && options.firstValidationError
                  && blockIndex === prompt.blocks.length - 1
                  ? ['wrong-source-id']
                  : block.sourceSentences.map((sentence) => sentence.id),
                target_segments: [translation],
              }],
              new_terms: [],
              warnings: [],
            };
          }),
        });
    }

    if (request.stream) {
      const events = [
        {
          choices: [{ delta: { reasoning_content: 'mock reasoning' }, finish_reason: null }],
          usage: null,
        },
        {
          choices: [{ delta: { content }, finish_reason: 'stop' }],
          usage: null,
        },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 80 } },
      ];
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 120, completion_tokens: 80 },
        }),
      });
    }
  });

  return {
    translatedBatches: () => translatedBatches,
    translationRequests: () => translationRequests,
    visualReviewRounds: () => visualReviewRounds,
  };
}

test('uploads a mixed-layout PDF and reaches the synchronized dual-PDF reader', async ({ page }) => {
  const deepSeek = await mockDeepSeek(page, { firstValidationError: true });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.locator('[data-field="pdf"]').setInputFiles(FIXTURE);
  await page.locator('[data-field="api-key"]').fill(FAKE_KEY);
  await page.getByLabel('思考模式').selectOption('enabled');
  await page.locator('[data-action="test-connection"]').click();
  await expect(page.getByText('连接成功')).toBeVisible();

  await page.locator('[data-action="start"]').click();
  await expect(page).toHaveURL(/#\/task\/pp-[a-f0-9]{64}\/process$/);
  await expect(page.getByRole('heading', { name: '总体进度' })).toBeVisible();

  const terminal = await Promise.race([
    page.waitForURL(/#\/task\/pp-[a-f0-9]{64}\/read(?:\?|$)/, { timeout: 180_000 }).then(() => 'reader'),
    page.locator('.quality-error').waitFor({ state: 'visible', timeout: 180_000 }).then(() => 'failed'),
  ]);
  if (terminal === 'failed') {
    throw new Error(`Browser pipeline failed: ${await page.locator('.quality-error').innerText()}`);
  }
  await expect(page.getByRole('status')).toContainText('翻译排版完成');
  await expect(page.getByLabel('英文 PDF 控制')).toContainText('英文 1 / 1');
  await expect(page.getByLabel('中文 PDF 控制')).toContainText(/中文 1 \/ [1-9]\d*/);
  await expect(page.locator('[data-pdf-side="en"] canvas').first()).toBeVisible();
  await expect(page.locator('[data-pdf-side="zh"] canvas').first()).toBeVisible();
  await expect(page.getByLabel('英文 PDF 控制')).toContainText('100%');
  await expect(page.getByLabel('中文 PDF 控制')).toContainText('100%');
  await expect(page.getByLabel('英文 PDF 控制').getByRole('button', { name: '上一页' })).toBeDisabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载中文 PDF' }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const downloadedPdf = new Uint8Array(await readFile(downloadPath!));
  await assertPdfContainsText(downloadedPdf, '译文');
  await assertEveryPdfPageHasContent(downloadedPdf);

  await page.getByRole('button', { name: '返回翻译任务' }).click();
  await expect(page.getByRole('heading', { name: '总体进度' })).toBeVisible();
  await expect(page.locator('.progress-number-row')).toContainText('全部阶段已完成');
  await expect(page.locator('.task-metrics')).toContainText(/译文已通过\s*[1-9]\d*/);
  await expect(page.getByText(/单块未通过校验，已切换无思考(?:分片)?修复请求/).first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: '总体进度' })).toBeVisible();
  await expect(page.getByText(/单块未通过校验，已切换无思考(?:分片)?修复请求/).first()).toBeVisible();
  await expect(page.getByText('最近 200 条任务事件，刷新后保留；不显示思维过程')).toBeVisible();

  expect(deepSeek.translatedBatches()).toBeGreaterThan(0);
  const ordinaryRequests = deepSeek.translationRequests().filter((request) => request.thinking === 'enabled');
  const recoveryRequests = deepSeek.translationRequests().filter((request) => request.thinking === 'disabled');
  expect(ordinaryRequests.every((request) => (
    request.maxTokens === 32_768
    && request.blockCount <= 8
    && request.stream
  ))).toBe(true);
  expect(recoveryRequests).toEqual([{
    maxTokens: 16_384, thinking: 'disabled', blockCount: 1, stream: true,
  }]);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('paper-parallel.deepseek-key'))).toBeNull();
  const typstSource = await page.evaluate(() => (
    globalThis as typeof globalThis & { __PP_DIAGNOSTIC_TYPST_SOURCE__?: string }
  ).__PP_DIAGNOSTIC_TYPST_SOURCE__ ?? '');
  expect(typstSource).not.toContain('columns(2)');
  expect(typstSource).not.toContain('#colbreak()');
});

test('safely stops an active translation request and resumes the recoverable task', async ({ page }) => {
  const deepSeek = await mockDeepSeek(page, { firstTranslationDelayMs: 3_000 });

  await page.goto('/');
  await page.locator('[data-field="pdf"]').setInputFiles(FIXTURE);
  await page.locator('[data-field="api-key"]').fill(FAKE_KEY);
  await page.locator('[data-action="test-connection"]').click();
  await expect(page.getByText('连接成功')).toBeVisible();
  await page.locator('[data-action="start"]').click();

  await expect(page.getByText(/开始批次 batch-/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '安全停止' }).click();
  await expect(page.getByRole('button', { name: '继续处理' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('已安全停止')).toBeVisible();

  await page.getByRole('button', { name: '继续处理' }).click();
  await page.waitForURL(/#\/task\/pp-[a-f0-9]{64}\/read(?:\?|$)/, { timeout: 180_000 });
  await expect(page.getByLabel('英文 PDF 控制')).toContainText('英文 1 / 1');
  expect(deepSeek.translatedBatches()).toBeGreaterThanOrEqual(2);
});

test('refreshes the preview after both bounded layout repairs and then enters the reader', async ({ page }) => {
  const deepSeek = await mockDeepSeek(page, { visualRounds: ['repairable', 'repairable', 'pass'] });
  await page.goto('/');
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & { __PP_PREVIEW_URLS__?: string[] };
    state.__PP_PREVIEW_URLS__ = [];
    new MutationObserver(() => {
      const url = document.querySelector<HTMLObjectElement>('object[aria-label="中文 Typst 编译预览"]')?.data;
      if (url && !state.__PP_PREVIEW_URLS__!.includes(url)) state.__PP_PREVIEW_URLS__!.push(url);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data'] });
  });
  await page.locator('[data-field="pdf"]').setInputFiles(FIXTURE);
  await page.locator('[data-field="api-key"]').fill(FAKE_KEY);
  await page.locator('[data-action="test-connection"]').click();
  await expect(page.getByText('连接成功')).toBeVisible();
  await page.locator('[data-action="start"]').click();

  await page.waitForURL(/#\/task\/pp-[a-f0-9]{64}\/read(?:\?|$)/, { timeout: 210_000 });
  await expect(page.getByText(/2 轮自动修复/)).toBeVisible();
  expect(deepSeek.visualReviewRounds()).toBe(3);
  const previewUrls = await page.evaluate(() => (
    globalThis as typeof globalThis & { __PP_PREVIEW_URLS__?: string[] }
  ).__PP_PREVIEW_URLS__ ?? []);
  expect(new Set(previewUrls).size).toBeGreaterThanOrEqual(3);
});

test('stays on processing with a page report after the second repair still fails', async ({ page }) => {
  const deepSeek = await mockDeepSeek(page, {
    visualRounds: ['repairable', 'repairable', 'repairable'],
  });
  await page.goto('/');
  await page.locator('[data-field="pdf"]').setInputFiles(FIXTURE);
  await page.locator('[data-field="api-key"]').fill(FAKE_KEY);
  await page.locator('[data-action="test-connection"]').click();
  await expect(page.getByText('连接成功')).toBeVisible();
  await page.locator('[data-action="start"]').click();

  await expect(page.locator('.quality-error')).toContainText('视觉质检未通过', { timeout: 210_000 });
  await expect(page.getByLabel('排版质量报告')).toContainText('逐页质检未通过');
  await expect(page.getByLabel('排版质量报告')).toContainText('共 3 次排版');
  expect(page.url()).toMatch(/\/process$/);
  expect(deepSeek.visualReviewRounds()).toBe(3);
});
