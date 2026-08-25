export const VISION_LAYOUT_PROMPT_VERSION = 'vision-layout-v1';

export function buildVisionLayoutPrompt(pageNumber: number): string {
  return [
    'You are inspecting one rendered page of an academic paper before translation and typesetting.',
    `This is source page ${pageNumber}.`,
    'Identify the page layout and every visual region that must remain pixel-identical in the translated paper.',
    'Immutable regions are: figures, table bodies, display formulas, and code. Do not include a figure/table caption inside its immutable bbox.',
    'Captions are translatable text: return their separate caption_bbox when associated with a figure or table.',
    'Do not classify normal prose, headings, citations, inline math, headers, or footers as immutable assets.',
    'All boxes use [x, y, width, height] in a normalized 0..1000 coordinate space.',
    'Return exactly one JSON object with this schema:',
    '{"page":1,"layout":"single|double|mixed","regions":[{"type":"figure|table|display_formula|code|caption|header|footer|body_text","bbox":[0,0,1,1],"column":"left|right|full","caption_bbox":[0,0,1,1],"confidence":0.0}]}',
    'Use the actual page number above in page. Omit caption_bbox when it does not apply. Do not return prose or Markdown.',
  ].join('\n');
}

export const VISION_FINAL_REVIEW_PROMPT_VERSION = 'vision-final-review-v1';

export function buildVisionFinalReviewPrompt(targetPageNumber: number, sourcePageNumbers: readonly number[]): string {
  return [
    'You are the final visual quality inspector for a translated academic-paper PDF.',
    `The source reference images are pages ${sourcePageNumbers.join(', ')}. The final image is translated target page ${targetPageNumber}.`,
    'Natural repagination and different Chinese line breaks are allowed. Single-column, double-column, and mixed regions should preserve the source layout mode.',
    'Figures, table bodies, display formulas, code, variables, symbols, and internal figure labels must remain visually unchanged. Captions may be translated.',
    'Report only visible production defects: missing/clipped/overlapping text, unreadable glyphs, untranslated body prose, collapsed columns, or changed/missing immutable assets.',
    'Do not judge translation style or wording. Do not report harmless spacing or natural page extension as severe.',
    'All boxes use [x, y, width, height] in normalized 0..1000 target-page coordinates.',
    'Return exactly one JSON object:',
    '{"target_page":1,"issues":[{"type":"missing_text|clipped_text|overlap|unreadable_glyphs|untranslated_body|layout_collapse|layout_drift|asset_changed|asset_missing|formula_changed|table_changed","severity":"severe|warning","bbox":[0,0,1,1],"confidence":0.0,"evidence":"short visible evidence"}]}',
    'Use the actual target page number above. Return no prose or Markdown.',
  ].join('\n');
}
