import { describe, expect, it } from 'vitest';
import { buildSourceSentenceCandidates } from '../../src/core/align/sourceSentences';
import {
  buildBatchPrompt,
  buildSystemPrompt,
  SYSTEM_PROMPT_VERSION,
} from '../../src/core/translate/prompts';
import {
  extractProtectedTokens,
  validateBatchResponse,
} from '../../src/core/translate/protected';
import type {
  TranslationBlockRequest,
  TranslationResponse,
} from '../../src/core/translate/protocol';

function paragraphRequest(): TranslationBlockRequest {
  return {
    blockId: 'p1',
    kind: 'paragraph',
    source: 'First result. Second result. Third result.',
    alignmentMode: 'sentence-candidates',
    sourceSentences: [
      { id: 'p1-s-1', text: 'First result.' },
      { id: 'p1-s-2', text: 'Second result.' },
      { id: 'p1-s-3', text: 'Third result.' },
    ],
    protectedTokens: [],
  };
}

describe('generic academic translation protocol', () => {
  it('creates stable source candidates before any translation request', () => {
    expect(buildSourceSentenceCandidates('p1', 'First result. Second result!')).toEqual({
      mode: 'sentence-candidates',
      sentences: [
        { id: 'p1-s-1', text: 'First result.' },
        { id: 'p1-s-2', text: 'Second result!' },
      ],
    });
  });

  it('falls back to the whole paragraph when technical punctuation is ambiguous', () => {
    expect(buildSourceSentenceCandidates('eq-lead', 'where x_i: y_i; z_i')).toEqual({
      mode: 'paragraph-fallback',
      sentences: [{ id: 'eq-lead', text: 'where x_i: y_i; z_i' }],
      fallbackReason: 'sentence-boundary-ambiguous',
    });
  });

  it('keeps the fixed prompt domain-neutral and puts paper context only in the payload', () => {
    const systemPrompt = buildSystemPrompt();
    expect(SYSTEM_PROMPT_VERSION).toBe('academic-json-v3');
    expect(systemPrompt).not.toMatch(/zkVM|Zero-Knowledge|计算机体系结构|密码学|医学/);
    expect(systemPrompt).toContain('document_context');
    expect(systemPrompt).toContain('protected_tokens');
    expect(systemPrompt).toContain('"blocks"');
    expect(systemPrompt).toContain('"alignment_groups"');
    expect(systemPrompt).toContain('"source_sentence_ids"');
    expect(systemPrompt).toContain('Every field shown is required');

    const payload = buildBatchPrompt({
      documentContext: {
        title: 'A Medical Study', abstract: 'A trial', detectedFields: ['medicine'], sectionPath: 'Methods',
      },
      terminologyPolicy: {
        firstOccurrence: '中文名称（英文全称, 缩写）', laterOccurrence: '固定译名或缩写',
      },
      entityPolicy: {
        authorNames: 'keep', organizationNames: 'translate_when_clear', modelNames: 'keep', productNames: 'keep',
      },
      glossary: [{ source: 'myocardial infarction', target: '心肌梗死' }],
      blocks: [{
        blockId: 'p1', kind: 'paragraph', source: 'Myocardial infarction affected 12%.',
        alignmentMode: 'sentence-candidates',
        sourceSentences: [{ id: 'p1-s-1', text: 'Myocardial infarction affected 12%.' }],
        protectedTokens: ['12%'],
      }],
    });
    expect(payload).toContain('A Medical Study');
    expect(payload).toContain('心肌梗死');
    expect(payload).toContain('12%');
    expect(payload).not.toContain('sk-');
  });

  it('extracts numbers, citations, and explicit protected markers in source order', () => {
    expect(extractProtectedTokens('Accuracy was 96%. See [4] and ⟦EQ:x_1⟧ at 2.5 GHz.')).toEqual([
      '96%', '[4]', '⟦EQ:x_1⟧', '2.5',
    ]);
  });

  it('rejects changed numbers and protected markers', () => {
    const source: TranslationBlockRequest = {
      blockId: 'p1', kind: 'paragraph', source: 'Accuracy was 96%. ⟦CITE:4⟧',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{ id: 'p1-s-1', text: 'Accuracy was 96%. ⟦CITE:4⟧' }],
      protectedTokens: ['96%', '⟦CITE:4⟧'],
    };
    const response: TranslationResponse = { blocks: [{
      blockId: 'p1', translation: '准确率为 69%。⟦CITE:5⟧',
      alignmentGroups: [{ sourceSentenceIds: ['p1-s-1'], targetSegments: ['准确率为 69%。⟦CITE:5⟧'] }],
      newTerms: [], warnings: [],
    }] };

    const result = validateBatchResponse([source], response);

    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'protected-token-changed', 'protected-token-changed',
    ]);
  });

  it('accepts citation lists whose only difference is internal whitespace', () => {
    const source: TranslationBlockRequest = {
      blockId: 'p1', kind: 'paragraph', source: 'Prior work [1, 3, 8] established this result.',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{ id: 'p1-s-1', text: 'Prior work [1, 3, 8] established this result.' }],
      protectedTokens: ['[1, 3, 8]'],
    };
    const response: TranslationResponse = { blocks: [{
      blockId: 'p1', translation: '已有工作 [1,3,8] 证实了这一结果。',
      alignmentGroups: [{ sourceSentenceIds: ['p1-s-1'], targetSegments: ['已有工作 [1,3,8] 证实了这一结果。'] }],
      newTerms: [], warnings: [],
    }] };

    expect(validateBatchResponse([source], response)).toEqual({
      ok: true,
      accepted: response.blocks,
      issues: [],
    });
  });

  it('accepts continuous merge and split groups without forcing equal sentence counts', () => {
    const response: TranslationResponse = { blocks: [{
      blockId: 'p1',
      translation: '前两个结果合并说明。第三个结果拆成两句。补充说明。',
      alignmentGroups: [
        { sourceSentenceIds: ['p1-s-1', 'p1-s-2'], targetSegments: ['前两个结果合并说明。'] },
        { sourceSentenceIds: ['p1-s-3'], targetSegments: ['第三个结果拆成两句。', '补充说明。'] },
      ],
      newTerms: [], warnings: [],
    }] };

    expect(validateBatchResponse([paragraphRequest()], response)).toEqual({
      ok: true,
      accepted: response.blocks,
      issues: [],
    });
  });

  it('rejects crossed source groups and target segments that do not reconstruct the translation', () => {
    const response: TranslationResponse = { blocks: [{
      blockId: 'p1',
      translation: '译文甲。译文乙。',
      alignmentGroups: [
        { sourceSentenceIds: ['p1-s-2'], targetSegments: ['译文甲。'] },
        { sourceSentenceIds: ['p1-s-1', 'p1-s-3'], targetSegments: ['不同内容。'] },
      ],
      newTerms: [], warnings: [],
    }] };

    const result = validateBatchResponse([paragraphRequest()], response);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'source-mapping-invalid', 'target-segments-mismatch',
    ]);
  });
});
