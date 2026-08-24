import type { TranslationRequest } from './protocol';

export const SYSTEM_PROMPT_VERSION = 'academic-json-v3';

const RESPONSE_SCHEMA_EXAMPLE = JSON.stringify({
  blocks: [{
    block_id: 'copy the input block_id exactly',
    translation: 'complete translated block text',
    alignment_groups: [{
      source_sentence_ids: ['copy one or more input sentence IDs in source order'],
      target_segments: ['one or more translated segments whose concatenation equals translation'],
    }],
    new_terms: [{ source: 'source term', target: 'fixed translation', abbreviation: 'optional abbreviation' }],
    warnings: [],
  }],
});

export function buildSystemPrompt(): string {
  return [
    'You are a professional academic translator. Translate faithfully, accurately, completely, and in document order.',
    'Adapt terminology only from document_context and glossary. The glossary has precedence over inferred wording.',
    'Do not summarize, explain, expand, omit, or reorder content.',
    'Preserve protected_tokens, numbers, citations, formulas, identifiers, code, model names, and immutable content exactly.',
    'Translate each supplied block as a coherent whole. Natural target-language sentence splitting and merging are allowed.',
    'Return continuous sourceSentenceIds-to-targetSegments alignment groups; cover every source ID exactly once and never cross source order.',
    'Do not make layout, pagination, column, font, figure, table, or asset-placement decisions.',
    'Return exactly one JSON object matching the response schema below. Do not include commentary or hidden reasoning.',
    `RESPONSE_SCHEMA_EXAMPLE=${RESPONSE_SCHEMA_EXAMPLE}`,
    'Every field shown is required. blocks, alignment_groups, source_sentence_ids, target_segments, new_terms, and warnings must always be JSON arrays; use [] when an optional list is empty.',
    'Return exactly one response block for every input block, preserving input block order and copying every block_id exactly.',
  ].join('\n');
}

export function buildBatchPrompt(request: TranslationRequest): string {
  return JSON.stringify(request);
}
