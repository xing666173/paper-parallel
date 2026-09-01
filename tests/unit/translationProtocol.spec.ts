import { describe, expect, it } from 'vitest';
import { buildSourceSentenceCandidates } from '../../src/core/align/sourceSentences';
import {
  buildBatchPrompt,
  buildSystemPrompt,
  SYSTEM_PROMPT_VERSION,
} from '../../src/core/translate/prompts';
import {
  extractProtectedTokens,
  maskProtectedTokensForTranslation,
  restoreMissingProtectedTokensFromTranslation,
  restoreProtectedTokensFromTranslation,
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
  it('masks repeated numbers and citations for the model and restores the validated response', () => {
    const source: TranslationBlockRequest = {
      blockId: 'p1', kind: 'paragraph',
      source: 'Figure 2 uses 10 × speedup [22], then 10 more steps.',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{ id: 'p1-s-1', text: 'Figure 2 uses 10 × speedup [22], then 10 more steps.' }],
      protectedTokens: ['2', '10', '[22]', '10'],
    };
    const masked = maskProtectedTokensForTranslation([source]);
    expect(masked.blocks[0]!.source)
      .toBe('Figure ⟦PP0_0⟧ uses ⟦PP0_1⟧ × speedup ⟦PP0_2⟧, then ⟦PP0_3⟧ more steps.');
    expect(masked.blocks[0]!.sourceSentences[0]!.text).toBe(masked.blocks[0]!.source);
    expect(masked.blocks[0]!.protectedTokens).toEqual([
      '⟦PP0_0⟧', '⟦PP0_1⟧', '⟦PP0_2⟧', '⟦PP0_3⟧',
    ]);
    const maskedTranslation = '图 ⟦PP0_0⟧ 使用 ⟦PP0_1⟧ 倍加速 ⟦PP0_2⟧，随后再执行 ⟦PP0_3⟧ 步。';
    const restored = restoreProtectedTokensFromTranslation({ blocks: [{
      blockId: 'p1', translation: maskedTranslation,
      alignmentGroups: [{ sourceSentenceIds: ['p1-s-1'], targetSegments: [maskedTranslation] }],
      newTerms: [], warnings: [],
    }] }, masked.replacements);

    expect(restored.blocks[0]!.translation).toBe('图 2 使用 10 倍加速 [22]，随后再执行 10 步。');
    expect(validateBatchResponse([source], restored).ok).toBe(true);
  });

  it('does not remask digits inside placeholders created for earlier protected tokens', () => {
    const source: TranslationBlockRequest = {
      blockId: 'numeric-markers', kind: 'paragraph',
      source: 'Figure 1 compares RISC0 at 2 × speedup.',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{
        id: 'numeric-markers-s-1',
        text: 'Figure 1 compares RISC0 at 2 × speedup.',
      }],
      protectedTokens: ['1', '0', '2'],
    };

    const masked = maskProtectedTokensForTranslation([source]);

    expect(masked.blocks[0]!.source).toBe(
      'Figure ⟦PP0_0⟧ compares RISC⟦PP0_1⟧ at ⟦PP0_2⟧ × speedup.',
    );
    expect([...masked.replacements.keys()]).toEqual(['⟦PP0_0⟧', '⟦PP0_1⟧', '⟦PP0_2⟧']);
  });

  it('restores an omitted opaque marker inside its aligned target sentence before validation', () => {
    const source: TranslationBlockRequest = {
      blockId: 'repeated-number', kind: 'paragraph',
      source: 'The design uses 4 pipes. Table 4 reports 4 more results.',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [
        { id: 'repeated-number-s-1', text: 'The design uses 4 pipes.' },
        { id: 'repeated-number-s-2', text: 'Table 4 reports 4 more results.' },
      ],
      protectedTokens: ['4', '4', '4'],
    };
    const masked = maskProtectedTokensForTranslation([source]);
    const first = masked.blocks[0]!.protectedTokens[0]!;
    const second = masked.blocks[0]!.protectedTokens[1]!;
    const missing = masked.blocks[0]!.protectedTokens[2]!;
    const restored = restoreProtectedTokensFromTranslation({ blocks: [{
      blockId: source.blockId,
      translation: `该设计使用 ${first} 条流水线。表 ${second} 报告了更多结果。`,
      alignmentGroups: [
        { sourceSentenceIds: ['repeated-number-s-1'], targetSegments: [`该设计使用 ${first} 条流水线。`] },
        { sourceSentenceIds: ['repeated-number-s-2'], targetSegments: [`表 ${second} 报告了更多结果。`] },
      ],
      newTerms: [], warnings: [],
    }] }, masked.replacements, masked.blocks);

    expect(missing).not.toBe(first);
    expect(restored.blocks[0]!.translation).toBe('该设计使用 4 条流水线。表 4 报告了更多结果 4。');
    expect(restored.blocks[0]!.alignmentGroups.flatMap((group) => group.targetSegments).join(''))
      .toBe(restored.blocks[0]!.translation);
    expect(validateBatchResponse([source], restored).ok).toBe(true);
  });

  it('does not duplicate a protected value when the provider returns the literal instead of its marker', () => {
    const source: TranslationBlockRequest = {
      blockId: 'literal-number', kind: 'paragraph',
      source: 'The design reaches 2.08 times speedup and 2.94 times at peak.',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{
        id: 'literal-number-s-1',
        text: 'The design reaches 2.08 times speedup and 2.94 times at peak.',
      }],
      protectedTokens: ['2.08', '2.94'],
    };
    const masked = maskProtectedTokensForTranslation([source]);
    const literalTranslation = '该设计实现了 2.08 倍加速，峰值达到 2.94 倍。';
    const restored = restoreProtectedTokensFromTranslation({ blocks: [{
      blockId: source.blockId,
      translation: literalTranslation,
      alignmentGroups: [{
        sourceSentenceIds: ['literal-number-s-1'], targetSegments: [literalTranslation],
      }],
      newTerms: [], warnings: [],
    }] }, masked.replacements, masked.blocks);

    expect(restored.blocks[0]!.translation).toBe(literalTranslation);
    expect(extractProtectedTokens(restored.blocks[0]!.translation)).toEqual(['2.08', '2.94']);
    expect(validateBatchResponse([source], restored).ok).toBe(true);
  });

  it('treats whitespace-padded citation lists as one protected token', () => {
    expect(extractProtectedTokens('Prior work [ 1 , 3 , 8 , 13 ] established this result.'))
      .toEqual(['[ 1 , 3 , 8 , 13 ]']);
  });

  it('deterministically restores original tokens still missing after provider marker rewriting', () => {
    const source: TranslationBlockRequest = {
      blockId: 'long-technical', kind: 'paragraph',
      source: 'Figure 3 reports prior work [ 1 , 8 , 13 ]. The speedup is 80%.',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [
        { id: 'long-technical-s-1', text: 'Figure 3 reports prior work [ 1 , 8 , 13 ].' },
        { id: 'long-technical-s-2', text: 'The speedup is 80%.' },
      ],
      protectedTokens: ['3', '[ 1 , 8 , 13 ]', '80%'],
    };
    const response: TranslationResponse = { blocks: [{
      blockId: source.blockId,
      translation: '图报告了已有工作。加速比为。',
      alignmentGroups: [
        { sourceSentenceIds: ['long-technical-s-1'], targetSegments: ['图报告了已有工作。'] },
        { sourceSentenceIds: ['long-technical-s-2'], targetSegments: ['加速比为。'] },
      ],
      newTerms: [], warnings: [],
    }] };

    const restored = restoreMissingProtectedTokensFromTranslation([source], response);

    expect(restored.blocks[0]!.translation).toContain('3');
    expect(restored.blocks[0]!.translation).toContain('[ 1 , 8 , 13 ]');
    expect(restored.blocks[0]!.translation).toContain('80%');
    expect(restored.blocks[0]!.alignmentGroups.flatMap((group) => group.targetSegments).join(''))
      .toBe(restored.blocks[0]!.translation);
    expect(validateBatchResponse([source], restored).ok).toBe(true);
  });

  it('moves a protected numeric section label back to the start of a translated heading', () => {
    const source: TranslationBlockRequest = {
      blockId: 'heading-4-2', kind: 'heading',
      source: '4.2 Matrix-vector Multiplication on GPUs',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{ id: 'heading-4-2-s-1', text: '4.2 Matrix-vector Multiplication on GPUs' }],
      protectedTokens: ['4.2'],
    };
    const translated = 'GPU 上的矩阵向量乘法 4.2';
    const restored = restoreMissingProtectedTokensFromTranslation([source], { blocks: [{
      blockId: source.blockId,
      translation: translated,
      alignmentGroups: [{ sourceSentenceIds: ['heading-4-2-s-1'], targetSegments: [translated] }],
      newTerms: [], warnings: [],
    }] });

    expect(restored.blocks[0]!.translation).toBe('4.2 GPU 上的矩阵向量乘法');
    expect(restored.blocks[0]!.alignmentGroups[0]!.targetSegments)
      .toEqual(['4.2 GPU 上的矩阵向量乘法']);
  });
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

  it('rejects an unchanged English biography returned as its translation', () => {
    const source: TranslationBlockRequest = {
      blockId: 'bio', kind: 'paragraph',
      source: 'Xuehai Qian is a professor at the University of Southern California.',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{
        id: 'bio-s-1',
        text: 'Xuehai Qian is a professor at the University of Southern California.',
      }],
      protectedTokens: [],
    };
    const response: TranslationResponse = { blocks: [{
      blockId: 'bio', translation: source.source,
      alignmentGroups: [{ sourceSentenceIds: ['bio-s-1'], targetSegments: [source.source] }],
      newTerms: [], warnings: [],
    }] };

    const result = validateBatchResponse([source], response);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('target-language-missing');
  });

  it('does not require Chinese characters for author-name blocks', () => {
    const source: TranslationBlockRequest = {
      blockId: 'authors', kind: 'author', source: 'Xuehai Qian and Zhibin Yu',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{ id: 'authors-s-1', text: 'Xuehai Qian and Zhibin Yu' }],
      protectedTokens: [],
    };
    const response: TranslationResponse = { blocks: [{
      blockId: 'authors', translation: source.source,
      alignmentGroups: [{ sourceSentenceIds: ['authors-s-1'], targetSegments: [source.source] }],
      newTerms: [], warnings: [],
    }] };

    expect(validateBatchResponse([source], response).ok).toBe(true);
  });

  it('treats a hyphenated identifier suffix as unsigned while preserving real negative numbers', () => {
    expect(extractProtectedTokens('MNT4-753 uses -12 units and BLS12-381 uses 20%.'))
      .toEqual(['753', '-12', '381', '20%']);
  });

  it('recognizes protected numerals immediately after translated Chinese labels', () => {
    expect(extractProtectedTokens('图11显示提升3.9倍。')).toEqual(['11', '3.9']);
  });

  it('validates explicit protected title terms as ordinary literal occurrences', () => {
    const source: TranslationBlockRequest = {
      blockId: 'title', kind: 'title',
      source: 'Falic: An FPGA-Based Accelerator',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{ id: 'title-s-1', text: 'Falic: An FPGA-Based Accelerator' }],
      protectedTokens: ['Falic', 'FPGA'],
    };
    const translation = 'Falic：一种基于FPGA的加速器';

    expect(validateBatchResponse([source], { blocks: [{
      blockId: 'title', translation,
      alignmentGroups: [{ sourceSentenceIds: ['title-s-1'], targetSegments: [translation] }],
      newTerms: [], warnings: [],
    }] }).ok).toBe(true);
  });

  it('counts complete numeric tokens and permits extra numerals introduced from number words', () => {
    const source: TranslationBlockRequest = {
      blockId: 'numeric-words', kind: 'paragraph',
      source: 'Step 1 uses 1024 entries, followed by one extra pass.',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{
        id: 'numeric-words-s-1',
        text: 'Step 1 uses 1024 entries, followed by one extra pass.',
      }],
      protectedTokens: ['1', '1024'],
    };
    const translation = '步骤 1 使用 1024 个条目，随后再执行 1 次。';
    const response: TranslationResponse = { blocks: [{
      blockId: source.blockId,
      translation,
      alignmentGroups: [{ sourceSentenceIds: ['numeric-words-s-1'], targetSegments: [translation] }],
      newTerms: [], warnings: [],
    }] };

    expect(validateBatchResponse([source], response).ok).toBe(true);
  });

  it('treats PDF line wrapping as whitespace instead of sentence boundaries', () => {
    expect(buildSourceSentenceCandidates(
      'wrapped',
      'Executing the Instruc-\ntion Set Architecture via software\ninterpretation is slow. The next sentence\ncontinues here.',
    )).toEqual({
      mode: 'sentence-candidates',
      sentences: [
        {
          id: 'wrapped-s-1',
          text: 'Executing the Instruc- tion Set Architecture via software interpretation is slow.',
        },
        { id: 'wrapped-s-2', text: 'The next sentence continues here.' },
      ],
    });
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

  it('accepts a superscript unit exponent when PDF text extraction flattened it', () => {
    const source: TranslationBlockRequest = {
      blockId: 'area', kind: 'paragraph',
      source: 'The area is 0.21 mm 2 , and the power consumption is 51.167 mW.',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{
        id: 'area-s-1',
        text: 'The area is 0.21 mm 2 , and the power consumption is 51.167 mW.',
      }],
      protectedTokens: ['0.21', '2', '51.167'],
    };
    const response: TranslationResponse = { blocks: [{
      blockId: 'area',
      translation: '面积为 0.21 mm²，功耗为 51.167 mW。',
      alignmentGroups: [{
        sourceSentenceIds: ['area-s-1'],
        targetSegments: ['面积为 0.21 mm²，功耗为 51.167 mW。'],
      }],
      newTerms: [], warnings: [],
    }] };

    expect(validateBatchResponse([source], response)).toEqual({
      ok: true,
      accepted: response.blocks,
      issues: [],
    });
  });

  it('still rejects a missing unit exponent after PDF text extraction flattened it', () => {
    const source: TranslationBlockRequest = {
      blockId: 'area', kind: 'paragraph', source: 'The area is 0.21 mm 2 .',
      alignmentMode: 'sentence-candidates',
      sourceSentences: [{ id: 'area-s-1', text: 'The area is 0.21 mm 2 .' }],
      protectedTokens: ['0.21', '2'],
    };
    const response: TranslationResponse = { blocks: [{
      blockId: 'area', translation: '面积为 0.21 mm。',
      alignmentGroups: [{ sourceSentenceIds: ['area-s-1'], targetSegments: ['面积为 0.21 mm。'] }],
      newTerms: [], warnings: [],
    }] };

    const result = validateBatchResponse([source], response);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('protected-token-changed');
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

  it('does not accept a valid-looking prefix from a response with extra blocks', () => {
    const source = paragraphRequest();
    const valid = {
      blockId: 'p1', translation: '第一句。第二句。第三句。',
      alignmentGroups: [{
        sourceSentenceIds: ['p1-s-1', 'p1-s-2', 'p1-s-3'],
        targetSegments: ['第一句。第二句。第三句。'],
      }],
      newTerms: [], warnings: [],
    };
    const result = validateBatchResponse([source], { blocks: [valid, { ...valid, blockId: 'unexpected' }] });

    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.issues.map((item) => item.code)).toContain('block-id-mismatch');
  });
});
