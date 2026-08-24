import type { TranslationBlockRequest } from './protocol';

export interface TranslationBatch {
  id: string;
  blocks: TranslationBlockRequest[];
  estimatedTokens: number;
  oversized: boolean;
}

export interface TranslationBatchOptions {
  maxInputTokens: number;
  estimateTokens?: (text: string) => number;
  documentContext?: unknown;
  glossary?: unknown;
}

export function estimateConservativeTokens(text: string): number {
  return Math.ceil([...text].length / 2.5);
}

export function buildTranslationBatches(
  blocks: readonly TranslationBlockRequest[],
  options: TranslationBatchOptions,
): TranslationBatch[] {
  if (blocks.length === 0) return [];

  const estimate = options.estimateTokens ?? estimateConservativeTokens;
  const sharedTokens = estimate(JSON.stringify({
    documentContext: options.documentContext ?? null,
    glossary: options.glossary ?? [],
  }));
  const batches: TranslationBatch[] = [];
  let currentBlocks: TranslationBlockRequest[] = [];
  let currentTokens = sharedTokens;

  const flush = () => {
    if (currentBlocks.length === 0) return;
    batches.push({
      id: `batch-${batches.length + 1}`,
      blocks: currentBlocks,
      estimatedTokens: currentTokens,
      oversized: false,
    });
    currentBlocks = [];
    currentTokens = sharedTokens;
  };

  for (const block of blocks) {
    const blockTokens = estimate(JSON.stringify(block));
    const singleBlockTokens = sharedTokens + blockTokens;

    if (singleBlockTokens > options.maxInputTokens) {
      flush();
      batches.push({
        id: `batch-${batches.length + 1}`,
        blocks: [block],
        estimatedTokens: singleBlockTokens,
        oversized: true,
      });
      continue;
    }

    if (currentBlocks.length > 0 && currentTokens + blockTokens > options.maxInputTokens) flush();
    currentBlocks.push(block);
    currentTokens += blockTokens;
  }

  flush();
  return batches;
}
