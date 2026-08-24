# Paper Parallel Layout, Immutable Assets, and Browser Typst Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn parsed and translated semantic units into a downloadable Chinese academic PDF in the browser while inheriting source layout modes and preserving figures, tables, formulas, code, and page furniture as immutable assets.

**Architecture:** The parser produces ordered layout regions and immutable asset records. A deterministic Typst project builder maps regions to single-column, double-column, and full-width template functions, while a dedicated Web Worker compiles the project through locally bundled Typst WASM and returns PDF/SVG artifacts plus marker metadata.

**Tech Stack:** Existing PDF.js 4 parser, Vue 3, TypeScript 5.6, `@myriaddreamin/typst.ts@0.7.0`, `@myriaddreamin/typst-ts-web-compiler@0.7.0`, `@myriaddreamin/typst-ts-renderer@0.7.0`, `@myriaddreamin/typst-all-in-one.ts@0.7.0`, Vitest 3, Playwright 1.62.1.

**Spec:** `docs/superpowers/specs/2026-08-24-paper-parallel-browser-typesetting-reader-design.md`

## Global Constraints

- Compilation runs in the browser on GitHub Pages; users install no compiler.
- Typst packages and WASM are pinned to `0.7.0` and served from the built site, not fetched from an unpinned CDN.
- Source layout inheritance is structural: single to single, double to double, mixed by ordered region, with natural page extension.
- Chinese pagination may differ from the English PDF; shrinking content to force equal page counts is forbidden.
- Figures, diagrams, table bodies, formulas, code, and their internal labels are copied as immutable visual assets and never regenerated or translated.
- Figure captions and table titles are separate translatable text units; numbering is unchanged.
- Headers, footers, conference marks, arXiv side text, and watermarks preserve source content and style.
- Every rendered semantic unit and asset keeps its stable ID for the alignment plan.
- Typst compilation runs in a terminable Web Worker and reports real stage events.

---

### Task 1: Pin and locally serve the browser Typst runtime

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Create: `src/core/typst/runtimePaths.ts`
- Test: `tests/unit/typstRuntime.spec.ts`

**Interfaces:**
- Consumes: Vite base URL and installed Typst packages.
- Produces: `getTypstRuntimePaths(baseUrl)` and build output under `dist/vendor/typst/`.

- [ ] **Step 1: Write runtime URL tests**

```ts
import { describe, expect, it } from 'vitest';
import { getTypstRuntimePaths } from '../../src/core/typst/runtimePaths';

describe('Typst runtime paths', () => {
  it('honors a GitHub Pages subpath', () => {
    expect(getTypstRuntimePaths('/paper-parallel/')).toEqual({
      compilerWasm: '/paper-parallel/vendor/typst/typst_ts_web_compiler_bg.wasm',
      rendererWasm: '/paper-parallel/vendor/typst/typst_ts_renderer_bg.wasm',
    });
  });

  it('normalizes a relative Vite base', () => {
    expect(getTypstRuntimePaths('./')).toEqual({
      compilerWasm: './vendor/typst/typst_ts_web_compiler_bg.wasm',
      rendererWasm: './vendor/typst/typst_ts_renderer_bg.wasm',
    });
  });
});
```

- [ ] **Step 2: Install exact runtime versions and verify the failing test**

Run:

```bash
npm install --save --save-exact @myriaddreamin/typst.ts@0.7.0 @myriaddreamin/typst-all-in-one.ts@0.7.0 @myriaddreamin/typst-ts-web-compiler@0.7.0 @myriaddreamin/typst-ts-renderer@0.7.0
npm test -- tests/unit/typstRuntime.spec.ts
```

Expected: FAIL because `runtimePaths.ts` does not exist.

- [ ] **Step 3: Implement base-aware paths**

