export interface TranslationCacheIdentity {
  fileHash: string;
  promptVersion: string;
  modelId: string;
  thinkingMode: 'enabled' | 'disabled';
  glossaryHash: string;
  blockId: string;
  sourceText: string;
}

export function buildTranslationCacheKey(value: TranslationCacheIdentity): string {
  return [
    value.fileHash,
    value.promptVersion,
    value.modelId,
    value.thinkingMode,
    value.glossaryHash,
    value.blockId,
    value.sourceText,
  ]
    .map(encodeURIComponent)
    .join(':');
}

export interface VisionLayoutCacheIdentity {
  fileHash: string;
  pageIndex: number;
  modelId: string;
  promptVersion: string;
  renderVersion: string;
}

export function buildVisionLayoutCacheKey(value: VisionLayoutCacheIdentity): string {
  return [
    'vision-layout',
    value.fileHash,
    String(value.pageIndex),
    value.modelId,
    value.promptVersion,
    value.renderVersion,
  ].map(encodeURIComponent).join(':');
}

export interface FormulaOcrCacheIdentity {
  fileHash: string;
  pageIndex: number;
  regionId: string;
  modelId: string;
  promptVersion: string;
  sourceRect: string;
}

export function buildFormulaOcrCacheKey(value: FormulaOcrCacheIdentity): string {
  return [
    'formula-ocr',
    value.fileHash,
    String(value.pageIndex),
    value.regionId,
    value.modelId,
    value.promptVersion,
    value.sourceRect,
  ].map(encodeURIComponent).join(':');
}
