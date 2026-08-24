import type { TranslationBatch } from './batcher';
import type { AiLogEvent } from './events';
import type {
  TranslationBlockRequest,
  TranslationBlockResponse,
  TranslationResponse,
} from './protocol';
import { validateBatchResponse } from './protected';

export interface TranslationRequestResult extends TranslationResponse {
  usage: { promptTokens: number; completionTokens: number };
}

export interface TranslationTaskOptions {
  projectId: string;
  modelId: string;
  batches: readonly TranslationBatch[];
  concurrency: number;
  maxRetries: number;
  signal?: AbortSignal;
  request(batch: TranslationBatch, signal?: AbortSignal): Promise<TranslationRequestResult>;
  findCached(block: TranslationBlockRequest): Promise<TranslationBlockResponse | undefined>;
  saveValidated(record: TranslationBlockResponse): Promise<void>;
  onEvent(event: AiLogEvent): void;
  now?: () => number;
}

export interface TranslationTaskResult {
  completedBlockIds: string[];
  cachedBlockIds: string[];
  translations: TranslationBlockResponse[];
  usage: { promptTokens: number; completionTokens: number };
}

class TranslationValidationError extends Error {
  constructor(codes: string[]) {
    super(`Translation validation failed: ${codes.join(', ')}`);
    this.name = 'TranslationValidationError';
  }
}

function abortError(): DOMException {
  return new DOMException('Stopped', 'AbortError');
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError');
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 180);
}

export async function runTranslationTask(
  options: TranslationTaskOptions,
): Promise<TranslationTaskResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer');
  }
  if (options.signal?.aborted) throw abortError();

  const now = options.now ?? Date.now;
  const completed = new Map<string, TranslationBlockResponse>();
  const cached = new Set<string>();
  const usage = { promptTokens: 0, completionTokens: 0 };
  let nextBatchIndex = 0;
  let fatalError: unknown;

  const processBatch = async (batch: TranslationBatch): Promise<void> => {
    const missing: TranslationBlockRequest[] = [];
    for (const block of batch.blocks) {
      if (options.signal?.aborted) throw abortError();
      const cachedRecord = await options.findCached(block);
      if (cachedRecord) {
        completed.set(block.blockId, cachedRecord);
        cached.add(block.blockId);
        options.onEvent({ type: 'cache-hit', at: now(), blockId: block.blockId });
      } else {
        missing.push(block);
      }
    }
    if (missing.length === 0) return;

    const pendingBatch: TranslationBatch = { ...batch, blocks: missing };
    for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
      if (options.signal?.aborted) throw abortError();
      const startedAt = now();
      options.onEvent({
        type: 'batch-started',
        at: startedAt,
        batchId: batch.id,
        blockIds: missing.map((block) => block.blockId),
        modelId: options.modelId,
      });

      try {
        const response = await options.request(pendingBatch, options.signal);
        usage.promptTokens += response.usage.promptTokens;
        usage.completionTokens += response.usage.completionTokens;
        options.onEvent({
          type: 'batch-received',
          at: now(),
          batchId: batch.id,
          elapsedMs: Math.max(0, now() - startedAt),
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
        });

        const validation = validateBatchResponse(missing, response);
        if (!validation.ok) {
          throw new TranslationValidationError(validation.issues.map((issue) => issue.code));
        }

        options.onEvent({
          type: 'batch-validated',
          at: now(),
          batchId: batch.id,
          blockIds: validation.accepted.map((record) => record.blockId),
        });
        for (const record of validation.accepted) {
          await options.saveValidated(record);
          completed.set(record.blockId, record);
          options.onEvent({ type: 'cache-written', at: now(), blockId: record.blockId });
        }
        return;
      } catch (error) {
        if (isAbortError(error, options.signal)) throw abortError();
        const reason = safeErrorMessage(error);
        if (attempt < options.maxRetries) {
          options.onEvent({
            type: 'retry', at: now(), batchId: batch.id, attempt: attempt + 1, reason,
          });
          continue;
        }
        options.onEvent({ type: 'error', at: now(), batchId: batch.id, message: reason });
        throw error;
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (fatalError === undefined) {
      if (options.signal?.aborted) throw abortError();
      const index = nextBatchIndex;
      nextBatchIndex += 1;
      if (index >= options.batches.length) return;
      try {
        await processBatch(options.batches[index]!);
      } catch (error) {
        fatalError = error;
        throw error;
      }
    }
  };

  const workerCount = Math.min(options.concurrency, options.batches.length);
  const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;

  const sourceOrder = options.batches.flatMap((batch) => batch.blocks.map((block) => block.blockId));
  const completedBlockIds = sourceOrder.filter((blockId) => completed.has(blockId));
  return {
    completedBlockIds,
    cachedBlockIds: completedBlockIds.filter((blockId) => cached.has(blockId)),
    translations: completedBlockIds.map((blockId) => completed.get(blockId)!),
    usage,
  };
}