```ts
export function getTypstRuntimePaths(baseUrl: string) {
  const base = baseUrl === './' ? './' : `/${baseUrl.replace(/^\/+|\/+$/g, '')}/`;
  return {
    compilerWasm: `${base}vendor/typst/typst_ts_web_compiler_bg.wasm`,
    rendererWasm: `${base}vendor/typst/typst_ts_renderer_bg.wasm`,
  };
}
```

- [ ] **Step 4: Copy pinned WASM files during Vite build**

Extend the existing `closeBundle()` plugin with two explicit copies:

```ts
copyFileSync(
  'node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm',
  'dist/vendor/typst/typst_ts_web_compiler_bg.wasm',
);
copyFileSync(
  'node_modules/@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm',
  'dist/vendor/typst/typst_ts_renderer_bg.wasm',
);
```

Create `dist/vendor/typst` before copying. Do not reference jsDelivr or GitHub Releases at runtime.

- [ ] **Step 5: Run test and build artifact checks**

Run:

```bash
npm test -- tests/unit/typstRuntime.spec.ts
npm run build
node -e "const fs=require('fs');for(const f of ['dist/vendor/typst/typst_ts_web_compiler_bg.wasm','dist/vendor/typst/typst_ts_renderer_bg.wasm']){if(!fs.statSync(f).size)process.exit(1)}"
```

Expected: PASS and both files have non-zero size.

- [ ] **Step 6: Commit the runtime**

```bash
git add package.json package-lock.json vite.config.ts src/core/typst/runtimePaths.ts tests/unit/typstRuntime.spec.ts
git commit -m "build: bundle pinned browser Typst runtime"
```

---

### Task 2: Promote layout regions and semantic units into the core model

**Files:**
- Modify: `src/types/models.ts`
- Create: `src/core/layout/regions.ts`
- Modify: `src/core/parser/docBuilder.ts`
- Test: `tests/unit/layoutRegions.spec.ts`
- Modify: `tests/unit/docBuilder.spec.ts`

**Interfaces:**
- Consumes: parsed pages, block coordinates, detected columns, and global block order.
- Produces: `LayoutRegion`, `SemanticUnit`, and `buildLayoutRegions(doc)`.

- [ ] **Step 1: Write mixed-region tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildLayoutRegions } from '../../src/core/layout/regions';

it('preserves ordered full-width and two-column regions', () => {
  const regions = buildLayoutRegions({
    pageWidth: 612,
    blocks: [
      { id: 'title', pageIndex: 0, order: 0, col: 'full', rect: { x: 72, y: 60, w: 468, h: 40 } },
      { id: 'abstract', pageIndex: 0, order: 1, col: 'full', rect: { x: 72, y: 120, w: 468, h: 80 } },
      { id: 'left-1', pageIndex: 0, order: 2, col: 'left', rect: { x: 72, y: 230, w: 220, h: 90 } },
      { id: 'right-1', pageIndex: 0, order: 3, col: 'right', rect: { x: 320, y: 230, w: 220, h: 90 } },
      { id: 'wide-figure', pageIndex: 1, order: 4, col: 'full', rect: { x: 72, y: 80, w: 468, h: 180 } },
    ],
  });
  expect(regions.map((region) => region.mode)).toEqual(['full-width', 'double', 'full-width']);
  expect(regions.flatMap((region) => region.orderedUnitIds)).toEqual([
    'title', 'abstract', 'left-1', 'right-1', 'wide-figure',
  ]);
});
```

- [ ] **Step 2: Run tests and verify type/module failures**

Run: `npm test -- tests/unit/layoutRegions.spec.ts tests/unit/docBuilder.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Add layout and semantic contracts**

```ts
export interface LayoutRegion {
  id: string;
  mode: 'single' | 'double' | 'full-width';
  sourcePage: number;
  bounds: Rect;
  columnGap?: number;
  orderedUnitIds: string[];
}

export interface SemanticUnit {
  id: string;
  parentId?: string;
  kind: 'title' | 'author' | 'affiliation' | 'abstract' | 'heading' |
        'paragraph' | 'sentence' | 'list-item' | 'caption' | 'table-title' |
        'figure' | 'table' | 'formula' | 'code' | 'reference' | 'page-furniture';
  sourceText?: string;
  translation?: string;
  protectedTokens: string[];
  assetId?: string;
  layoutRegionId: string;
  order: number;
}
```

