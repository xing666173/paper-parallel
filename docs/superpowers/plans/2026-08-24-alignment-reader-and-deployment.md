# Paper Parallel Alignment, Dual-PDF Reader, and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build stable hybrid alignment between independently paginated English and Chinese PDFs, replace the text-card demo with a real dual-PDF reader, and make the verified application the deployed product.

**Architecture:** Stable semantic IDs connect source parse units, translations, Typst markers, and final PDF rectangles. English geometry comes from PDF.js text/image coordinates; Chinese geometry comes primarily from invisible Typst link annotations and falls back to sequential normalized text matching. The reader virtualizes actual PDF canvases, synchronizes by alignment anchors rather than page percentage, and persists/downloads a versioned project package.

**Tech Stack:** Vue 3.5, PDF.js 4.10, existing alignment/reader pure cores, TypeScript 5.6, Dexie 4, Vitest 3, Playwright 1.62, GitHub Actions and GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-08-24-paper-parallel-browser-typesetting-reader-design.md`

## Global Constraints

- English and Chinese PDFs have independent page counts and zoom state.
- Synchronization uses semantic IDs and actual PDF rectangles, never equal page numbers or raw scroll percentages.
- Body, list, and caption alignment uses sentence candidates grouped into continuous semantic relations (`1:1`, `1:n`, `n:1`, or `n:m`); headings are block-level; figures, tables, and formulas are asset-level; references are entry-level.
- The system never assumes equal English/Chinese sentence counts. Units that cannot be segmented or mapped reliably fall back to paragraph-level alignment and record that fallback.
- Immutable visual assets remain unchanged and align by stable `assetId`; captions align separately.
- Low-confidence and unmatched units remain visible in the quality report and cannot be silently counted as aligned.
- Scroll synchronization is bidirectional, throttled, echo-suppressed, and user-toggleable.
- The reader provides return-to-task, choose-new-file, confirmed current-cache clearing, Chinese PDF download, and project-package download.
- Completion and automatic reader navigation require translation, protected-content, PDF, asset, alignment, and persistence gates.
- CI becomes blocking before deployment; production routes no longer depend on P19 or synthetic reader data.

---

### Task 1: Build sentence-group relations from stable source candidates

**Files:**
- Modify: `src/types/models.ts`
- Create: `src/core/align/semanticUnits.ts`
- Modify: `src/core/align/index.ts`
- Test: `tests/unit/semanticUnits.spec.ts`

**Interfaces:**
- Consumes: the stable source candidates created before translation, validated translation `alignmentGroups`, and ordered non-text semantic units.
- Produces: expanded `AlignmentUnit`, `AlignmentRectSet`, `buildSemanticGroups(sourceCandidates, mappings)`, and `buildBlockAndAssetAlignmentUnits(units)`.

- [ ] **Step 1: Write cardinality, stable-target-ID, and fallback tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildSemanticGroups, buildBlockAndAssetAlignmentUnits } from '../../src/core/align/semanticUnits';

it.each(['figure', 'table', 'formula'] as const)('creates one asset unit for %s', (kind) => {
  const units = buildBlockAndAssetAlignmentUnits([{ id: `${kind}-1`, kind, assetId: `${kind}-1`, order: 10 }]);
  expect(units).toEqual([expect.objectContaining({ id: `${kind}-1`, kind: 'asset' })]);
});

it('represents merge and split mappings without forcing one-to-one sentences', () => {
  const source = {
    blockId: 'sec-1-p-3', mode: 'sentence-candidates' as const,
    sentences: [
      { id: 'sec-1-p-3-s-1', text: 'First result.' },
      { id: 'sec-1-p-3-s-2', text: 'Second result!' },
      { id: 'sec-1-p-3-s-3', text: 'Third result.' },
    ],
  };
  const groups = buildSemanticGroups(source, [
    { sourceSentenceIds: ['sec-1-p-3-s-1', 'sec-1-p-3-s-2'], targetSegments: ['前两个结果合并说明。'] },
    { sourceSentenceIds: ['sec-1-p-3-s-3'], targetSegments: ['第三个结果。', '补充说明。'] },
  ]);
  expect(groups[0]).toMatchObject({
    id: 'sec-1-p-3-g-1', relation: 'n:1',
    sourceUnitIds: ['sec-1-p-3-s-1', 'sec-1-p-3-s-2'],
    targetUnitIds: ['sec-1-p-3-g-1-t-1'],
  });
  expect(groups[1]).toMatchObject({
    id: 'sec-1-p-3-g-2', relation: '1:n',
    sourceUnitIds: ['sec-1-p-3-s-3'],
    targetUnitIds: ['sec-1-p-3-g-2-t-1', 'sec-1-p-3-g-2-t-2'],
  });
});

it('keeps an ambiguous source block as an explicit paragraph fallback', () => {
  const groups = buildSemanticGroups(
    { blockId: 'eq-lead', mode: 'paragraph-fallback', sentences: [{ id: 'eq-lead', text: 'where x_i: y_i; z_i' }] },
    [{ sourceSentenceIds: ['eq-lead'], targetSegments: ['其中 x_i：y_i；z_i。'] }],
  );
  expect(groups).toEqual([expect.objectContaining({
    id: 'eq-lead', kind: 'block', relation: 'paragraph-fallback',
    fallbackReason: 'sentence-boundary-ambiguous',
  })]);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- tests/unit/semanticUnits.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Replace the old alignment shape with fragment-aware geometry**

```ts
export interface AlignmentRectSet {
  page: number;
  rects: Rect[];
}

