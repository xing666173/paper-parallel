import { describe, expect, it } from 'vitest';
import { buildTranslationCacheKey, buildVisionLayoutCacheKey } from '../../src/core/project/cacheKey';

describe('translation cache identity', () => {
  const base = {
    fileHash: 'sha256:file',
    promptVersion: 'academic-json-v2',
    modelId: 'deepseek-v4-flash',
    thinkingMode: 'disabled' as const,
    glossaryHash: 'sha256:terms',
    blockId: 'sec-1-p-1',
    sourceText: 'Original source paragraph.',
  };

  it('is stable for equal inputs', () => {
    expect(buildTranslationCacheKey(base)).toBe(buildTranslationCacheKey({ ...base }));
  });

  it.each([
    ['file hash', { ...base, fileHash: 'sha256:other-file' }],
    ['prompt version', { ...base, promptVersion: 'academic-json-v3' }],
    ['model', { ...base, modelId: 'deepseek-v4-pro' }],
    ['thinking mode', { ...base, thinkingMode: 'enabled' as const }],
    ['glossary', { ...base, glossaryHash: 'sha256:other-terms' }],
    ['block', { ...base, blockId: 'sec-1-p-2' }],
    ['source text', { ...base, sourceText: 'Changed source paragraph.' }],
  ])('changes when %s changes', (_label, changed) => {
    expect(buildTranslationCacheKey(base)).not.toBe(buildTranslationCacheKey(changed));
  });

  it('escapes field separators to prevent ambiguous keys', () => {
    expect(buildTranslationCacheKey({ ...base, fileHash: 'sha256:a:b' })).not.toBe(
      buildTranslationCacheKey({ ...base, fileHash: 'sha256:a', promptVersion: 'b:academic-json-v2' }),
    );
  });
});

describe('vision layout cache key', () => {
  it('changes for the source, page, model, prompt, or renderer version', () => {
    const base = {
      fileHash: 'sha256:paper', pageIndex: 0,
      modelId: 'deepseek-v4-flash-vision-exp', promptVersion: 'vision-v1', renderVersion: 'pdfjs-2x-v1',
    };
    const key = buildVisionLayoutCacheKey(base);
    for (const changed of [
      { ...base, fileHash: 'sha256:other' },
      { ...base, pageIndex: 1 },
      { ...base, modelId: 'other-model' },
      { ...base, promptVersion: 'vision-v2' },
      { ...base, renderVersion: 'pdfjs-3x-v1' },
    ]) expect(buildVisionLayoutCacheKey(changed)).not.toBe(key);
  });
});
