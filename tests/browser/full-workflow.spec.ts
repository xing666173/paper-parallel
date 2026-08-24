import { expect, test, type Page } from '@playwright/test';

const FIXTURE = 'tests/fixtures/mixed-layout-paper.pdf';
const FAKE_KEY = 'sk-browser-e2e-placeholder';

interface PromptBlock {
  blockId: string;
  source: string;
  sourceSentences: Array<{ id: string; text: string }>;
}

async function mockDeepSeek(
  page: Page,
  options: { firstTranslationDelayMs?: number; firstProtocolError?: boolean } = {},
): Promise<{
  translatedBatches: () => number;
  translationRequests: () => Array<{ maxTokens: number; thinking: string; blockCount: number }>;
}> {
  let translatedBatches = 0;
  const translationRequests: Array<{ maxTokens: number; thinking: string; blockCount: number }> = [];

  await page.route('https://api.deepseek.com/models', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${FAKE_KEY}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
      }),
    });
  });

  await page.route('https://api.deepseek.com/chat/completions', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${FAKE_KEY}`);
    const request = route.request().postDataJSON() as {
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
      thinking?: { type?: string };
    };
    const userMessage = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    let content = 'pong';

    if (userMessage !== 'Reply with pong.') {
      const prompt = JSON.parse(userMessage) as { blocks: PromptBlock[] };
      translatedBatches += 1;
      translationRequests.push({
        maxTokens: request.max_tokens,
        thinking: request.thinking?.type ?? 'missing',
        blockCount: prompt.blocks.length,
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
          blocks: prompt.blocks.map((block) => {
            const translation = `译文：${block.source}`;
            return {
              block_id: block.blockId,
              translation,
              alignment_groups: [{
                source_sentence_ids: block.sourceSentences.map((sentence) => sentence.id),
                target_segments: [translation],
              }],
              new_terms: [],
              warnings: [],
            };
          }),
        });
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 120, completion_tokens: 80 },
      }),
    });
  });

  return {
    translatedBatches: () => translatedBatches,
    translationRequests: () => translationRequests,
  };
}

test('uploads a mixed-layout PDF and reaches the synchronized dual-PDF reader', async ({ page }) => {
  const deepSeek = await mockDeepSeek(page, { firstProtocolError: true });
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
  await expect(page.locator('[data-pdf-side="en"] canvas')).toBeVisible();
  await expect(page.locator('[data-pdf-side="zh"] canvas')).toBeVisible();
  await expect(page.getByLabel('英文 PDF 控制')).toContainText('100%');
  await expect(page.getByLabel('中文 PDF 控制')).toContainText('100%');
  await expect(page.getByLabel('英文 PDF 控制').getByRole('button', { name: '上一页' })).toBeDisabled();

  await page.getByRole('button', { name: '返回翻译任务' }).click();
  await expect(page.getByRole('heading', { name: '总体进度' })).toBeVisible();
  await expect(page.locator('.progress-number-row')).toContainText(/([1-9]\d*) \/ \1 个文本块/);
  await expect(page.getByText(/响应异常，已拆分为/).first()).toBeVisible();

  expect(deepSeek.translatedBatches()).toBeGreaterThan(0);
  expect(deepSeek.translationRequests().every((request) => (
    request.maxTokens === 32_768
    && request.thinking === 'enabled'
    && request.blockCount <= 8
  ))).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('paper-parallel.deepseek-key'))).toBeNull();
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