- [ ] **Step 4: Implement region grouping without coordinate cloning**

Sort blocks by global `order`. Start a new region when the page changes or the normalized mode changes. Normalize `left` and `right` to `double`, `full` front matter to `full-width`, and an entirely single-column page to `single`. Merge adjacent same-mode regions only when their source pages are consecutive and no full-width asset lies between them.

- [ ] **Step 5: Populate regions in the document builder**

Extend `Doc` with `layoutRegions: LayoutRegion[]` and `semanticUnits: SemanticUnit[]`. Keep legacy `blocks` for probe compatibility. Convert every existing block to a semantic unit with the same stable ID; sentence child IDs are added in the alignment plan, not here.

- [ ] **Step 6: Run parser/layout regression**

Run: `npm test -- tests/unit/layoutRegions.spec.ts tests/unit/docBuilder.spec.ts tests/unit/parser.spec.ts tests/unit/regions.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit the core layout model**

```bash
git add src/types/models.ts src/core/layout/regions.ts src/core/parser/docBuilder.ts tests/unit/layoutRegions.spec.ts tests/unit/docBuilder.spec.ts
git commit -m "feat: model inherited paper layout regions"
```

---

### Task 3: Extract immutable visual assets and verify identity

**Files:**
- Create: `src/core/assets/types.ts`
- Create: `src/core/assets/hash.ts`
- Create: `src/core/assets/extract.ts`
- Create: `src/core/assets/crop.ts`
- Test: `tests/unit/assets.spec.ts`

**Interfaces:**
- Consumes: PDF.js page proxy, detected figure/table/formula/code/page-furniture regions, and source coordinates.
- Produces: `ImmutableAsset`, `extractImmutableAssets()`, `cropPageRegionLossless()`, and `verifyAssetHash()`.

- [ ] **Step 1: Write asset policy tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildAssetManifest, isTranslatableAssetKind } from '../../src/core/assets/extract';

it.each(['figure', 'table', 'formula', 'code', 'page-furniture'] as const)(
  'marks %s as immutable and non-translatable',
  (kind) => expect(isTranslatableAssetKind(kind)).toBe(false),
);

it('keeps caption outside the immutable asset record', async () => {
  const manifest = await buildAssetManifest([{
    id: 'fig-1',
    kind: 'figure',
    pageIndex: 0,
    rect: { x: 100, y: 200, w: 300, h: 180 },
    bytes: new Uint8Array([1, 2, 3]),
    captionUnitId: 'fig-1-caption',
  }]);
  expect(manifest.assets[0].captionUnitId).toBe('fig-1-caption');
  expect(manifest.assets[0]).not.toHaveProperty('translatedBytes');
});
```

- [ ] **Step 2: Run the test and confirm missing modules**

Run: `npm test -- tests/unit/assets.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Define immutable assets**

```ts
export interface ImmutableAsset {
  id: string;
  kind: 'figure' | 'table' | 'formula' | 'code' | 'page-furniture';
  sourcePage: number;
  sourceRect: Rect;
  mimeType: 'image/png' | 'image/jpeg';
  blob: Blob;
  sha256: string;
  widthMode: 'column' | 'span';
  captionUnitId?: string;
}
```

- [ ] **Step 4: Implement raw-image preference and lossless crop fallback**

When a detected region corresponds to one PDF image operator, reuse decoded pixel data and encode PNG without changing labels or colors. When it contains multiple images, vector operators, formulas, tables, or page furniture, render the source page once at scale 4 into `OffscreenCanvas`, crop the exact source rectangle, and export `image/png` with no lossy compression. Never draw translated text into the crop.

- [ ] **Step 5: Hash every final asset**

Use `crypto.subtle.digest('SHA-256', blob.arrayBuffer())` and lowercase hexadecimal output. Persist the hash before composition and re-hash the Blob loaded into Typst; a mismatch is a quality-gate error.

- [ ] **Step 6: Run asset and parser regression tests**

Run: `npm test -- tests/unit/assets.spec.ts tests/unit/regions.spec.ts tests/unit/docBuilder.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit immutable extraction**

