export type AiLogEvent =
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
