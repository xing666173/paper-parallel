# Vision-Guided PDF Quality Design

## Goal

Produce a readable Chinese academic PDF in the browser while preserving every source figure, table, and formula, inheriting single-column, double-column, and mixed layout regions, and rejecting unusable output before it reaches the reader.

## Confirmed failure modes

1. The bundled WOFF font is fetched successfully but is not registered as a usable Typst font. Typst therefore emits a syntactically valid PDF with no rendered Chinese text.
2. The current equation heuristic treats centered prose containing hyphens, parentheses, or citations as display math. On the ZK-Tracer paper, 47 blocks are classified as formulas and at least 36 are obvious prose.
3. Caption-derived figure crops can begin at page coordinate `y = 0` or cover an excessive fraction of a page. The crop hash remains stable even though the selected source region is semantically wrong.
4. The production pipeline persists the compiled PDF before validating its readable content. The gate checks the `%PDF-` header, marker coverage, and asset hashes, but not embedded fonts, extractable Chinese text, blank pages, clipping, or overlap.
5. The browser smoke test verifies only that a PDF download exists. It does not render or inspect the downloaded PDF.
6. `deepseek-v4-flash-vision-exp` is selectable, but current translation calls send text only. Its visual capability is not used.

## Product behavior

### Model roles

- The user-selected translation model remains `deepseek-v4-flash`, `deepseek-v4-pro`, or `deepseek-v4-flash-vision-exp`.
- Layout analysis and product quality validation always use `deepseek-v4-flash-vision-exp`.
- Vision calls explicitly disable thinking and request strict JSON to reduce latency and response variance.
- Visual analysis results are cached by source file hash, rendered page hash, vision prompt version, and model ID.

### Pipeline

1. PDF.js extracts the source text layer, page geometry, and preliminary local layout.
2. PDF.js renders each source page to PNG.
3. Vision Exp performs a full-page layout pass and returns normalized regions for figures, tables, display formulas, code, captions, headers, footers, and body text.
4. Low-confidence or geometrically conflicting regions receive a second cropped-image pass.
5. Local geometry reconciles the vision candidates with PDF text blocks and whitespace boundaries. Vision coordinates are never used as crop coordinates without validation and snapping.
6. Only translatable text and captions are sent to the selected translation model. Figure bodies, table bodies, display formulas, and code remain immutable source crops.
7. Typst compiles with a local TTF/OTF font that covers Simplified Chinese.
8. A deterministic PDF gate verifies the PDF header, embedded/extractable target text, translated-unit coverage, page rendering, asset geometry, and page-content sanity.
9. Vision Exp compares tiled source and target page renders and reports missing text, overlap, clipping, wrong assets, layout-mode mismatch, and unreadable regions.
10. The PDF, Typst source, preview, and alignment manifest are persisted only after every mandatory gate passes. The reader route is entered only after persistence succeeds.

### Vision layout contract

The model returns JSON with one page record per request:

```json
{
  "page": 1,
  "layout": "mixed",
  "regions": [
    {
      "type": "figure",
      "bbox": [510, 180, 960, 470],
      "column": "right",
      "caption_bbox": [520, 480, 940, 525],
      "confidence": 0.96
    }
  ]
}
```

- Coordinates are integers in the inclusive `0..1000` normalized coordinate space.
- `type` is one of `figure`, `table`, `display_formula`, `code`, `caption`, `header`, `footer`, or `body_text`.
- `column` is one of `left`, `right`, or `full`.
- Figure/table body boxes include internal labels and legends but exclude captions.
- Display formula boxes include their equation number.
- Inline formulas remain part of body text.

### Reconciliation rules

- A vision box must be inside the page, have positive area, and not overlap an unrelated immutable box beyond the configured tolerance.
- Crop edges snap to nearby whitespace and source block boundaries.
- A locally classified formula remains immutable only when a vision display-formula region overlaps it or a strict math-dominance classifier independently confirms it.
- Prose density, long alphabetic word runs, citation-only brackets, and ordinary parenthesized enumeration count against formula classification.
- Figure/table boxes that touch a page edge, cover an implausible page fraction, contain a high density of external body-text blocks, or cannot be separated from a caption fail closed.
- A low-confidence conflict triggers a targeted second vision pass. An unresolved conflict stops the task with the page number and region type.

### Deterministic compiled-PDF gate

The gate must reject output when any of these conditions holds:

- The output does not begin with `%PDF-`.
- No target text items are extractable.
- Expected Chinese translation exists but no Chinese code points are extracted.
- Extracted text coverage is below a conservative threshold relative to rendered translation units.
- A target page cannot render through PDF.js.
- Required immutable assets or alignment markers are missing.
- A page is effectively blank despite assigned content.
- The output was persisted before the gate completed.

### Final visual review contract

- Render source and target pages in the browser.
- Send full-page pairs for coarse layout and column-level or region-level tiles for legibility and crop inspection.
- Return strict JSON issues with page, type, severity, normalized bbox, confidence, and concise evidence.
- Severe findings (`missing_text`, `overlap`, `clipping`, `wrong_asset`, `layout_mode_mismatch`, `unreadable`) stop the task.
- Visual review cannot override a deterministic failure.

### UI and recovery

- Progress logs identify `Vision Exp` layout analysis, local geometry reconciliation, translation, deterministic PDF validation, and final visual validation separately.
- Per-page vision results and validated translations survive reloads.
- Stop aborts active text and vision requests and retains validated cache entries.
- Retry resumes only failed or unresolved pages/blocks.
- The UI discloses that page images are sent to DeepSeek and incur additional token cost.

## Release acceptance

The exact ZK-Tracer source paper must be tested in two complete real-API paths:

1. Flash translation plus Vision Exp layout/final validation.
2. Vision Exp translation plus Vision Exp layout/final validation.

For each path:

- Complete without manual continue clicks.
- Download the final PDF.
- Render and visually inspect every final page.
- Verify extractable Chinese text and embedded fonts.
- Verify figures, tables, and formulas remain unchanged while captions are translated.
- Verify single-column, double-column, full-width, and mixed regions.
- Verify reader synchronization, highlighting, stop/resume, cache reuse, and error recovery.

No result may be described as complete until both paths satisfy these checks.