```bash
git add src/core/assets tests/unit/assets.spec.ts
git commit -m "feat: extract immutable paper visual assets"
```

---

### Task 4: Generate deterministic Typst source from layout regions

**Files:**
- Create: `src/core/typst/escape.ts`
- Create: `src/core/typst/template.ts`
- Create: `src/core/typst/project.ts`
- Test: `tests/unit/typstProject.spec.ts`

**Interfaces:**
- Consumes: paper metadata, layout regions, translated semantic units, immutable assets, and page-furniture assets.
- Produces: `TypstProject { mainContent, files, markerIds }` via `buildTypstProject(input)`.

- [ ] **Step 1: Write a source-generation test for mixed layout**

```ts
it('emits ordered full-width, double-column, and asset regions', () => {
  const project = buildTypstProject(mixedFixture);
  expect(project.mainContent).toContain('#pp-full-width[论文标题]');
  expect(project.mainContent).toContain('#pp-double[');
  expect(project.mainContent).toContain('#pp-unit("sec-1-p-1")');
  expect(project.mainContent).toContain('#pp-asset("fig-1", "/assets/fig-1.png", span: true)');
  expect(project.mainContent.indexOf('pp-full-width')).toBeLessThan(project.mainContent.indexOf('pp-double'));
  expect(project.files.get('/assets/fig-1.png')).toEqual(fig1Bytes);
});

it('escapes Typst syntax without changing protected text', () => {
  expect(escapeTypstText('Cost is $5 and [x] #tag.')).toBe('Cost is \\$5 and \\[x\\] \\#tag.');
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- tests/unit/typstProject.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Implement escaping and stable marker wrappers**

`pp-unit(id)[body]` must wrap content in an unstyled link annotation whose destination is `https://paper-parallel.invalid/unit/<encoded-id>`. The visible body receives no underline, color, or spacing change. `pp-asset` wraps the original image in the same marker and emits its separate translated caption unit below or above according to source order.

- [ ] **Step 4: Implement the academic page template**

The template must set source paper size and margins, serif body typography, heading hierarchy, page numbering, source page furniture, and these functions:

```typst
#let pp-full-width(body) = block(width: 100%)[#body]
#let pp-double(body) = columns(2, gutter: 12pt)[#body]
#let pp-single(body) = block(width: 100%)[#body]
#let pp-unit(id, body) = link("https://paper-parallel.invalid/unit/" + id)[#body]
#let pp-asset(id, path, span: false) = {
  let body = pp-unit(id)[#image(path, width: 100%)]
  if span { pp-full-width(body) } else { body }
}
```

Use actual source margin and gutter values when available; otherwise use the document-level measured median. Never hardcode the ZK-Tracer title, authors, field, or terminology.

- [ ] **Step 5: Build the project virtual filesystem**

Store `/main.typ`, every asset under `/assets/<asset-id>.png`, and a JSON manifest under `/paper-parallel.json`. Reject duplicate paths and verify each asset hash before adding bytes.

- [ ] **Step 6: Run source-generation and layout tests**

