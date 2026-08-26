import type {
  TranslationBlockRequest,
  TranslationBlockResponse,
  TranslationResponse,
  TranslationValidationIssue,
  TranslationValidationResult,
} from './protocol';

const PROTECTED_TOKEN_PATTERN = /⟦[^⟧]+⟧|\[(?:\d+(?:\s*[-,]\s*\d+)*)\]|[-+]?(?:\d+\.\d+|\d+)(?:%|‰)?/g;
const CITATION_TOKEN_PATTERN = /^\[(?:\d+(?:\s*[-,]\s*\d+)*)\]$/;
const FLATTENED_UNIT_EXPONENT_PATTERN = /(?:^|[\s(])(?:pm|nm|μm|µm|mm|cm|dm|m|dam|hm|km|in|ft|yd|mi)\s+([23])(?=$|[\s,.;:)])/gu;
const SUPERSCRIPT_EXPONENT: Record<string, string> = { '2': '²', '3': '³' };

export function extractProtectedTokens(text: string): string[] {
  return Array.from(text.matchAll(PROTECTED_TOKEN_PATTERN), (match) => match[0]);
}

export interface ProtectedTranslationMask {
  blocks: TranslationBlockRequest[];
  replacements: Map<string, string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskProtectedTokensForTranslation(
  blocks: readonly TranslationBlockRequest[],
): ProtectedTranslationMask {
  const replacements = new Map<string, string>();
  const maskedBlocks = blocks.map((block, blockIndex) => {
    const tokens = uniqueInOrder([...block.protectedTokens, ...extractProtectedTokens(block.source)])
      .sort((left, right) => right.length - left.length);
    const tokenToMarker = new Map<string, string>();
    tokens.forEach((token, tokenIndex) => {
      const marker = `⟦PP${blockIndex}_${tokenIndex}⟧`;
      tokenToMarker.set(token, marker);
      replacements.set(marker, token);
    });
    const tokenPattern = tokens.length
      ? new RegExp(tokens.map(escapeRegExp).join('|'), 'g')
      : undefined;
    const mask = (value: string): string => tokenPattern
      ? value.replace(tokenPattern, (token) => tokenToMarker.get(token)!)
      : value;
    return {
      ...block,
      source: mask(block.source),
      sourceSentences: block.sourceSentences.map((sentence) => ({ ...sentence, text: mask(sentence.text) })),
      protectedTokens: block.protectedTokens.map((token) => tokenToMarker.get(token) ?? token),
    };
  });
  return { blocks: maskedBlocks, replacements };
}

export function restoreProtectedTokensFromTranslation(
  response: TranslationResponse,
  replacements: ReadonlyMap<string, string>,
): TranslationResponse {
  const restore = (value: string): string => {
    let result = value;
    for (const [marker, token] of replacements) result = result.split(marker).join(token);
    return result;
  };
  return {
    blocks: response.blocks.map((block) => ({
      ...block,
      translation: restore(block.translation),
      alignmentGroups: block.alignmentGroups.map((group) => ({
        ...group,
        targetSegments: group.targetSegments.map(restore),
      })),
      newTerms: block.newTerms.map((term) => ({
        ...term,
        source: restore(term.source),
        target: restore(term.target),
        ...(term.abbreviation ? { abbreviation: restore(term.abbreviation) } : {}),
      })),
      warnings: block.warnings.map(restore),
    })),
  };
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function occurrenceCount(text: string, token: string): number {
  if (!token) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= text.length - token.length) {
    const found = text.indexOf(token, offset);
    if (found < 0) break;
    count += 1;
    offset = found + token.length;
  }
  return count;
}

function protectedOccurrenceCount(text: string, token: string): number {
  if (!CITATION_TOKEN_PATTERN.test(token)) return occurrenceCount(text, token);
  const canonical = token.replace(/\s+/g, '');
  return extractProtectedTokens(text)
    .filter((candidate) => CITATION_TOKEN_PATTERN.test(candidate))
    .filter((candidate) => candidate.replace(/\s+/g, '') === canonical)
    .length;
}

function sourceUsesFlattenedUnitExponent(source: string, token: string): boolean {
  if (!(token in SUPERSCRIPT_EXPONENT)) return false;
  return Array.from(source.matchAll(FLATTENED_UNIT_EXPONENT_PATTERN))
    .some((match) => match[1] === token);
}

function translatedProtectedOccurrenceCount(source: string, translation: string, token: string): number {
  const count = protectedOccurrenceCount(translation, token);
  if (!sourceUsesFlattenedUnitExponent(source, token)) return count;
  return count + occurrenceCount(translation, SUPERSCRIPT_EXPONENT[token]);
}

function normalizeTargetText(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u3000]+/g, '');
}

