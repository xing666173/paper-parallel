import type { TranslationRequest } from './protocol';

export const SYSTEM_PROMPT_VERSION = 'academic-json-v2';

export function buildSystemPrompt(): string {
  return [
    'You are a professional academic translator. Translate faithfully, accurately, completely, and in document order.',
    'Adapt terminology only from document_context and glossary. The glossary has precedence over inferred wording.',
    'Do not summarize, explain, expand, omit, or reorder content.',
    'Preserve protected_tokens, numbers, citations, formulas, identifiers, code, model names, and immutable content exactly.',
    'Translate each supplied block as a coherent whole. Natural target-language sentence splitting and merging are allowed.',
    'Return continuous sourceSentenceIds-to-targetSegments alignment groups; cover every source ID exactly once and never cross source order.',
    'Do not make layout, pagination, column, font, figure, table, or asset-placement decisions.',
    'Return JSON only and follow the supplied response schema. Do not include commentary or hidden reasoning.',
  ].join('\n');
}

export function buildBatchPrompt(request: TranslationRequest): string {
  return JSON.stringify(request);
}