Run: `npm test -- tests/unit/typstProject.spec.ts tests/unit/layoutRegions.spec.ts tests/unit/assets.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit Typst generation**

```bash
git add src/core/typst/escape.ts src/core/typst/template.ts src/core/typst/project.ts tests/unit/typstProject.spec.ts
git commit -m "feat: generate inherited academic Typst projects"
```

---

### Task 5: Compile Typst projects in a terminable Web Worker

**Files:**
- Create: `src/core/typst/messages.ts`
- Create: `src/core/typst/compiler.worker.ts`
- Create: `src/core/typst/compiler.ts`
- Test: `tests/unit/typstCompiler.spec.ts`

**Interfaces:**
- Consumes: `TypstProject`, pinned runtime URLs, and caller abort signal.
- Produces: `compileTypstProject(project, options): Promise<{ pdf: Uint8Array; svg: string }>` and typed progress events.

- [ ] **Step 1: Write host-side worker tests with an injected worker factory**

```ts
it('maps project files, returns PDF/SVG, and terminates after completion', async () => {
  const worker = new FakeTypstWorker();
  const result = await compileTypstProject(projectFixture, {
    workerFactory: () => worker as unknown as Worker,
    runtimePaths,
  });
  expect(result.pdf.slice(0, 4)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  expect(result.svg).toContain('<svg');
  expect(worker.terminated).toBe(true);
});

it('terminates the worker on abort', async () => {
  const worker = new FakeTypstWorker({ neverComplete: true });
  const controller = new AbortController();
  const promise = compileTypstProject(projectFixture, {
    workerFactory: () => worker as unknown as Worker,
    runtimePaths,
    signal: controller.signal,
  });
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  expect(worker.terminated).toBe(true);
});
```

- [ ] **Step 2: Run the compiler test and verify failure**

Run: `npm test -- tests/unit/typstCompiler.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Define serializable worker messages**

```ts
export type TypstWorkerRequest = {
  type: 'compile';
  requestId: string;
  mainContent: string;
  files: Array<{ path: string; bytes: Uint8Array }>;
  runtimePaths: { compilerWasm: string; rendererWasm: string };
};

export type TypstWorkerResponse =
  | { type: 'progress'; requestId: string; phase: 'initializing' | 'mapping-files' | 'compiling-pdf' | 'rendering-preview' }
  | { type: 'done'; requestId: string; pdf: Uint8Array; svg: string }
  | { type: 'error'; requestId: string; message: string };
```

- [ ] **Step 4: Implement worker compilation**

Initialize `$typst` exactly once per worker, load both WASM modules from supplied local URLs, call `mapShadow(path, bytes)` for every file, then call `$typst.pdf({ mainContent })` and `$typst.svg({ mainContent })`. Transfer the PDF `ArrayBuffer` back to the host. Do not fetch fonts, templates, or assets from document-provided URLs.

- [ ] **Step 5: Implement host lifecycle and timeout**

Create the worker with `new Worker(new URL('./compiler.worker.ts', import.meta.url), { type: 'module' })`. Attach abort and a 180-second timeout, reject once, remove listeners, and always call `worker.terminate()` in the single cleanup path.

- [ ] **Step 6: Run focused tests and production build**

Run: `npm test -- tests/unit/typstCompiler.spec.ts && npm run typecheck && npm run build`

Expected: PASS; Vite emits a worker chunk and local WASM files.

- [ ] **Step 7: Commit the compiler**

```bash
git add src/core/typst/messages.ts src/core/typst/compiler.worker.ts src/core/typst/compiler.ts tests/unit/typstCompiler.spec.ts
git commit -m "feat: compile Typst projects in a cancellable worker"
```

---

### Task 6: Orchestrate composition and persist compiled artifacts

**Files:**
- Create: `src/core/compose/compose.ts`
- Modify: `src/core/project/db.ts`
- Modify: `src/core/project/repository.ts`
- Modify: `src/stores/task.ts`
- Test: `tests/integration/composition.spec.ts`

**Interfaces:**
- Consumes: parsed source document, accepted translations, immutable assets, Typst project builder/compiler, and project repository.
- Produces: `composeChinesePdf(input, deps)` and persisted `CompiledArtifactRecord`.

- [ ] **Step 1: Write a composition integration test with compiler injection**

```ts
it('preserves source region order and persists the compiled PDF', async () => {
  const persisted: CompiledArtifactRecord[] = [];
  const result = await composeChinesePdf(compositionFixture, {
    compile: async (project) => {
      expect(project.markerIds).toEqual(['title', 'sec-1-p-1', 'fig-1', 'fig-1-caption']);
      return { pdf: minimalPdfBytes, svg: '<svg></svg>' };
    },
    saveArtifact: async (record) => persisted.push(record),
    onProgress: () => undefined,
  });
  expect(result.pdfKey).toBe('project-1:zh-pdf');
  expect(persisted[0].blob.type).toBe('application/pdf');
});
```

- [ ] **Step 2: Extend the existing artifact storage contract**

Keep the Dexie `artifacts` table introduced in the workflow plan and widen `ProjectArtifactKind` from `english-pdf` to `english-pdf | chinese-pdf | typst-source | typst-preview | alignment-manifest | project-package`. Reuse `putArtifact()` and `findArtifact()`; do not create a second Blob store or migrate the source PDF to a different table.

- [ ] **Step 3: Implement the orchestration function**

Validate that every translated unit exists, every asset hash matches, and every layout-region ID resolves before building Typst. Emit `composing`, `compiling-pdf`, and `persisting-pdf` events. Persist the PDF Blob, main Typst source, and preview SVG only after the compiler returns successfully.

- [ ] **Step 4: Connect task stages**

Extend the task reducer with `GLOSSARY_DONE`, `TRANSLATION_DONE`, `COMPOSITION_DONE`, `COMPILE_DONE`, `ALIGNMENT_DONE`, and `QUALITY_STARTED` transitions. The Pinia store invokes composition after translation succeeds and uses the same abort controller to terminate the compiler worker.

- [ ] **Step 5: Run composition, repository, and task tests**

Run: `npm test -- tests/integration/composition.spec.ts tests/unit/projectRepository.spec.ts tests/unit/taskState.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit the composition pipeline**

```bash
git add src/core/compose/compose.ts src/core/project src/stores/task.ts src/core/task/stateMachine.ts tests/integration/composition.spec.ts tests/unit/projectRepository.spec.ts tests/unit/taskState.spec.ts
git commit -m "feat: compose and persist Chinese PDF artifacts"
```

---

### Task 7: Show real Typst preview without claiming completion

**Files:**
- Modify: `src/components/processing/PaperPreview.vue`
- Modify: `src/views/ProcessingView.vue`
- Test: `tests/components/PaperPreview.spec.ts`

**Interfaces:**
- Consumes: trusted Typst SVG preview Blob URL and immutable asset manifest.
- Produces: paginated Chinese preview that updates after successful compilations.

- [ ] **Step 1: Write preview security and state tests**

```ts
// @vitest-environment jsdom
it('renders only a generated local preview URL', () => {
  const wrapper = mount(PaperPreview, { props: { title: '中文译文', previewUrl: 'blob:https://local/preview', state: 'ready' } });
  expect(wrapper.get('object').attributes('data')).toBe('blob:https://local/preview');
});

it('does not render arbitrary remote preview URLs', () => {
  const wrapper = mount(PaperPreview, { props: { title: '中文译文', previewUrl: 'https://attacker.invalid/x.svg', state: 'ready' } });
  expect(wrapper.find('object').exists()).toBe(false);
  expect(wrapper.text()).toContain('预览地址无效');
});
```

- [ ] **Step 2: Run the component test and verify failure**

Run: `npm test -- tests/components/PaperPreview.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Implement preview states**

Support `empty`, `building`, `ready`, and `failed`. Render an `<object type="image/svg+xml">` only for `blob:` URLs created by the app. Revoke the prior Blob URL when a new preview arrives or the component unmounts.

- [ ] **Step 4: Connect preview progress**

ProcessingView keeps the original PDF preview unchanged and updates the Chinese preview only after a compile succeeds. During translation it may display accepted text progress, but it must not synthesize or translate figure contents.

- [ ] **Step 5: Run component and build checks**

Run: `npm test -- tests/components/PaperPreview.spec.ts tests/components/ProcessingView.spec.ts && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit preview integration**

```bash
git add src/components/processing/PaperPreview.vue src/views/ProcessingView.vue tests/components/PaperPreview.spec.ts
git commit -m "feat: preview browser-compiled Chinese paper"
```

---

### Task 8: Add a real-browser Typst and immutable-asset quality gate

**Files:**
- Modify: `package.json`
- Create: `playwright.config.ts`
- Create: `tests/browser/typst-smoke.spec.ts`
- Create: `tests/fixtures/typst/mixed-paper.json`
- Create: `src/core/quality/compositionGate.ts`
- Test: `tests/unit/compositionGate.spec.ts`

**Interfaces:**
- Consumes: compiled PDF bytes, Typst preview, source/target asset hashes, layout regions, and marker IDs.
- Produces: `runCompositionGate(input): CompositionGateResult` and a browser smoke test.

- [ ] **Step 1: Install and configure Playwright**

Run:

```bash
npm install --save-dev --save-exact @playwright/test@1.62.1
npx playwright install chromium
```

Add scripts `test:browser: "playwright test"` and `test:all: "npm run test:ci && npm run test:browser"`. Configure `webServer.command` as `npm run dev -- --host 127.0.0.1`, `webServer.url` as `http://127.0.0.1:5173`, and Chromium only.

- [ ] **Step 2: Write composition-gate unit tests**

```ts
it('fails changed assets and missing markers', () => {
  const result = runCompositionGate({
    pdfHeader: '%PDF-',
    sourceAssetHashes: { 'fig-1': 'aaa', 'eq-1': 'bbb' },
    targetAssetHashes: { 'fig-1': 'ccc', 'eq-1': 'bbb' },
    requiredMarkerIds: ['title', 'fig-1', 'eq-1'],
    emittedMarkerIds: ['title', 'eq-1'],
    layoutRegionOrder: ['front', 'body'],
    emittedRegionOrder: ['front', 'body'],
  });
  expect(result.pass).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toEqual(['asset-hash-mismatch', 'marker-missing']);
});
```

- [ ] **Step 3: Implement the pure gate**

Require a PDF header, exact asset ID/hash equality, exact required-marker coverage, region order equality, and non-empty preview. Return deterministic issues sorted by `code` then `id`.

- [ ] **Step 4: Write the browser smoke test**

The test opens `/`, loads the committed mixed-paper JSON fixture through a test-only route guarded by `import.meta.env.DEV`, starts composition, waits for `data-stage="compiled"`, downloads the PDF, asserts `%PDF-`, and verifies the page preview contains Chinese title text plus an unchanged English label from the figure asset.

- [ ] **Step 5: Run all phase-two checks**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run test:browser
```

Expected: all checks pass; no network request targets jsDelivr, GitHub Releases, or a font CDN during the browser test.

- [ ] **Step 6: Commit the phase-two gate**

```bash
git add package.json package-lock.json playwright.config.ts tests/browser tests/fixtures/typst src/core/quality/compositionGate.ts tests/unit/compositionGate.spec.ts
git commit -m "test: gate browser Typst composition and immutable assets"
```

## Phase-Two Review Checklist

- Mixed regions preserve source order and layout mode.
- Chinese pages extend naturally and never force the English page count.
- Every figure, table, formula, code block, and page-furniture asset has a stable ID and hash.
- Caption units remain separate from immutable asset bytes.
- Typst WASM and renderer load only from the deployed site.
- Safe stop terminates the compiler worker.
- A valid downloadable Chinese PDF and preview are persisted, but reader completion still waits for alignment.
