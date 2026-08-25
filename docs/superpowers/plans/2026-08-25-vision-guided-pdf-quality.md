# Vision-Guided PDF Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a vision-guided, browser-only pipeline that preserves immutable paper assets, emits readable Chinese PDFs, and rejects visually broken output before persistence.

**Architecture:** Keep PDF.js geometry and Typst composition as deterministic foundations. Add Vision Exp page analysis before immutable-region extraction and Vision Exp page-pair review after compilation; reconcile all visual candidates with local geometry and enforce a separate compiled-PDF content gate before saving artifacts.

**Tech Stack:** Vue 3, TypeScript, Vite, Vitest, Playwright, PDF.js, Typst.ts, DeepSeek OpenAI-compatible Chat Completions API.

**Spec:** `docs/superpowers/specs/2026-08-25-vision-guided-pdf-quality-design.md`

## Global Constraints

- The application remains static and browser-only; no server dependency is introduced.
- Figures, tables, formulas, code, variables, symbols, and internal figure labels remain unchanged.
- Figure/table captions remain translatable and must not be included in immutable body crops.
- Layout inheritance is single-to-single, double-to-double, and mixed by region, with natural page extension.
- Product visual validation always uses `deepseek-v4-flash-vision-exp` with thinking disabled.
- Translation remains selectable among current supported DeepSeek models.
- Deterministic failures cannot be overridden by AI output.
- Artifacts are persisted only after mandatory deterministic and visual gates pass.
- Release acceptance includes full real-API runs for Flash and Vision Exp translation paths and visual inspection of every final page.

---

### Task 1: Usable local Chinese font and rendered-PDF smoke gate

**Files:**
- Create: `assets/fonts/noto-serif-sc-400.ttf`
- Create: `assets/fonts/OFL.txt`
- Modify: `vite.config.ts`
- Modify: `src/core/typst/runtimePaths.ts`
- Modify: `tests/browser/typst-smoke.spec.ts`
- Create: `tests/browser/helpers/pdfAssertions.ts`

**Interfaces:**
- Consumes: `getTypstRuntimePaths(baseUrl, documentBaseUrl)` and the existing Typst smoke harness.
- Produces: `assertPdfContainsText(pdfBytes, expectedText)` and `assertPdfRendersNonBlank(pdfBytes)` browser-test helpers.

- [ ] **Step 1: Extend the Typst browser smoke test to download the PDF, open it with PDF.js, and require extractable Chinese text.**

```ts
const bytes = await downloadPdfBytes(downloadLink);
await assertPdfContainsText(bytes, '浏览器中文论文排版测试');
await assertPdfRendersNonBlank(bytes);
```

- [ ] **Step 2: Run the browser test and verify the WOFF build fails because it contains no Chinese text items.**

```powershell
npx playwright test tests/browser/typst-smoke.spec.ts
# Expected: FAIL, extracted text lacks 浏览器中文论文排版测试
```

- [ ] **Step 3: Add the verified TTF and point the runtime at it.**

```ts
fontFiles: [resolve('vendor/typst/noto-serif-sc-400.ttf')]
```

- [ ] **Step 4: Re-run the browser test and verify it passes.**

```powershell
npx playwright test tests/browser/typst-smoke.spec.ts
# Expected: 1 passed
```

- [ ] **Step 5: Run targeted regressions and commit.**

```powershell
npm test -- tests/unit/typstRuntime.spec.ts tests/unit/typstProject.spec.ts
git add public/vendor/typst src/core/typst/runtimePaths.ts tests/browser
git commit -m "fix: embed usable Chinese Typst font"
```

### Task 2: High-precision formula classification and safe immutable geometry

**Files:**
- Modify: `src/core/parser/blocks.ts`
- Modify: `src/core/pipeline/preparation.ts`
- Create: `src/core/assets/geometryGate.ts`
- Modify: `tests/unit/parser.spec.ts`
- Modify: `tests/unit/pipelinePreparation.spec.ts`
- Create: `tests/unit/assetGeometryGate.spec.ts`

**Interfaces:**
- Produces: `isDisplayFormulaCandidate(text, centered): boolean` and `validateImmutableRegion(region, page, intersectingBlocks): ImmutableGeometryResult`.
- Consumers: `classifyLineRole` and `prepareImmutableStructure`.

- [ ] **Step 1: Add failing prose and display-formula cases.**

```ts
expect(isDisplayFormulaCandidate('in Figure 1, consists of two main stages: (1) Front-end Execution', true)).toBe(false);
expect(isDisplayFormulaCandidate('T_total = T_front + T_back (3)', true)).toBe(true);
```

- [ ] **Step 2: Run the parser test and observe the prose failure.**

