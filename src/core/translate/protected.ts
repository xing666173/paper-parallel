import type {
  TranslationBlockRequest,
  TranslationBlockResponse,
  TranslationResponse,
  TranslationValidationIssue,
  TranslationValidationResult,
} from './protocol';

const PROTECTED_TOKEN_PATTERN = /⟦[^⟧]+⟧|\[(?:\d+(?:\s*[-,]\s*\d+)*)\]|[-+]?(?:\d+\.\d+|\d+)(?:%|‰)?/g;

export function extractProtectedTokens(text: string): string[] {
  return Array.from(text.matchAll(PROTECTED_TOKEN_PATTERN), (match) => match[0]);
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
        occurrenceCount(source.source, token),
        source.protectedTokens.filter((value) => value === token).length,
      );
      const received = occurrenceCount(translated.translation, token);
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