export interface AlignmentUnit {
  id: string;
  parentId?: string;
  kind: 'semantic-group' | 'block' | 'asset' | 'reference';
  relation: '1:1' | '1:n' | 'n:1' | 'n:m' | 'paragraph-fallback' | 'block' | 'asset' | 'reference';
  sourceUnitIds: string[];
  targetUnitIds: string[];
  sourceText?: string;
  targetText?: string;
  source: AlignmentRectSet[];
  target: AlignmentRectSet[];
  confidence: number;
  status: 'aligned' | 'low-confidence' | 'unmatched';
  fallbackReason?: string;
}
```

Keep a migration adapter from legacy `enBlockIds`/`zhBlockIds` for existing tests until Task 6 replaces all reader callers.

- [ ] **Step 4: Implement deterministic semantic groups**

Consume the candidate result persisted by the translation workflow; do not split either language again here. `buildSemanticGroups()` accepts only validated continuous mappings, assigns deterministic group and target IDs from their local order, classifies cardinality, and never guesses a one-to-one relation from punctuation alone. A source candidate result with `mode: 'paragraph-fallback'` emits one block-level unit with `relation: 'paragraph-fallback'`. Headings stay block-level; references split only at entry boundaries supplied by the parser; figures, tables, and formulas remain asset units.

- [ ] **Step 5: Run alignment regression**

Run: `npm test -- tests/unit/semanticUnits.spec.ts tests/unit/align.spec.ts tests/unit/alignBlocks.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit stable units**

```bash
git add src/types/models.ts src/core/align/semanticUnits.ts src/core/align/index.ts tests/unit/semanticUnits.spec.ts
git commit -m "feat: define stable hybrid alignment units"
```

---

### Task 2: Resolve English sentence-group and asset geometry

**Files:**
- Create: `src/core/align/sourceGeometry.ts`
- Modify: `src/core/parser/charRects.ts`
- Test: `tests/unit/sourceGeometry.spec.ts`

**Interfaces:**
- Consumes: source semantic units, block text, `charRects`, block fragments, and immutable asset rectangles.
- Produces: `resolveSourceGeometry(units, doc, assets): AlignmentUnit[]`, with each semantic group's source rectangles equal to the ordered union of its `sourceUnitIds`.

- [ ] **Step 1: Write geometry-fragment tests**

