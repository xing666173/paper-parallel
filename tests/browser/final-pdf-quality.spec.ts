import { chromium, expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertEveryPdfPageHasContent, assertPdfContainsText } from './helpers/pdfAssertions';

const OFFLINE_CACHED_RUN = process.env.PP_OFFLINE_CACHED_RUN === '1';
const OFFLINE_LAYOUT_JSON = process.env.PP_OFFLINE_LAYOUT_JSON ?? '';
const API_KEY = process.env.PP_DEEPSEEK_API_KEY ?? (OFFLINE_CACHED_RUN ? 'cached-prototype-key' : '');
const TRANSLATION_MODEL = process.env.PP_TRANSLATION_MODEL ?? 'deepseek-v4-flash';
const SOURCE_PDF = process.env.PP_SOURCE_PDF
  ?? 'C:/Users/axezt/Desktop/文献/导师文章/18：ZK-Tracer：A High-Performance Heterogeneous Accelerator for Zero-Knowledge VM Trace Generation.pdf';
const REPORT_SLUG = process.env.PP_REPORT_SLUG?.trim()
  || path.basename(SOURCE_PDF, path.extname(SOURCE_PDF))
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  || 'paper';
const PROFILE_SLUG = process.env.PP_PROFILE_SLUG?.trim() || REPORT_SLUG;
const FORCE_COLD_RUN = !OFFLINE_CACHED_RUN && process.env.PP_FORCE_COLD_RUN !== '0';
const MAX_RECOVERABLE_RESUMES = Math.max(0, Number(process.env.PP_MAX_RECOVERABLE_RESUMES ?? 3) || 0);
const OUTPUT_DIRECTORY = path.resolve('reports', 'real-api', TRANSLATION_MODEL, REPORT_SLUG);
const PROFILE_DIRECTORY = path.resolve('reports', 'real-api', '.profiles', TRANSLATION_MODEL, PROFILE_SLUG);

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
  let recoverableResumes = 0;
  while (Date.now() < deadline) {
    if (/#\/task\/pp-[a-f0-9]{64}\/read(?:\?|$)/.test(page.url())) return 'reader';
    const paused = await page.locator('.task-status').innerText({ timeout: 1_000 }).catch(() => '') === '等待恢复';
    if (paused && recoverableResumes < MAX_RECOVERABLE_RESUMES) {
      recoverableResumes += 1;
      const resume = page.locator('.progress-card button.primary');
      console.log(`[real-api recovery] recoverable pause ${recoverableResumes}/${MAX_RECOVERABLE_RESUMES}: ${await resume.innerText()}`);
      await resume.click();
      await page.waitForTimeout(1_000);
      continue;
    }
    const qualityError = await page.evaluate(() => (
      document.querySelector('.quality-error')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    )).catch(() => '');
    if (qualityError) {
      await saveFailureDiagnostics(page);
      throw new Error(qualityError);
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

async function saveFailureDiagnostics(page: import('@playwright/test').Page): Promise<void> {
  const outputDirectory = OUTPUT_DIRECTORY;
  await mkdir(outputDirectory, { recursive: true });
  const hasDiagnosticPdf = await page.evaluate(() => Boolean(
    (globalThis as typeof globalThis & { __PP_DIAGNOSTIC_PDF_URL__?: string }).__PP_DIAGNOSTIC_PDF_URL__,
  ));
  if (hasDiagnosticPdf) {
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.evaluate(() => {
      const url = (globalThis as typeof globalThis & { __PP_DIAGNOSTIC_PDF_URL__?: string })
        .__PP_DIAGNOSTIC_PDF_URL__;
      if (!url) return;
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'diagnostic-failed.pdf';
      anchor.click();
    });
    const download = await downloadPromise;
    await download.saveAs(path.join(outputDirectory, 'diagnostic-failed.pdf'));
  }
  const diagnostics = await page.evaluate(() => {
    const debugGlobal = globalThis as typeof globalThis & {
      __PP_DIAGNOSTIC_VISUAL_REPORT__?: unknown;
      __PP_DIAGNOSTIC_QUALITY_REPORT__?: unknown;
    };
    return {
      visualReport: debugGlobal.__PP_DIAGNOSTIC_VISUAL_REPORT__ ?? null,
      qualityReport: debugGlobal.__PP_DIAGNOSTIC_QUALITY_REPORT__ ?? null,
    };
  });
  await writeFile(
    path.join(outputDirectory, 'diagnostic-visual-report.json'),
    JSON.stringify(diagnostics.visualReport, null, 2),
  );
  await writeFile(
    path.join(outputDirectory, 'diagnostic-quality-report.json'),
    JSON.stringify(diagnostics.qualityReport, null, 2),
  );
  const layout = await page.evaluate(() => (
    globalThis as typeof globalThis & { __PP_DIAGNOSTIC_LAYOUT__?: unknown }
  ).__PP_DIAGNOSTIC_LAYOUT__ ?? null);
  await writeFile(
    path.join(outputDirectory, 'diagnostic-layout.json'),
    JSON.stringify(layout, null, 2),
  );
  const typstSource = await page.evaluate(() => (
    globalThis as typeof globalThis & { __PP_DIAGNOSTIC_TYPST_SOURCE__?: string }
  ).__PP_DIAGNOSTIC_TYPST_SOURCE__ ?? '');
  if (typstSource) {
    await writeFile(path.join(outputDirectory, 'diagnostic-main.typ'), typstSource);
  }
  const alignmentManifest = await page.evaluate(() => (
    globalThis as typeof globalThis & { __PP_DIAGNOSTIC_ALIGNMENT_MANIFEST__?: unknown }
  ).__PP_DIAGNOSTIC_ALIGNMENT_MANIFEST__ ?? null);
  await writeFile(
    path.join(outputDirectory, 'diagnostic-alignment-manifest.json'),
    JSON.stringify(alignmentManifest, null, 2),
  );
  const visionCache = await page.evaluate(async () => {
    const request = indexedDB.open('paper-parallel');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const records = await new Promise<any[]>((resolve, reject) => {
        const transaction = database.transaction('artifacts', 'readonly');
        const all = transaction.objectStore('artifacts').getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      });
      const selected = records
        .filter((record) => ['raw-vision-response', 'vision-correction-patch', 'recovered-page-plan']
          .includes(record.kind))
        .sort((left, right) => left.updatedAt - right.updatedAt)
        .slice(-40);
      return await Promise.all(selected.map(async (record) => ({
        key: record.key,
        kind: record.kind,
        updatedAt: record.updatedAt,
        content: record.blob instanceof Blob ? (await record.blob.text()).slice(0, 20_000) : '',
      })));
    } finally {
      database.close();
    }
  }).catch(() => []);
  await writeFile(
    path.join(outputDirectory, 'diagnostic-vision-cache.json'),
    JSON.stringify(visionCache, null, 2),
  );
}

test('real API exact-paper PDF quality acceptance', async () => {
  test.skip(!API_KEY, 'PP_DEEPSEEK_API_KEY is not available in this process');
  test.skip(!existsSync(SOURCE_PDF), 'The local exact-paper fixture is unavailable');
  test.setTimeout(45 * 60_000);

  const profileDirectory = PROFILE_DIRECTORY;
  if (FORCE_COLD_RUN) {
    // A real acceptance run must prove the complete upload -> analysis ->
    // translation -> typesetting path. Remove the whole persistent browser
    // profile, not only task records, so IndexedDB, Cache Storage, service
    // worker data, HTTP cache, and saved credentials cannot satisfy the run.
    await rm(profileDirectory, { recursive: true, force: true });
    await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
  }
  await mkdir(profileDirectory, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless: true,
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1000 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  let chatCompletionRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/chat\/completions(?:\?|$)/.test(request.url())) {
      chatCompletionRequests += 1;
    }
  });

  try {
    if (OFFLINE_CACHED_RUN) {
      const offlineLayout = OFFLINE_LAYOUT_JSON
        ? JSON.parse(await readFile(OFFLINE_LAYOUT_JSON, 'utf8'))
        : undefined;
      const analyses = new Map<number, unknown>((offlineLayout?.analyses ?? []).map((analysis: any) => (
        [Number(analysis.pageIndex) + 1, analysis]
      )));
      await page.route('**/models', async (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [{ id: TRANSLATION_MODEL }] }),
      }));
      await page.route('**/chat/completions', async (route) => {
        const body = route.request().postDataJSON() as any;
        const prompt = JSON.stringify(body?.messages ?? []);
        const pageNumber = Number(prompt.match(/source page (\d+)/i)?.[1] ?? 0);
        const analysis = analyses.get(pageNumber);
        if (!analysis || !/before translation and typesetting/i.test(prompt)) {
          await route.abort('failed');
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              ...(analysis as Record<string, unknown>),
              page: pageNumber,
            }) } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        });
      });
    }
    await page.goto('/');
    page.on('console', (message) => {
      if (message.text().startsWith('[page heartbeat]')) console.log(message.text());
    });
    page.on('pageerror', (error) => console.log(`[page error] ${error.message}`));
    await page.evaluate(() => {
      const runtime = globalThis as typeof globalThis & { __PP_TEST_HEARTBEAT_ID__?: number };
      runtime.__PP_TEST_HEARTBEAT_ID__ = window.setInterval(() => {
        const stage = document.querySelector('[data-stage].is-current strong')?.textContent?.trim() ?? '页面跳转中';
        const progress = document.querySelector('.progress-number-row')?.textContent?.replace(/\s+/g, ' ').trim() ?? '进度不可用';
        const logs = document.querySelectorAll('.log-entry');
        const lastLog = logs.item(logs.length - 1)?.textContent?.replace(/\s+/g, ' ').trim() ?? '等待首条日志';
        const qualityError = document.querySelector('.quality-error')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        console.log(`[page heartbeat] stage=${stage}; progress=${progress}; log=${lastLog}; error=${qualityError}`);
      }, 5_000);
    });
    await page.locator('[data-field="pdf"]').setInputFiles(SOURCE_PDF);
    await page.locator('[data-field="api-key"]').fill(API_KEY);
    await page.getByLabel('思考模式').selectOption('disabled');
    await page.getByLabel('模型').selectOption(TRANSLATION_MODEL);
    await connectWithRetry(page);
    await page.locator('[data-action="start"]').click();

    await waitForPipelineTerminal(page);
    if (FORCE_COLD_RUN) {
      expect(chatCompletionRequests, 'cold acceptance must call the DeepSeek chat API').toBeGreaterThan(0);
    }

    const alignmentManifest = await page.evaluate(() => (
      globalThis as typeof globalThis & { __PP_DIAGNOSTIC_ALIGNMENT_MANIFEST__?: {
        units: Array<{
          id: string;
          kind: string;
          fallbackReason?: string;
          source: Array<{ page: number; rects: unknown[] }>;
          target: Array<{ page: number; rects: unknown[] }>;
        }>;
      } }
    ).__PP_DIAGNOSTIC_ALIGNMENT_MANIFEST__ ?? null);
    expect(alignmentManifest).not.toBeNull();
    expect(alignmentManifest!.units.every((unit) => (
      unit.source.some((set) => set.rects.length > 0)
      && unit.target.some((set) => set.rects.length > 0)
    ))).toBe(true);

    const outputDirectory = OUTPUT_DIRECTORY;
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, 'successful-alignment-manifest.json'),
      JSON.stringify(alignmentManifest, null, 2),
    );
    const successfulDiagnostics = await page.evaluate(() => {
      const debugGlobal = globalThis as typeof globalThis & {
        __PP_DIAGNOSTIC_LAYOUT__?: unknown;
        __PP_DIAGNOSTIC_VISUAL_REPORT__?: unknown;
        __PP_DIAGNOSTIC_QUALITY_REPORT__?: unknown;
        __PP_DIAGNOSTIC_TYPST_SOURCE__?: string;
      };
      return {
        layout: debugGlobal.__PP_DIAGNOSTIC_LAYOUT__ ?? null,
        visualReport: debugGlobal.__PP_DIAGNOSTIC_VISUAL_REPORT__ ?? null,
        qualityReport: debugGlobal.__PP_DIAGNOSTIC_QUALITY_REPORT__ ?? null,
        typstSource: debugGlobal.__PP_DIAGNOSTIC_TYPST_SOURCE__ ?? '',
      };
    });
    expect(successfulDiagnostics.typstSource).not.toContain('columns(2)');
    expect(successfulDiagnostics.typstSource).not.toContain('#colbreak()');
    expect(successfulDiagnostics.qualityReport).toMatchObject({
      pass: true, layoutProfileVersion: 'zh-single-column-v1',
    });
    expect((successfulDiagnostics.qualityReport as { attempts: unknown[] }).attempts.length)
      .toBeGreaterThanOrEqual(1);
    expect((successfulDiagnostics.qualityReport as { attempts: unknown[] }).attempts.length)
      .toBeLessThanOrEqual(3);
    await writeFile(
      path.join(outputDirectory, 'successful-layout.json'),
      JSON.stringify(successfulDiagnostics.layout, null, 2),
    );
    await writeFile(
      path.join(outputDirectory, 'successful-visual-report.json'),
      JSON.stringify(successfulDiagnostics.visualReport, null, 2),
    );
    await writeFile(
      path.join(outputDirectory, 'successful-quality-report.json'),
      JSON.stringify(successfulDiagnostics.qualityReport, null, 2),
    );
    await writeFile(
      path.join(outputDirectory, 'successful-main.typ'),
      successfulDiagnostics.typstSource,
    );

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
    const stalePageImages = (await readdir(outputDirectory))
      .filter((name) => /^page-\d+[.]png$/.test(name));
    await Promise.all(stalePageImages.map((name) => (
      rm(path.join(outputDirectory, name), { force: true })
    )));
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const canvas = page.getByLabel(`中文译文第 ${pageNumber} 页`, { exact: true });
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
      reportSlug: REPORT_SLUG,
      translationModel: TRANSLATION_MODEL,
      visionModel: 'deepseek-v4-flash-vision-exp',
      thinkingMode: 'disabled',
      sourcePdf: SOURCE_PDF,
      targetPages: pageCount,
      layoutProfileVersion: 'zh-single-column-v1',
      qualityAttempts: (successfulDiagnostics.qualityReport as { attempts?: unknown[] } | null)?.attempts?.length ?? 0,
      coldRun: FORCE_COLD_RUN,
      chatCompletionRequests,
      completedAt: new Date().toISOString(),
    }, null, 2));
  } finally {
    await page.evaluate(() => {
      const runtime = globalThis as typeof globalThis & { __PP_TEST_HEARTBEAT_ID__?: number };
      if (runtime.__PP_TEST_HEARTBEAT_ID__ !== undefined) {
        window.clearInterval(runtime.__PP_TEST_HEARTBEAT_ID__);
        delete runtime.__PP_TEST_HEARTBEAT_ID__;
      }
      const keyInput = document.querySelector<HTMLInputElement>('[data-field="api-key"]');
      if (keyInput) keyInput.value = '';
      localStorage.removeItem('paper-parallel.deepseek-key');
      sessionStorage.removeItem('paper-parallel.deepseek-key-session');
    }).catch(() => undefined);
    await Promise.race([
      page.close({ runBeforeUnload: false }).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
    await Promise.race([
      context.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
});
