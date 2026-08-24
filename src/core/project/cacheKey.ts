export interface TranslationCacheIdentity {
  fileHash: string;
  promptVersion: string;
  modelId: string;
  thinkingMode: 'enabled' | 'disabled';
  glossaryHash: string;
  blockId: string;
}

export function buildTranslationCacheKey(value: TranslationCacheIdentity): string {
  return [
    value.fileHash,
    value.promptVersion,
    value.modelId,
    value.thinkingMode,
    value.glossaryHash,
    value.blockId,
  ]
    .map(encodeURIComponent)
    .join(':');
}