```powershell
npm test -- tests/unit/parser.spec.ts
# Expected: FAIL because the current heuristic accepts ordinary prose
```

- [ ] **Step 3: Implement the exported math-dominance classifier and call it from `classifyLineRole`.**

```ts
export function isDisplayFormulaCandidate(text: string, centered: boolean): boolean {
  const mathSymbols = (text.match(/[=+*/^{}<>≤≥×÷√∑∫]/g) ?? []).length;
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  const numbered = /\(\d+[a-z]?\)\s*$/.test(text);
  return centered && words.length <= 5 && (mathSymbols >= 2 || (numbered && mathSymbols >= 1));
}
```

- [ ] **Step 4: Add failing geometry cases for edge-touching, excessive, caption-containing, and prose-dense crops.**

```ts
expect(validateImmutableRegion(
  { id: 'fig-1', kind: 'figure', pageIndex: 0, rect: { x: 50, y: 0, w: 240, h: 300 } },
  { width: 612, height: 792 },
  proseBlocks,
).pass).toBe(false);
```

- [ ] **Step 5: Implement and integrate the geometry gate.**

```ts
export interface ImmutableGeometryResult { pass: boolean; issues: string[] }
export function validateImmutableRegion(
  region: DetectedAssetRegion,
  page: { width: number; height: number },
  intersectingBlocks: readonly Block[],
): ImmutableGeometryResult;
```

- [ ] **Step 6: Run targeted regressions and the exact-source diagnostic.**

```powershell
npm test -- tests/unit/parser.spec.ts tests/unit/pipelinePreparation.spec.ts tests/unit/assetGeometryGate.spec.ts
npx vite-node tmp/diagnose-parser.ts
# Expected: no ordinary prose formula assets; unsafe crops fail with page/asset IDs
```

- [ ] **Step 7: Commit the parser and geometry fix.**

```powershell
git add src/core/parser src/core/assets src/core/pipeline/preparation.ts tests/unit
git commit -m "fix: classify immutable paper regions safely"
```

### Task 3: Vision Exp page-layout protocol and reconciliation

**Files:**
- Create: `src/core/vision/protocol.ts`
- Create: `src/core/vision/prompts.ts`
- Create: `src/core/vision/render.ts`
- Create: `src/core/vision/reconcile.ts`
- Modify: `src/core/translate/client.ts`
- Modify: `src/core/pipeline/browserStages.ts`
- Modify: `src/core/project/cacheKey.ts`
- Create: `tests/unit/visionProtocol.spec.ts`
- Create: `tests/unit/visionReconcile.spec.ts`
- Modify: `tests/unit/client.spec.ts`

**Interfaces:**
- Produces: `VisionPageAnalysis`, `parseVisionPageAnalysis(content)`, `renderPdfPageDataUrl(page, scale)`, and `reconcileVisionLayout(doc, pageAnalysis)`.
- Consumes: `chatCompletion` with user `image_url` blocks and fixed model `deepseek-v4-flash-vision-exp`.

- [ ] **Step 1: Add failing strict-protocol cases.**

```ts
expect(parseVisionPageAnalysis(JSON.stringify({ page: 1, layout: 'double', regions: [
  { type: 'figure', bbox: [500, 100, 950, 400], column: 'right', confidence: 0.9 },
] })).regions).toHaveLength(1);
expect(() => parseVisionPageAnalysis('{"page":1,"layout":"double","regions":[{"type":"photo"}]}')).toThrow();
```

- [ ] **Step 2: Implement strict vision types and parsing.**

```ts
export type VisionRegionType = 'figure' | 'table' | 'display_formula' | 'code' | 'caption' | 'header' | 'footer' | 'body_text';
export interface VisionPageAnalysis { page: number; layout: 'single' | 'double' | 'mixed'; regions: VisionRegion[] }
export function parseVisionPageAnalysis(content: string): VisionPageAnalysis;
```

- [ ] **Step 3: Add failing client tests for image detail, model, thinking, JSON, and abort behavior.**

```ts
expect(request.model).toBe('deepseek-v4-flash-vision-exp');
expect(request.thinking).toEqual({ type: 'disabled' });
expect(request.messages[0].content).toContainEqual({
  type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/), detail: 'original' },
});
```

- [ ] **Step 4: Extend image parts and implement page analysis.**

```ts
type ImageMessagePart = { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' } };
await chatCompletion({ model: 'deepseek-v4-flash-vision-exp', thinkingMode: 'disabled', responseFormat: 'json_object', messages });
```

- [ ] **Step 5: Add failing reconciliation cases for prose formulas, figure bodies, and unresolved conflicts.**