```ts
it('groups sentence-group character boxes into line rectangles', () => {
  const resolved = resolveTextRangeRects({
    page: 0,
    start: 0,
    end: 6,
    charRects: [
      { x: 10, y: 20, w: 5, h: 10 }, { x: 15, y: 20, w: 5, h: 10 },
      { x: 20, y: 20, w: 5, h: 10 }, { x: 10, y: 32, w: 5, h: 10 },
      { x: 15, y: 32, w: 5, h: 10 }, { x: 20, y: 32, w: 5, h: 10 },
    ],
  });
  expect(resolved).toEqual([{ page: 0, rects: [
    { x: 10, y: 20, w: 15, h: 10 },
    { x: 10, y: 32, w: 15, h: 10 },
  ] }]);
});

it('uses the immutable asset source rectangle without text matching', () => {
  const aligned = resolveSourceGeometry([assetUnit], sourceDoc, [figAsset]);
  expect(aligned[0].source).toEqual([{ page: figAsset.sourcePage, rects: [figAsset.sourceRect] }]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/unit/sourceGeometry.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Add character-range lookup**

Extend parser text blocks with a mapping from normalized character indices to `{ pageIndex, rect }`. Preserve page changes for cross-page paragraphs. Do not manufacture evenly spaced boxes when PDF.js already supplies real item geometry.

- [ ] **Step 4: Merge only boxes on the same visual line**

Treat boxes as the same line when their vertical centers differ by at most 35% of the larger height and horizontal gap is at most two average character widths. Store separate `AlignmentRectSet` entries when the page changes.

- [ ] **Step 5: Resolve assets and references**

Asset units copy `sourcePage/sourceRect` directly from `ImmutableAsset`. Reference units use the parsed reference-entry block rectangle. Missing geometry sets status `unmatched`, confidence `0`, and does not throw away the unit.

- [ ] **Step 6: Run source geometry and parser regression**

Run: `npm test -- tests/unit/sourceGeometry.spec.ts tests/unit/parser.spec.ts tests/unit/docBuilder.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit source geometry**

```bash
git add src/core/align/sourceGeometry.ts src/core/parser/charRects.ts tests/unit/sourceGeometry.spec.ts
git commit -m "feat: resolve source semantic-group and asset geometry"
```

---

### Task 3: Read Chinese marker rectangles with text-matching fallback

**Files:**
- Create: `src/core/align/targetMarkers.ts`
- Create: `src/core/align/textFallback.ts`
- Test: `tests/unit/targetMarkers.spec.ts`
- Test: `tests/unit/textFallback.spec.ts`

**Interfaces:**
- Consumes: compiled Chinese PDF.js document, stable target-segment IDs, translated segment text, and semantic groups.
- Produces: `readTargetMarkers(pdf)`, `matchTranslatedText(pdf, segments)`, and target `AlignmentRectSet[]` merged by each group's `targetUnitIds`.

- [ ] **Step 1: Write marker URL and rectangle tests**

```ts
it('extracts and groups Paper Parallel annotations by stable unit ID', async () => {
  const markers = await readTargetMarkers(fakePdf([
    { url: 'https://paper-parallel.invalid/unit/sec-1-p-1-s-1', rect: [10, 20, 80, 32] },
    { url: 'https://paper-parallel.invalid/unit/sec-1-p-1-s-1', rect: [10, 34, 70, 46] },
    { url: 'https://example.com', rect: [0, 0, 1, 1] },
  ]));
  expect(markers.get('sec-1-p-1-s-1')).toEqual([{ page: 0, rects: [
    { x: 10, y: 20, w: 70, h: 12 },
    { x: 10, y: 34, w: 60, h: 12 },
  ] }]);
});
```

- [ ] **Step 2: Write normalized sequential fallback tests**

```ts
it('matches text despite PDF line breaks and inserted hyphenation', async () => {
  const result = await matchTranslatedText(fakeTextPdf([
    { str: '高性能异构加速', page: 0, rect: r1 },
    { str: '器能够降低延迟。', page: 0, rect: r2 },
  ]), [{ id: 's1', targetText: '高性能异构加速器能够降低延迟。' }]);
  expect(result.get('s1')?.status).toBe('aligned');
  expect(result.get('s1')?.rects).toHaveLength(2);
});

it('does not ignore changed numbers during fallback matching', async () => {
  const result = await matchTranslatedText(fakeTextPdf([{ str: '准确率为 69%。', page: 0, rect: r1 }]), [
    { id: 's1', targetText: '准确率为 96%。' },
  ]);
  expect(result.get('s1')?.status).toBe('unmatched');
});
```

