export const VISION_LAYOUT_PROMPT_VERSION = 'vision-layout-v4';

export function buildVisionLayoutPrompt(pageNumber: number): string {
  return [
    'You are inspecting one rendered page of an academic paper before translation and typesetting.',
    `This is source page ${pageNumber}.`,
    'Identify the page layout and only visual assets that must remain pixel-identical in the translated paper.',
    'Set layout=mixed whenever full-width title/abstract/figure regions coexist with two-column body text; do not call such a page single.',
    'Immutable regions are: figures, table bodies, display formulas, and code. Do not include a figure/table caption inside its immutable bbox.',
    'Return one region per numbered Figure/Table, never a second region for an internal panel or subdiagram.',
    'bbox must be tight around visible asset ink. Exclude all surrounding prose, headers, whitespace, and the complete caption line.',
    'column describes the asset itself: use left/right for a one-column asset and full only when the asset physically spans both columns.',
    'Captions are translatable text: return their tight separate caption_bbox when associated with a figure or table.',
    'Return at most 32 regions. Do not return body text, captions as standalone regions, headings, citations, inline math, headers, or footers.',
    'Every box must be an object {"x":number,"y":number,"width":number,"height":number} in normalized 0..1000 page coordinates. Never return pixel coordinates or x1/y1/x2/y2.',
    'Return exactly one JSON object with this schema:',
    '{"page":1,"layout":"single|double|mixed","regions":[{"type":"figure|table|display_formula|code","bbox":{"x":0,"y":0,"width":1,"height":1},"column":"left|right|full","caption_bbox":{"x":0,"y":0,"width":1,"height":1},"confidence":0.0}]}',
    'Use the actual page number above in page. Omit caption_bbox when it does not apply. Do not return prose or Markdown.',
  ].join('\n');
}

export const VISION_FINAL_REVIEW_PROMPT_VERSION = 'vision-final-review-v4';

export function buildVisionFinalReviewPrompt(
  targetPageNumber: number,
  sourcePageNumbers: readonly number[],
  compact = false,
): string {
  const sourceReference = sourcePageNumbers.length
    ? `The source reference images are pages ${sourcePageNumbers.join(', ')}. The final image is translated target page ${targetPageNumber}.`
    : `Only translated target page ${targetPageNumber} is attached. Immutable source assets were already verified byte-for-byte by deterministic gates.`;
  const prompt = [
    'You are the final visual quality inspector for a translated academic-paper PDF.',
    sourceReference,
    'Natural repagination and different Chinese line breaks are allowed. Single-column, double-column, and mixed regions should preserve the source layout mode.',
    'Figures, table bodies, display formulas, code, variables, symbols, and internal figure labels must be visibly intact. Captions may be translated.',
    'Do not report small or fine English labels inside verified immutable assets as unreadable merely because they are dense. Report unreadable_glyphs only for visible corruption such as missing, clipped, overlapped, block, or replacement glyphs; ordinary small source labels are not defects.',
    'Report only visible production defects: missing/clipped/overlapping text, unreadable glyphs, untranslated body prose, collapsed columns, or changed/missing immutable assets.',
    'Return at most 6 representative issues. Merge repeated instances of the same visible defect and keep evidence under 12 words. Never transcribe page text.',
    'Do not judge translation style or wording. Do not report harmless spacing or natural page extension as severe.',
    'A source reference page may contain assets that naturally moved to adjacent target pages. Never report a source-only asset as missing unless its translated caption is visibly present on this target page without the asset.',
    ...(sourcePageNumbers.length ? [] : ['Do not infer source-to-target changes without a source image; report only defects visibly present on the target page.']),
    'Every box must be an object {"x":number,"y":number,"width":number,"height":number} in normalized 0..1000 target-page coordinates. Never return pixel coordinates or x1/y1/x2/y2.',
    'Return exactly one JSON object:',
    '{"target_page":1,"issues":[{"type":"missing_text|clipped_text|overlap|unreadable_glyphs|untranslated_body|layout_collapse|layout_drift|asset_changed|asset_missing|formula_changed|table_changed","severity":"severe|warning","bbox":{"x":0,"y":0,"width":1,"height":1},"confidence":0.0,"evidence":"short visible evidence"}]}',
    'Use the actual target page number above. Return no prose or Markdown.',
  ];
  if (compact) prompt.splice(-1, 0, 'The previous report was too long. Return only the at most 3 severe issues with highest confidence; omit all warnings.');
  return prompt.join('\n');
}

export function buildVisionFinalConfirmationPrompt(
  targetPageNumber: number,
  candidates: readonly { type: string; bbox: readonly number[]; evidence: string }[],
): string {
  return [
    'Independently re-check the attached translated academic-paper page.',
    `This is target page ${targetPageNumber}.`,
    'The first visual pass proposed the candidate issues below. Confirm only defects that are plainly visible in the pixels; do not repeat a candidate merely because it was proposed.',
    `Candidates: ${JSON.stringify(candidates)}`,
    'For clipped_text, confirm only when glyph strokes are visibly cut by a page, column, crop, or overlapping object boundary. A complete heading or first line near the top margin is not clipped.',
    'For overlap, confirm only when two visible content objects actually cover one another. Small dense labels inside immutable figures are not defects.',
    'Return an empty issues array when every candidate is false. Do not add unrelated new issues in this confirmation pass.',
    'Every box must be an object {"x":number,"y":number,"width":number,"height":number} in normalized 0..1000 target-page coordinates.',
    'Return exactly one JSON object:',
    '{"target_page":1,"issues":[{"type":"missing_text|clipped_text|overlap|unreadable_glyphs|untranslated_body|layout_collapse|layout_drift|asset_changed|asset_missing|formula_changed|table_changed","severity":"severe|warning","bbox":{"x":0,"y":0,"width":1,"height":1},"confidence":0.0,"evidence":"short visible evidence"}]}',
    'Use the actual target page number above. Return no prose or Markdown.',
  ].join('\n');
}
