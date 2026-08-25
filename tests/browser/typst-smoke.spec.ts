import { expect, test } from '@playwright/test';
import { assertPdfContainsText, assertPdfHasDrawableContent } from './helpers/pdfAssertions';

test('compiles mixed Chinese paper with local Typst runtime and immutable asset', async ({ page }) => {
  const externalRuntimeRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/jsdelivr|github\.com|githubusercontent|fonts\.googleapis|fonts\.gstatic/i.test(url)) {
      externalRuntimeRequests.push(url);
    }
  });

  await page.goto('/#/__typst-smoke');
  const terminal = await page.waitForSelector('[data-stage="compiled"], [data-stage="failed"]', {
    timeout: 180_000,
  });
  if (await terminal.getAttribute('data-stage') === 'failed') {
    throw new Error(`Typst smoke harness failed: ${await page.getByRole('alert').textContent()}`);
  }
  await expect(page.locator('[data-stage="compiled"]')).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('[data-preview-title]')).toContainText('浏览器中文论文排版测试');
  await expect(page.locator('[data-asset-label]')).toHaveText('ORIGINAL FIGURE LABEL');
  await expect(page.locator('object[type="image/svg+xml"]')).toBeVisible();

  const downloadLink = page.getByRole('link', { name: '下载 PDF' });
  const pdfBytes = Uint8Array.from(await downloadLink.evaluate(async (element) => {
    const response = await fetch((element as HTMLAnchorElement).href);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }));
  expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe('%PDF-');
  await assertPdfContainsText(pdfBytes, '浏览器中文论文排版测试');
  await assertPdfHasDrawableContent(pdfBytes);
  const downloadPromise = page.waitForEvent('download');
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('paper-parallel-typst-smoke.pdf');
  expect(externalRuntimeRequests).toEqual([]);
});