function validateSourceMapping(
  source: TranslationBlockRequest,
  response: TranslationBlockResponse,
): boolean {
  const expectedIds = source.sourceSentences.map((sentence) => sentence.id);
  const actualIds = response.alignmentGroups.flatMap((group) => group.sourceSentenceIds);
  if (expectedIds.length !== actualIds.length) return false;
  if (response.alignmentGroups.some((group) => (
    group.sourceSentenceIds.length === 0
    || group.targetSegments.length === 0
    || group.targetSegments.some((segment) => segment.trim().length === 0)
  ))) return false;
  return expectedIds.every((id, index) => actualIds[index] === id);
}

function addIssue(
  issues: TranslationValidationIssue[],
  blockId: string,
  code: string,
  message: string,
): void {
  issues.push({ blockId, code, message });
}

export function validateBatchResponse(
  sourceBlocks: TranslationBlockRequest[],
  response: TranslationResponse,
): TranslationValidationResult {
  const issues: TranslationValidationIssue[] = [];
  const accepted: TranslationBlockResponse[] = [];
  const expectedBlockIds = sourceBlocks.map((block) => block.blockId);
  const actualBlockIds = response.blocks.map((block) => block.blockId);

  if (
    expectedBlockIds.length !== actualBlockIds.length
    || expectedBlockIds.some((id, index) => actualBlockIds[index] !== id)
  ) {
    addIssue(issues, '*', 'block-id-mismatch', 'Response block IDs or order do not match the request.');
  }

  for (const [index, source] of sourceBlocks.entries()) {
    const translated = response.blocks[index];
    const issueStart = issues.length;
    if (!translated || translated.blockId !== source.blockId) continue;

    if (!translated.translation.trim()) {
      addIssue(issues, source.blockId, 'translation-empty', 'Translation is empty.');
    }

    const protectedTokens = uniqueInOrder([
      ...source.protectedTokens,
      ...extractProtectedTokens(source.source),
    ]);
    for (const token of protectedTokens) {
      const required = Math.max(
        protectedOccurrenceCount(source.source, token),
        source.protectedTokens.filter((value) => (
          CITATION_TOKEN_PATTERN.test(token)
            ? value.replace(/\s+/g, '') === token.replace(/\s+/g, '')
            : value === token
        )).length,
      );
      const received = translatedProtectedOccurrenceCount(source.source, translated.translation, token);
      if (received !== required) {
        addIssue(
          issues,
          source.blockId,
          'protected-token-changed',
          `Protected token count changed for ${token}.`,
        );
      }
    }

    if (!validateSourceMapping(source, translated)) {
      addIssue(
        issues,
        source.blockId,
        'source-mapping-invalid',
        'Source sentence IDs must be covered exactly once in source order.',
      );
    }

    const targetFromSegments = translated.alignmentGroups
      .flatMap((group) => group.targetSegments)
      .join('');
    if (normalizeTargetText(targetFromSegments) !== normalizeTargetText(translated.translation)) {
      addIssue(
        issues,
        source.blockId,
        'target-segments-mismatch',
        'Target segments do not reconstruct the block translation.',
      );
    }

    if (issues.length === issueStart) accepted.push(translated);
  }

  return { ok: issues.length === 0, accepted, issues };
}
