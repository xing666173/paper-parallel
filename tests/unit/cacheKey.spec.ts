import { describe, expect, it } from 'vitest';
import { buildTranslationCacheKey } from '../../src/core/project/cacheKey';

describe('translation cache identity', () => {
  const base = {
    fileHash: 'sha256:file',
    promptVersion: 'academic-json-v2',
    modelId: 'deepseek-v4-flash',
    thinkingMode: 'disabled' as const,
    glossaryHash: 'sha256:terms',
    blockId: 'sec-1-p-1',
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
  ])('changes when %s changes', (_label, changed) => {
    expect(buildTranslationCacheKey(base)).not.toBe(buildTranslationCacheKey(changed));
  });

  it('escapes field separators to prevent ambiguous keys', () => {
    expect(buildTranslationCacheKey({ ...base, fileHash: 'sha256:a:b' })).not.toBe(
      buildTranslationCacheKey({ ...base, fileHash: 'sha256:a', promptVersion: 'b:academic-json-v2' }),
    );
  });
});
