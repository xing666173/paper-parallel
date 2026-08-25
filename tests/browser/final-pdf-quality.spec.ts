import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertEveryPdfPageHasContent, assertPdfContainsText } from './helpers/pdfAssertions';

const API_KEY = process.env.PP_DEEPSEEK_API_KEY ?? '';
const TRANSLATION_MODEL = process.env.PP_TRANSLATION_MODEL ?? 'deepseek-v4-flash';
const SOURCE_PDF = process.env.PP_SOURCE_PDF
  ?? 'C:/Users/axezt/Desktop/文献/导师文章/18：ZK-Tracer：A High-Performance Heterogeneous Accelerator for Zero-Knowledge VM Trace Generation.pdf';

async function connectWithRetry(page: import('@playwright/test').Page): Promise<void> {
  let failure = 'unknown network failure';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.locator('[data-action="test-connection"]').click();
    const result = await Promise.race([
      page.getByText('连接成功').waitFor({ state: 'visible', timeout: 35_000 }).then(() => 'connected'),
      page.getByText('连接失败').waitFor({ state: 'visible', timeout: 35_000 }).then(() => 'failed'),
    ]);
    if (result === 'connected') return;
    failure = await page.getByRole('alert').innerText().catch(() => 'Failed to fetch');
    if (attempt < 3) await page.waitForTimeout(1_500 * attempt);
  }
  throw new Error(`DeepSeek connection failed after 3 attempts: ${failure}`);
}

test('real API exact-paper PDF quality acceptance', async ({ page }) => {
  test.skip(!API_KEY, 'PP_DEEPSEEK_API_KEY is not available in this process');
  test.skip(!existsSync(SOURCE_PDF), 'The local exact-paper fixture is unavailable');
  test.setTimeout(45 * 60_000);

  try {
    await page.goto('/');
    await page.locator('[data-field="pdf"]').setInputFiles(SOURCE_PDF);
    await page.locator('[data-field="api-key"]').fill(API_KEY);
    await page.getByLabel('思考模式').selectOption('disabled');
    await page.getByLabel('模型').selectOption(TRANSLATION_MODEL);
    await connectWithRetry(page);
    await page.locator('[data-action="start"]').click();

    const terminal = await Promise.race([
      page.waitForURL(/#\/task\/pp-[a-f0-9]{64}\/read(?:\?|$)/, { timeout: 40 * 60_000 }).then(() => 'reader'),
      page.locator('.quality-error').waitFor({ state: 'visible', timeout: 40 * 60_000 }).then(() => 'failed'),
    ]);
    if (terminal === 'failed') throw new Error(await page.locator('.quality-error').innerText());

    const outputDirectory = path.resolve('reports', 'real-api', TRANSLATION_MODEL);
    await mkdir(outputDirectory, { recursive: true });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载中文 PDF' }).click();
    const download = await downloadPromise;
    const pdfPath = path.join(outputDirectory, 'final-chinese.pdf');
    await download.saveAs(pdfPath);
    const pdfBytes = new Uint8Array(await readFile(pdfPath));
    await assertPdfContainsText(pdfBytes, '零知识');
    await assertEveryPdfPageHasContent(pdfBytes);

    const zhControls = page.getByLabel('中文 PDF 控制');
    const countText = await zhControls.locator('strong').innerText();
    const pageCount = Number(countText.match(/\/\s*(\d+)/)?.[1] ?? 0);
    expect(pageCount).toBeGreaterThan(0);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const canvas = page.locator('[data-pdf-side="zh"] canvas');
      await expect(canvas).toBeVisible();
      await canvas.screenshot({ path: path.join(outputDirectory, `page-${String(pageNumber).padStart(2, '0')}.png`) });
      if (pageNumber < pageCount) {
        await zhControls.getByRole('button', { name: '下一页' }).click();
        await expect(zhControls.locator('strong')).toContainText(`中文 ${pageNumber + 1} / ${pageCount}`);
      }
    }

    await page.getByRole('button', { name: '返回翻译任务' }).click();
    await expect(page.getByText(/Vision Exp 成品质检：第 \d+\/\d+ 页已完成/).last()).toBeVisible();

    await writeFile(path.join(outputDirectory, 'acceptance.json'), JSON.stringify({
      translationModel: TRANSLATION_MODEL,
      visionModel: 'deepseek-v4-flash-vision-exp',
      thinkingMode: 'disabled',
      sourcePdf: SOURCE_PDF,
      targetPages: pageCount,
      completedAt: new Date().toISOString(),
    }, null, 2));
  } finally {
    await page.locator('[data-field="api-key"]').fill('').catch(() => undefined);
  }
});
