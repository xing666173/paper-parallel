import { expect, test } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE = process.env.PP_RAW_TYPST_SOURCE ?? '';
const ASSET_DIRECTORY = process.env.PP_RAW_TYPST_ASSET_DIR ?? '';
const OUTPUT = process.env.PP_RAW_TYPST_OUTPUT ?? '';

test('compile a raw single-column Typst prototype', async ({ page }) => {
  test.skip(!SOURCE || !ASSET_DIRECTORY || !OUTPUT, 'Raw Typst prototype paths are not configured');
  const mainContent = await readFile(SOURCE, 'utf8');
  await page.route('**/__prototype/main.typ', async (route) => route.fulfill({
    status: 200,
    contentType: 'text/plain; charset=utf-8',
    body: mainContent,
  }));
  await page.route('**/__prototype/assets/*', async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: await readFile(path.join(ASSET_DIRECTORY, name)),
    });
  });

  await page.goto('/#/__raw-typst-prototype');
  await expect(page.locator('[data-stage="compiled"], [data-stage="failed"]'))
    .toBeVisible({ timeout: 120_000 });
  if (await page.locator('[data-stage="failed"]').isVisible()) {
    throw new Error(await page.getByRole('alert').innerText());
  }
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载 PDF' }).click();
  const download = await downloadPromise;
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await download.saveAs(OUTPUT);
});