- [ ] **Step 3: Run tests and verify failure**

Run: `npm test -- tests/unit/targetMarkers.spec.ts tests/unit/textFallback.spec.ts`

Expected: FAIL.

- [ ] **Step 4: Implement annotation extraction**

Call `page.getAnnotations({ intent: 'display' })`, accept only exact prefix `https://paper-parallel.invalid/unit/`, decode the suffix, convert PDF bottom-left coordinates into top-left viewport rectangles, and group multiple annotations by ID and page. External links remain untouched and are never alignment markers.

- [ ] **Step 5: Implement sequential text fallback**

Build one normalized text stream in reading order with a source range for every PDF.js text item. Normalize Unicode NFKC, standard spaces, and line-end hyphenation only. Preserve digits, signs, citations, symbols, and punctuation. Match target segments in semantic order starting after the previous match so repeated text cannot map backward, then union segment rectangles into their semantic groups.

- [ ] **Step 6: Run target geometry tests**

Run: `npm test -- tests/unit/targetMarkers.spec.ts tests/unit/textFallback.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit target geometry**

```bash
git add src/core/align/targetMarkers.ts src/core/align/textFallback.ts tests/unit/targetMarkers.spec.ts tests/unit/textFallback.spec.ts
git commit -m "feat: resolve target PDF alignment geometry"
```

---

### Task 4: Build and quality-gate the alignment manifest

**Files:**
- Create: `src/core/align/manifest.ts`
- Create: `src/core/quality/alignmentGate.ts`
- Modify: `src/core/project/repository.ts`
- Test: `tests/unit/alignmentManifest.spec.ts`

**Interfaces:**
- Consumes: semantic groups with source geometry, target-segment markers, fallback matches, and project ID.
- Produces: `buildAlignmentManifest(input)`, `AlignmentManifest`, and `runAlignmentGate(manifest)`.

- [ ] **Step 1: Write manifest merge and quality tests**

```ts
it('prefers marker geometry and records fallback confidence', () => {
  const manifest = buildAlignmentManifest({
    projectId: 'p1',
    units: [sourceGroup, sourceAsset],
    markers: new Map([['p1-g-1-t-1', markerGeometry]]),
    fallback: new Map([['asset-1', { ...fallbackGeometry, confidence: 0.82 }]]),
  });
  expect(manifest.units[0]).toMatchObject({ id: 'p1-g-1', relation: 'n:1', confidence: 1, status: 'aligned' });
  expect(manifest.units[1]).toMatchObject({ id: 'asset-1', confidence: 0.82, status: 'low-confidence' });
});

it('reports every unmatched unit instead of dropping it', () => {
  const gate = runAlignmentGate(unmatchedManifest);
  expect(gate.pass).toBe(false);
  expect(gate.issues).toEqual([expect.objectContaining({ code: 'unit-unmatched', unitId: 's2' })]);
});

