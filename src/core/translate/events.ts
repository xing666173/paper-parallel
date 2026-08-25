export type AiLogEvent =
  | { type: 'vision-layout-page'; at: number; page: number; totalPages: number; cached: boolean }
  | {
      type: 'vision-layout-fallback'; at: number; page: number; region: number;
      reason: 'low-confidence' | 'caption-unmatched' | 'page-edge-touch'
        | 'page-coverage-excessive' | 'caption-overlap' | 'body-prose-density';
    }
  | { type: 'vision-review-page-started'; at: number; page: number; totalPages: number }
  | { type: 'vision-review-page'; at: number; page: number; totalPages: number; issueCount: number }
  | { type: 'batch-started'; at: number; batchId: string; blockIds: string[]; modelId: string }
  | {
      type: 'batch-received'; at: number; batchId: string; elapsedMs: number;
      promptTokens: number; completionTokens: number;
    }
  | {
      type: 'batch-progress'; at: number; batchId: string;
      phase: 'connected' | 'reasoning' | 'content'; receivedContentChars: number;
    }
  | { type: 'batch-validated'; at: number; batchId: string; blockIds: string[] }
  | { type: 'cache-hit'; at: number; blockId: string }
  | { type: 'cache-written'; at: number; blockId: string }
  | {
      type: 'batch-split'; at: number; batchId: string;
      childBatchIds: [string, string]; reason: string;
    }
  | { type: 'retry'; at: number; batchId: string; attempt: number; reason: string }
  | { type: 'error'; at: number; batchId: string; blockIds: string[]; message: string };
