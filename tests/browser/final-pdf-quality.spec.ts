import { chromium, expect, test } from '@playwright/test';
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

async function waitForPipelineTerminal(page: import('@playwright/test').Page): Promise<'reader'> {
  const deadline = Date.now() + 25 * 60_000;
  let lastSnapshot = '尚未进入处理页';
  while (Date.now() < deadline) {
    if (/#\/task\/pp-[a-f0-9]{64}\/read(?:\?|$)/.test(page.url())) return 'reader';
    if (await page.locator('.quality-error').isVisible({ timeout: 2_000 }).catch(() => false)) {
      throw new Error(await page.locator('.quality-error').innerText({ timeout: 2_000 }));
    }
    const stage = await page.locator('[data-stage].is-current strong').innerText({ timeout: 2_000 }).catch(() => '页面跳转中');
    const progress = await page.locator('.progress-number-row').innerText({ timeout: 2_000 }).catch(() => '进度不可用');
    const lastLog = await page.locator('.log-entry').last().innerText({ timeout: 2_000 }).catch(() => '等待首条日志');
    lastSnapshot = `stage=${stage}; progress=${progress.replace(/\s+/g, ' ')}; log=${lastLog.replace(/\s+/g, ' ')}`;
    console.log(`[real-api heartbeat] ${lastSnapshot}`);
    await page.waitForTimeout(15_000);
  }
  throw new Error(`Pipeline did not reach a terminal state within 25 minutes: ${lastSnapshot}`);
}

test('real API exact-paper PDF quality acceptance', async () => {
  test.skip(!API_KEY, 'PP_DEEPSEEK_API_KEY is not available in this process');
  test.skip(!existsSync(SOURCE_PDF), 'The local exact-paper fixture is unavailable');
  test.setTimeout(45 * 60_000);

  const profileDirectory = path.resolve('reports', 'real-api', '.profiles', TRANSLATION_MODEL);
  await mkdir(profileDirectory, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless: true,
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1000 },
  });
  const page = context.pages()[0] ?? await context.newPage();

  try {
    await page.goto('/');
    page.on('console', (message) => {
      if (message.text().startsWith('[page heartbeat]')) console.log(message.text());
    });
    page.on('pageerror', (error) => console.log(`[page error] ${error.message}`));
    await page.evaluate(() => {
      window.setInterval(() => {
        const stage = document.querySelector('[data-stage].is-current strong')?.textContent?.trim() ?? '页面跳转中';
        const progress = document.querySelector('.progress-number-row')?.textContent?.replace(/\s+/g, ' ').trim() ?? '进度不可用';
        const logs = document.querySelectorAll('.log-entry');
        const lastLog = logs.item(logs.length - 1)?.textContent?.replace(/\s+/g, ' ').trim() ?? '等待首条日志';
        console.log(`[page heartbeat] stage=${stage}; progress=${progress}; log=${lastLog}`);
      }, 5_000);
    });
    await page.locator('[data-field="pdf"]').setInputFiles(SOURCE_PDF);
    await page.locator('[data-field="api-key"]').fill(API_KEY);
    await page.getByLabel('思考模式').selectOption('disabled');
    await page.getByLabel('模型').selectOption(TRANSLATION_MODEL);
    await connectWithRetry(page);
    await page.locator('[data-action="start"]').click();

    await waitForPipelineTerminal(page);

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
    await page.evaluate(() => {
      localStorage.removeItem('paper-parallel.deepseek-key');
      sessionStorage.removeItem('paper-parallel.deepseek-key-session');
    }).catch(() => undefined);
    await context.close();
  }
});