it('collapses unreliable child groups to a verified paragraph fallback', () => {
  const manifest = buildAlignmentManifest({
    ...lowConfidenceGroupFixture,
    paragraphFallback: new Map([['p1', { source: paragraphSourceGeometry, target: paragraphTargetGeometry, confidence: 0.98 }]]),
  });
  expect(manifest.units).toContainEqual(expect.objectContaining({
    id: 'p1', kind: 'block', relation: 'paragraph-fallback', status: 'aligned',
    fallbackReason: 'group-geometry-low-confidence',
  }));
  expect(manifest.units.some((unit) => unit.id === 'p1-g-1')).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- tests/unit/alignmentManifest.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Define a versioned manifest**

```ts
export interface AlignmentManifest {
  schemaVersion: 1;
  projectId: string;
  createdAt: number;
  units: AlignmentUnit[];
  stats: {
    total: number;
    aligned: number;
    lowConfidence: number;
    unmatched: number;
    coverage: number;
  };
}
```

- [ ] **Step 4: Implement deterministic merging**

When every target ID in a semantic group has marker geometry, their ordered union has confidence `1`. Text fallback confidence is its exact normalized-character coverage multiplied by an order-consistency factor. If one or more child groups fall below `0.9`, attempt one full-parent source/target text match; coverage of at least `0.98` replaces those child groups with one `paragraph-fallback` unit and records `group-geometry-low-confidence`. If that parent match also fails, keep the child groups as `low-confidence` or `unmatched`. Preserve groups in source order and expose their relation type in the manifest and quality report.

- [ ] **Step 5: Persist the manifest and run the gate**

Save JSON as `alignment-manifest` artifact. The gate fails automatic completion when any required unit remains unmatched after paragraph fallback. Verified paragraph fallbacks pass with a visible granularity warning. Remaining low-confidence units produce warnings and remain visible; the user can still read the generated PDFs after acknowledging the report, but the automatic “all checks passed” label is withheld.

- [ ] **Step 6: Run alignment tests**

Run: `npm test -- tests/unit/alignmentManifest.spec.ts tests/unit/align.spec.ts tests/unit/alignBlocks.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit the manifest**

```bash
git add src/core/align/manifest.ts src/core/quality/alignmentGate.ts src/core/project/repository.ts tests/unit/alignmentManifest.spec.ts
git commit -m "feat: build quality-gated alignment manifests"
```

---

### Task 5: Render real PDF pages with overlays and virtualization

**Files:**
- Create: `src/core/pdf/runtime.ts`
- Create: `src/components/reader/PdfPane.vue`
- Create: `src/components/reader/AlignmentOverlay.vue`
- Test: `tests/components/PdfPane.spec.ts`

**Interfaces:**
- Consumes: PDF Blob, side, alignment rectangles, active unit ID, page, and zoom.
- Produces: virtualized PDF canvases, page metrics, scroll events, page-change events, and unit-click events.

- [ ] **Step 1: Write component contract tests**

```ts
// @vitest-environment jsdom
it('renders independent page labels and an unobtrusive active overlay', async () => {
  const wrapper = mount(PdfPane, {
    props: {
      side: 'en',
      title: '英文原文',
      pageCount: 8,
      pageMetrics: [{ width: 612, height: 792 }],
      visiblePages: [0],
      activeRects: [{ page: 0, rects: [{ x: 72, y: 210, w: 220, h: 42 }] }],
      zoom: 1,
    },
  });
  expect(wrapper.text()).toContain('英文原文');
  expect(wrapper.get('[data-page="0"]').exists()).toBe(true);
  expect(wrapper.get('[data-alignment-overlay]').attributes('style')).toContain('pointer-events: none');
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npm test -- tests/components/PdfPane.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Configure PDF.js worker once**

```ts
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export { getDocument };
```

- [ ] **Step 4: Implement page virtualization**

Load the document from `new Uint8Array(await blob.arrayBuffer())`. Measure all page viewports at zoom 1 but render canvases only for the current viewport page plus two pages before/after. Cancel obsolete `RenderTask`s on zoom, document replacement, and unmount. Keep spacer elements for unrendered pages so scroll coordinates remain stable.

- [ ] **Step 5: Implement PDF-coordinate overlays**

Convert each source PDF rectangle with the page viewport transform and render absolutely positioned translucent blue rectangles. Use one overlay element per fragment, `pointer-events: none`, and an outline that does not obscure text. Clicking the page uses a spatial index to emit the nearest unit ID.

- [ ] **Step 6: Run component and build checks**

Run: `npm test -- tests/components/PdfPane.spec.ts && npm run typecheck && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit real PDF rendering**

```bash
git add src/core/pdf/runtime.ts src/components/reader/PdfPane.vue src/components/reader/AlignmentOverlay.vue tests/components/PdfPane.spec.ts
git commit -m "feat: render virtualized PDF pages with alignment overlays"
```

---

### Task 6: Upgrade synchronization from block cards to PDF rectangle anchors

**Files:**
- Modify: `src/core/reader/reader.core.js`
- Modify: `src/core/reader/index.ts`
- Modify: `tests/unit/reader.spec.ts`

**Interfaces:**
- Consumes: alignment manifest, page top offsets, page scales, viewport center, and scroll source.
- Produces: `buildPdfPositionIndex()`, `resolvePdfSyncCommand()`, and existing echo suppression with rectangle fragments.

- [ ] **Step 1: Add independent-page and interpolation tests**

```ts
it('maps English page 4 to Chinese page 6 by semantic anchor', () => {
  const command = resolvePdfSyncCommand({
    side: 'en',
    viewportCenter: 4_250,
    sourceIndex: enIndex,
    targetIndex: zhIndex,
    unitMap,
    targetViewportHeight: 700,
  });
  expect(command).toMatchObject({ targetSide: 'zh', unitId: 'sec-3-p-2-s-1', targetPage: 5 });
});

it('interpolates between surrounding units inside a long paragraph', () => {
  const command = resolvePdfSyncCommand(interpolationFixture);
  expect(command.targetScrollTop).toBeGreaterThan(interpolationFixture.previousTargetTop);
  expect(command.targetScrollTop).toBeLessThan(interpolationFixture.nextTargetTop);
});
```

- [ ] **Step 2: Run reader tests and verify failure**

Run: `npm test -- tests/unit/reader.spec.ts`

Expected: FAIL for the new APIs.

- [ ] **Step 3: Build absolute anchor indices**

For each fragment, calculate absolute top/bottom from page offset plus scaled PDF rectangle. A unit anchor is the vertical center of its first visible fragment; keep all fragments for active highlighting. Build per-side sorted arrays and ID maps.

- [ ] **Step 4: Resolve synchronization with interpolation and clamping**

Find the unit nearest the active viewport center. When previous and next mapped units bracket the center, linearly interpolate the target position. Clamp to the target pane scroll range. Keep the existing side lock and epsilon-based echo suppression; do not directly set the other pane when sync is disabled.

- [ ] **Step 5: Run all reader core tests**

Run: `npm test -- tests/unit/reader.spec.ts`

Expected: PASS for legacy adapter and new PDF synchronization.

- [ ] **Step 6: Commit synchronization**

```bash
git add src/core/reader/reader.core.js src/core/reader/index.ts tests/unit/reader.spec.ts
git commit -m "feat: synchronize independent PDFs by semantic anchors"
```

---

### Task 7: Replace the reader demo with the completed dual-PDF reader

**Files:**
- Create: `src/components/reader/ReaderToolbar.vue`
- Rewrite: `src/components/reader/ReaderView.vue`
- Rewrite: `src/views/ReaderTaskView.vue`
- Test: `tests/components/ReaderTaskView.spec.ts`

**Interfaces:**
- Consumes: English/Chinese PDF artifacts, alignment manifest, project repository, task route, and router.
- Produces: full reader UI, independent navigation, sync/highlight toggles, downloads, return, choose-file, and cache-clear actions through `clearProjectDerivedData(projectId)`.

- [ ] **Step 1: Write reader workflow component tests**

```ts
// @vitest-environment jsdom
it('shows independent counts and all task actions', () => {
  const wrapper = mountReader({ enPages: 8, zhPages: 11 });
  expect(wrapper.text()).toContain('英文 1 / 8');
  expect(wrapper.text()).toContain('中文 1 / 11');
  expect(wrapper.text()).toContain('返回翻译任务');
  expect(wrapper.text()).toContain('重新选择文件');
  expect(wrapper.text()).toContain('清除翻译缓存');
  expect(wrapper.text()).toContain('下载中文 PDF');
  expect(wrapper.text()).toContain('下载项目包');
});

it('requires confirmation before clearing only the current project cache', async () => {
  const { wrapper, repo } = mountReaderWithRepository({ confirmResult: false });
  await wrapper.get('[data-action="clear-cache"]').trigger('click');
  expect(repo.clearProjectDerivedData).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/components/ReaderTaskView.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the toolbar**

Include return, overflow task menu, per-side page navigation, zoom minus/value/plus, fit width, sync toggle, alignment toggle, Chinese PDF download, and project-package download. The cache-clear action is visually cautionary and requires a confirmation dialog naming the current project.

- [ ] **Step 4: Rewrite `ReaderView.vue` around two `PdfPane` components**

Remove all `.blk` text-card rendering and synthetic `pageH`. Load English and Chinese artifact Blobs, create independent page state, feed active rectangles from the manifest, and call `resolvePdfSyncCommand()` from throttled pane scroll events. Clicking either pane sets the active unit and centers its counterpart.

- [ ] **Step 5: Implement route semantics**

- Return: route to `/task/:projectId/process` without changing cache.
- Choose file: route to `/`; keep prior project in history.
- Clear cache: after confirmation, call `clearProjectDerivedData(projectId)` to delete the current project's translations and every artifact except `kind === 'english-pdf'`; preserve the source PDF Blob, other projects, API-key storage, and project history, then route to the upload page with a cleared-task notice. Add this repository method in `src/core/project/repository.ts` and cover both the preservation and project-isolation rules in `tests/unit/projectRepository.spec.ts`.
- Completed navigation toast: show once when route query contains `auto=1`, then remove the query with `router.replace`.

- [ ] **Step 6: Run component and reader tests**

Run: `npm test -- tests/components/ReaderTaskView.spec.ts tests/components/PdfPane.spec.ts tests/unit/reader.spec.ts`

Expected: PASS and no component imports hardcoded demo blocks.

- [ ] **Step 7: Commit the reader**

```bash
git add src/components/reader src/views/ReaderTaskView.vue tests/components/ReaderTaskView.spec.ts
git commit -m "feat: replace text cards with dual PDF reader"
```

---

### Task 8: Version and download a secret-free project package

**Files:**
- Create: `src/core/project/package.ts`
- Modify: `src/core/project/repository.ts`
- Test: `tests/unit/projectPackage.spec.ts`

**Interfaces:**
- Consumes: project metadata, source/target PDF artifacts, terminology, semantic units, immutable asset manifest, audit results, and alignment manifest.
- Produces: `buildProjectPackage(projectId, repository): Promise<Blob>`.

- [ ] **Step 1: Write package-content and secret-scan tests**

```ts
it('includes recoverable artifacts and excludes secrets/log internals', async () => {
  const blob = await buildProjectPackage('p1', seededRepository);
  const zip = await JSZip.loadAsync(blob);
  expect(Object.keys(zip.files).sort()).toEqual([
    'alignment.json',
    'assets.json',
    'audit.json',
    'english.pdf',
    'glossary.json',
    'project.json',
    'source-units.json',
    'target-units.json',
    'translation.json',
    'translation.typ',
    'chinese.pdf',
  ].sort());
  const allText = await Promise.all(Object.values(zip.files).filter((file) => !file.dir).map((file) => file.async('string').catch(() => '')));
  expect(allText.join('\n')).not.toMatch(/sk-[A-Za-z0-9]/);
  expect(allText.join('\n')).not.toContain('Authorization');
  expect(allText.join('\n')).not.toContain('reasoning_content');
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- tests/unit/projectPackage.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Define package schema version 1**

`project.json` includes `schemaVersion: 1`, project ID/name/timestamps, prompt version, model ID, thinking mode, source file hash, page counts, and artifact checksums. It explicitly excludes API key, raw authorization data, and hidden reasoning.

- [ ] **Step 4: Build and scan the ZIP**

Use existing JSZip. Serialize JSON with stable two-space formatting. Add PDFs and Typst as binary/text. Before `generateAsync`, recursively scan all JSON values and text files for key names `apiKey`, `authorization`, `reasoning_content` and values beginning `sk-`; throw `项目包包含敏感字段` on a hit.

- [ ] **Step 5: Run package tests**

Run: `npm test -- tests/unit/projectPackage.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit package export**

```bash
git add src/core/project/package.ts src/core/project/repository.ts tests/unit/projectPackage.spec.ts
git commit -m "feat: export recoverable secret-free project packages"
```

---

### Task 9: End-to-end browser verification and production migration

**Files:**
- Create: `tests/browser/full-workflow.spec.ts`
- Create: `tests/browser/reader-sync.spec.ts`
- Modify: `.github/workflows/deploy.yml`
- Modify: `vite.config.ts`
- Modify: `README.md`
- Modify: `docs/FINAL-TEST-RUNBOOK.md`
- Modify: `docs/VERIFICATION-MATRIX.md`

**Interfaces:**
- Consumes: the complete application and committed browser fixtures.
- Produces: blocking CI evidence and the final GitHub Pages application.

- [ ] **Step 1: Write a browser workflow test with deterministic mocked DeepSeek responses**

Intercept `https://api.deepseek.com/models` and `/chat/completions`, upload the mixed-layout fixture PDF, select V4 Flash, start processing, assert the AI log reports batches without secrets, wait for compilation/alignment/quality success, and assert automatic navigation to `/task/<id>/read?auto=1`.

The test then asserts:

```ts
await expect(page.getByText('英文 1 / 8')).toBeVisible();
await expect(page.getByText('中文 1 / 11')).toBeVisible();
await expect(page.getByText('翻译排版完成，已自动进入对照阅读')).toBeVisible();
await expect(page.locator('[data-pdf-side="en"] canvas')).toHaveCount(1);
await expect(page.locator('[data-pdf-side="zh"] canvas')).toHaveCount(1);
```

- [ ] **Step 2: Write bidirectional synchronization tests**

Scroll the English pane to a known source sentence inside a semantic group on page 4 and assert the Chinese pane active page becomes 6 and the whole corresponding target group is highlighted. Repeat from any target segment to English. Disable `同步滚动`, scroll again, and assert the other pane does not move. Verify no oscillation by counting scroll events for 500 ms after settling.

- [ ] **Step 3: Add stop/resume and cache-clear browser cases**

Delay a batch response, click `安全停止`, assert no new requests start and validated count remains. Reload, resume, and assert cached blocks emit `缓存命中`. In the reader, cancel cache clear once, then confirm it and assert only the current project translation artifacts disappear.

- [ ] **Step 4: Make CI blocking and deploy only verified output**

Replace the current two-job permissive workflow with one test job followed by deploy:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci --no-audit --no-fund
      - run: npx playwright install --with-deps chromium
      - run: npm run test:all
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist
  deploy:
    if: github.ref == 'refs/heads/main'
    needs: test
    permissions:
      contents: write
    runs-on: ubuntu-latest
```

The deploy job downloads the tested `dist` artifact and publishes it. Remove `continue-on-error` and do not build a second untested artifact.

- [ ] **Step 5: Stop copying probes into the production navigation path**

Keep probe source files in the repository for historical regression, but remove the Vite production plugin that copies `probes` and raw `src/core` into `dist`. No final UI link points to P19. If probe hosting is still needed, add a separate opt-in `build:probes` script that is not used by Pages deployment.

- [ ] **Step 6: Update runbook and verification matrix**

Document exact checks for model discovery, generic prompt, terminology override, immutable asset hashes, mixed layout, natural page extension, safe stop, automatic navigation, independent page counts, both sync directions, cache clearing, downloads, refresh recovery, and absence of secrets.

- [ ] **Step 7: Run the final local gate**

Run:

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run test:browser
npm run build
```

Expected: all commands exit zero; `dist` contains the app and local Typst WASM; it contains no `probes/P19-e2e-runner.html`; no built JavaScript contains `deepseek-chat` as a default.

- [ ] **Step 8: Commit production migration**

```bash
git add tests/browser .github/workflows/deploy.yml vite.config.ts README.md docs/FINAL-TEST-RUNBOOK.md docs/VERIFICATION-MATRIX.md package.json package-lock.json
git commit -m "test: gate and deploy the complete Paper Parallel workflow"
```

## Final Review Checklist

- The reader displays two actual PDFs and no text-card substitute.
- English and Chinese page counts and navigation remain independent.
- Every visible highlight originates from a manifest unit with real PDF geometry.
- Figure/table/formula assets align separately from translated captions.
- Unmatched and low-confidence units remain reported.
- Safe stop, reload resume, back navigation, choose-file, and confirmed current-cache clearing work.
- Chinese PDF and project ZIP download without API key or hidden reasoning.
- Blocking CI tests the same artifact deployed to GitHub Pages.
