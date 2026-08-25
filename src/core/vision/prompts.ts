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