```ts
const reconciled = reconcileVisionLayout(docWithProseFormula, [visionPage]);
expect(reconciled.doc.semanticUnits.find((unit) => unit.id === 'blk-10')?.kind).toBe('paragraph');
expect(reconciled.assetRegions[0].kind).toBe('figure');
```

- [ ] **Step 6: Implement reconciliation and targeted second-pass output.**

```ts
export interface VisionReconcileResult {
  doc: Doc;
  assetRegions: DetectedAssetRegion[];
  unresolved: Array<{ page: number; regionType: VisionRegionType; reason: string }>;
}
export function reconcileVisionLayout(doc: Doc, analyses: readonly VisionPageAnalysis[]): VisionReconcileResult;
```

- [ ] **Step 7: Integrate rendering, progress, cache identity, and reconciliation before batching.**

```ts
const pageImage = await renderPdfPageDataUrl(await pdf.getPage(pageNo), 2);
const analysis = await analyzePageWithVision({ pageNo, pageImage, apiKey, signal });
options.onAiEvent?.({ type: 'vision-layout-complete', at: Date.now(), page: pageNo });
```

- [ ] **Step 8: Run regressions and commit.**

```powershell
npm test -- tests/unit/visionProtocol.spec.ts tests/unit/visionReconcile.spec.ts tests/unit/client.spec.ts tests/unit/productionPipeline.spec.ts
git add src/core/vision src/core/translate src/core/pipeline src/core/project tests/unit
git commit -m "feat: add Vision Exp layout analysis"
```

### Task 4: Deterministic compiled-PDF content gate and delayed persistence

**Files:**
- Create: `src/core/quality/pdfContentGate.ts`
- Modify: `src/core/pipeline/browserStages.ts`
- Modify: `src/core/compose/compose.ts`
- Modify: `src/core/quality/compositionGate.ts`
- Create: `tests/unit/pdfContentGate.spec.ts`
- Modify: `tests/unit/compositionGate.spec.ts`
- Modify: `tests/integration/composition.spec.ts`

**Interfaces:**
- Produces: `inspectCompiledPdf(pdfBytes, expectations): Promise<PdfContentReport>` and expanded composition issue codes for missing fonts/text, low target coverage, blank pages, and render failure.
- Consumers: browser pipeline compile/validate stages and composition persistence.

- [ ] **Step 1: Add failing image-only PDF coverage.**

```ts
const report = await inspectCompiledPdf(imageOnlyPdf, { expectedChineseText: '中文正文', expectedTextUnits: 3 });
expect(report.issues.map((issue) => issue.code)).toContain('target-text-missing');
```

- [ ] **Step 2: Implement PDF.js content inspection.**

```ts
export interface PdfContentReport {
  pass: boolean;
  pageCount: number;
  extractedText: string;
  renderedPages: number;
  issues: Array<{ code: PdfContentIssueCode; page?: number; message: string }>;
}
export async function inspectCompiledPdf(pdfBytes: Uint8Array, expectations: PdfContentExpectations): Promise<PdfContentReport>;
```

- [ ] **Step 3: Add a failing integration case proving invalid output is not saved.**

```ts
await expect(composeChinesePdf(input, dependenciesReturningImageOnlyPdf)).rejects.toThrow('中文文字');
expect(saveArtifact).not.toHaveBeenCalled();
```

- [ ] **Step 4: Validate before persistence and retain prior artifacts on failure.**

```ts
const report = await inspectCompiledPdf(compiled.pdf, expectations);
if (!report.pass) throw new Error(formatPdfContentIssues(report.issues));
for (const record of records) await dependencies.saveArtifact(record);
```

- [ ] **Step 5: Expand gate codes and messages.**

```ts
type CompositionIssueCode = ExistingIssueCode
  | 'target-text-missing' | 'chinese-glyphs-missing' | 'target-coverage-low'
  | 'page-render-failed' | 'page-blank';
```

- [ ] **Step 6: Run regressions and commit.**

```powershell
npm test -- tests/unit/pdfContentGate.spec.ts tests/unit/compositionGate.spec.ts tests/integration/composition.spec.ts tests/unit/productionPipeline.spec.ts
git add src/core/quality src/core/compose src/core/pipeline tests
git commit -m "fix: reject unreadable compiled PDFs before persistence"
```

### Task 5: Vision Exp final page-pair review and UI progress

**Files:**
- Create: `src/core/vision/finalReview.ts`
- Modify: `src/core/vision/prompts.ts`
- Modify: `src/core/vision/render.ts`
- Modify: `src/core/pipeline/browserStages.ts`
- Modify: `src/core/pipeline/productionPipeline.ts`
- Modify: `src/components/processing/StageTimeline.vue`
- Modify: `src/views/ProcessingView.vue`
- Create: `tests/unit/visionFinalReview.spec.ts`
- Modify: `tests/unit/productionPipeline.spec.ts`
- Modify: `tests/components/ProcessingView.spec.ts`

**Interfaces:**
- Produces: `VisionFinalReport` with typed page issues and `runVisionFinalReview(sourcePdf, targetPdf, options)`.
- Consumes: paired full-page renders plus column/asset tiles and the fixed Vision Exp model.

- [ ] **Step 1: Add failing severe-issue parsing.**

```ts
const report = parseVisionFinalReport(JSON.stringify({ issues: [
  { page: 1, type: 'missing_text', severity: 'severe', bbox: [0, 0, 1000, 1000], confidence: 0.98, evidence: 'target blank' },
] }));
expect(report.pass).toBe(false);
```

- [ ] **Step 2: Implement strict issue parsing and tiling metadata.**

```ts
export interface VisionFinalReport { pass: boolean; issues: VisionFinalIssue[] }
export function parseVisionFinalReport(content: string): VisionFinalReport;
export function buildPageReviewTiles(source: HTMLCanvasElement, target: HTMLCanvasElement): PageReviewTile[];
```

- [ ] **Step 3: Add failing pipeline cases proving severe findings stop persistence/navigation.**

```ts
stages.visualReview = vi.fn(async () => ({ pass: false, issues: [severeIssue] }));
await expect(runProductionPipeline(...)).rejects.toThrow('视觉质检');
expect(repository.putArtifact).not.toHaveBeenCalled();
```

- [ ] **Step 4: Integrate final review before artifact persistence.**

```ts
const visualReport = await runVisionFinalReview(sourcePdf, compiled.pdf, {
  apiKey, signal, model: 'deepseek-v4-flash-vision-exp',
});
if (!visualReport.pass) throw new Error(formatVisionIssues(visualReport.issues));
```

- [ ] **Step 5: Add explicit progress and disclosure UI.**

```vue
<p class="vision-disclosure">版式识别和成品质检会将论文页面图片发送给 DeepSeek Vision Exp，并产生额外用量。</p>
```

- [ ] **Step 6: Run regressions and commit.**

```powershell
npm test -- tests/unit/visionFinalReview.spec.ts tests/unit/productionPipeline.spec.ts tests/components/ProcessingView.spec.ts
git add src/core/vision src/core/pipeline src/components src/views tests
git commit -m "feat: add Vision Exp final PDF review"
```

### Task 6: Full browser regression and real-API release acceptance

**Files:**
- Modify: `tests/browser/full-workflow.spec.ts`
- Modify: `tests/browser/typst-smoke.spec.ts`
- Create: `tests/browser/final-pdf-quality.spec.ts`
- Modify: `docs/FINAL-TEST-RUNBOOK.md`
- Modify: `docs/VERIFICATION-MATRIX.md`

**Interfaces:**
- Consumes: the production upload/process/read workflow and a local secret supplied outside git.
- Produces: downloaded PDFs and rendered page screenshots under ignored `reports/` for review.

- [ ] **Step 1: Add a browser regression for Chinese text, rendering, and assigned-page content.**

```ts
await assertPdfContainsText(pdfBytes, '零知识');
await assertAllPdfPagesRender(pdfBytes);
await assertAssignedPagesAreNonBlank(pdfBytes, expectedAssignedPages);
```

- [ ] **Step 2: Mock both Vision Exp request classes in CI.**

```ts
await page.route('https://api.deepseek.com/chat/completions', (route) => route.fulfill({
  json: visionResponseFor(requestKind(route.request())),
}));
```

- [ ] **Step 3: Run all deterministic suites.**

```powershell
npm run test:ci
npm run test:browser
# Expected: unit, integration, build, and browser suites all pass
```

- [ ] **Step 4: Run the exact paper with Flash translation and Vision Exp analysis/review.**

```powershell
$env:PP_TRANSLATION_MODEL='deepseek-v4-flash'
npx playwright test tests/browser/final-pdf-quality.spec.ts --project=chromium
```

- [ ] **Step 5: Run the exact paper with Vision Exp translation and review.**

```powershell
$env:PP_TRANSLATION_MODEL='deepseek-v4-flash-vision-exp'
npx playwright test tests/browser/final-pdf-quality.spec.ts --project=chromium
```

- [ ] **Step 6: Verify recovery, cache, reader alignment, and download behaviors.**

```powershell
npx playwright test tests/browser/final-pdf-quality.spec.ts --grep "stop resume|cache reuse|reader alignment|project download"
```

- [ ] **Step 7: Record ignored evidence, update docs, verify, and commit.**

```powershell
npm run test:all
git add tests/browser docs
git commit -m "test: verify real PDF quality end to end"
```
