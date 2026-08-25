import { describe, expect, it } from 'vitest';
import { runTranslationTask } from '../../src/core/translate/coordinator';
import type { TranslationBatch } from '../../src/core/translate/batcher';
import type {
  TranslationBlockRequest,
  TranslationBlockResponse,
} from '../../src/core/translate/protocol';

function block(id: string, source = 'Accuracy was 96%.'): TranslationBlockRequest {
  return {
    blockId: id,
    kind: 'paragraph',
    source,
    alignmentMode: 'sentence-candidates',
    sourceSentences: [{ id: `${id}-s-1`, text: source }],
    protectedTokens: source.includes('96%') ? ['96%'] : [],
  };
}

function translated(id: string, translation = '准确率为 96%。'): TranslationBlockResponse {
  return {
    blockId: id,
    translation,
    alignmentGroups: [{ sourceSentenceIds: [`${id}-s-1`], targetSegments: [translation] }],
    newTerms: [],
    warnings: [],
  };
}

function batch(id: string, blocks: TranslationBlockRequest[]): TranslationBatch {
  return { id, blocks, estimatedTokens: 40, oversized: false };
}

describe('cancellable translation coordinator', () => {
  it('persists only validated blocks and emits lifecycle events', async () => {
    const events: string[] = [];
    const saved: string[] = [];

    const result = await runTranslationTask({
      projectId: 'p1',
      modelId: 'deepseek-v4-flash',
      batches: [batch('batch-1', [block('b1')])],
      concurrency: 2,
      maxRetries: 2,
      request: async () => ({
        blocks: [translated('b1')],
        usage: { promptTokens: 20, completionTokens: 8 },
      }),
      findCached: async () => undefined,
      saveValidated: async (record) => { saved.push(record.blockId); },
      onEvent: (event) => { events.push(event.type); },
    });

    expect(result.completedBlockIds).toEqual(['b1']);
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 8 });
    expect(saved).toEqual(['b1']);
    expect(events).toEqual(['batch-started', 'batch-received', 'batch-validated', 'cache-written']);
  });

  it('uses validated cache entries and requests only missing blocks', async () => {
    const requested: string[][] = [];
    const events: string[] = [];
    const result = await runTranslationTask({
      projectId: 'p1',
      modelId: 'deepseek-v4-flash',
      batches: [batch('batch-1', [block('cached'), block('missing', 'A result.')])],
      concurrency: 1,
      maxRetries: 0,
      request: async (pending) => {
        requested.push(pending.blocks.map((item) => item.blockId));
        return {
          blocks: [translated('missing', '一个结果。')],
          usage: { promptTokens: 5, completionTokens: 2 },
        };
      },
      findCached: async (item) => item.blockId === 'cached' ? translated('cached') : undefined,
      saveValidated: async () => undefined,
      onEvent: (event) => { events.push(event.type); },
    });

    expect(requested).toEqual([['missing']]);
    expect(result.completedBlockIds).toEqual(['cached', 'missing']);
    expect(result.cachedBlockIds).toEqual(['cached']);
    expect(events[0]).toBe('cache-hit');
  });

  it('retries an invalid batch without persisting the rejected response', async () => {
    let attempts = 0;
    const saved: string[] = [];
    const events: string[] = [];
    await runTranslationTask({
      projectId: 'p1',
      modelId: 'deepseek-v4-flash',
      batches: [batch('batch-1', [block('b1')])],
      concurrency: 1,
      maxRetries: 1,
      request: async () => {
        attempts += 1;
        return {
          blocks: [translated('b1', attempts === 1 ? '准确率为 69%。' : '准确率为 96%。')],
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
      findCached: async () => undefined,
      saveValidated: async (record) => { saved.push(record.translation); },
      onEvent: (event) => { events.push(event.type); },
    });

    expect(attempts).toBe(2);
    expect(saved).toEqual(['准确率为 96%。']);
    expect(events.filter((type) => type === 'retry')).toHaveLength(1);
  });

  it('aborts active work without starting queued batches', async () => {
    const controller = new AbortController();
    const started: string[] = [];

    await expect(runTranslationTask({
      projectId: 'p1',
      modelId: 'deepseek-v4-flash',
      batches: [batch('batch-1', [block('b1')]), batch('batch-2', [block('b2')])],
      concurrency: 1,
      maxRetries: 0,
      signal: controller.signal,
      request: async (pending) => {
        started.push(pending.id);
        controller.abort();
        throw new DOMException('Stopped', 'AbortError');
      },
      findCached: async () => undefined,
      saveValidated: async () => undefined,
      onEvent: () => undefined,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(started).toEqual(['batch-1']);
  });

  it('never exceeds the configured worker concurrency', async () => {
    let active = 0;
    let maximumActive = 0;
    await runTranslationTask({
      projectId: 'p1',
      modelId: 'deepseek-v4-flash',
      batches: [
        batch('batch-1', [block('b1', 'One.')]),
        batch('batch-2', [block('b2', 'Two.')]),
        batch('batch-3', [block('b3', 'Three.')]),
      ],
      concurrency: 2,
      maxRetries: 0,
      request: async (pending) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          blocks: pending.blocks.map((item) => translated(item.blockId, `${item.source}译`)),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
      findCached: async () => undefined,
      saveValidated: async () => undefined,
      onEvent: () => undefined,
    });

    expect(maximumActive).toBe(2);
  });

  it('redacts API-key-shaped values from emitted errors', async () => {
    const messages: string[] = [];
    await expect(runTranslationTask({
      projectId: 'p1',
      modelId: 'deepseek-v4-flash',
      batches: [batch('batch-1', [block('b1')])],
      concurrency: 1,
      maxRetries: 0,
      request: async () => { throw new Error('request failed for sk-super-secret-123'); },
      findCached: async () => undefined,
      saveValidated: async () => undefined,
      onEvent: (event) => {
        if (event.type === 'error') messages.push(event.message);
      },
    })).rejects.toThrow('request failed');

    expect(messages).toEqual(['request failed for [redacted]']);
  });

  it('splits an output-exhausted batch instead of retrying the same paid request', async () => {
    const requested: string[][] = [];
    const events: string[] = [];
    const blocks = ['b1', 'b2', 'b3', 'b4'].map((id) => block(id, `${id} source.`));

    const result = await runTranslationTask({
      projectId: 'p1', modelId: 'deepseek-v4-pro', batches: [batch('batch-1', blocks)],
      concurrency: 1, maxRetries: 2,
      request: async (pending) => {
        requested.push(pending.blocks.map((item) => item.blockId));
        if (pending.blocks.length > 2) {
          const error = new Error('finish_reason=length');
          error.name = 'DeepSeekOutputLimitError';
          throw error;
        }
        return {
          blocks: pending.blocks.map((item) => translated(item.blockId, `${item.source}译`)),
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
      findCached: async () => undefined,
      saveValidated: async () => undefined,
      onEvent: (event) => { events.push(event.type); },
    });

    expect(requested).toEqual([
      ['b1', 'b2', 'b3', 'b4'],
      ['b1', 'b2'],
      ['b3', 'b4'],
    ]);
    expect(events).toContain('batch-split');
    expect(events).not.toContain('retry');
    expect(result.completedBlockIds).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  it('splits a malformed protocol response instead of retrying the same paid request', async () => {
    const requested: string[][] = [];
    const events: string[] = [];
    const blocks = ['b1', 'b2', 'b3', 'b4'].map((id) => block(id, `${id} source.`));

    const result = await runTranslationTask({
      projectId: 'p1', modelId: 'deepseek-v4-pro', batches: [batch('batch-1', blocks)],
      concurrency: 1, maxRetries: 2,
      request: async (pending) => {
        requested.push(pending.blocks.map((item) => item.blockId));
        if (pending.blocks.length > 2) {
          const error = new Error('DeepSeek JSON blocks 必须为数组');
          error.name = 'DeepSeekProtocolError';
          throw error;
        }
        return {
          blocks: pending.blocks.map((item) => translated(item.blockId, `${item.source}译`)),
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
      findCached: async () => undefined,
      saveValidated: async () => undefined,
      onEvent: (event) => { events.push(event.type); },
    });

    expect(requested).toEqual([
      ['b1', 'b2', 'b3', 'b4'],
      ['b1', 'b2'],
      ['b3', 'b4'],
    ]);
    expect(events).toContain('batch-split');
    expect(events).not.toContain('retry');
    expect(result.completedBlockIds).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  it('persists valid blocks from a partial response and retries only the unresolved block', async () => {
    const requested: string[][] = [];
    const saved: string[] = [];
    const progress: string[][] = [];

    const result = await runTranslationTask({
      projectId: 'p1', modelId: 'deepseek-v4-pro',
      batches: [batch('batch-1', [block('b1', 'One.'), block('b2', 'Two.')])],
      concurrency: 1, maxRetries: 2,
      request: async (pending) => {
        requested.push(pending.blocks.map((item) => item.blockId));
        const returned = requested.length === 1 ? pending.blocks.slice(0, 1) : pending.blocks;
        return {
          blocks: returned.map((item) => translated(item.blockId, `${item.source}译`)),
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
      findCached: async () => undefined,
      saveValidated: async (record) => { saved.push(record.blockId); },
      onEvent: (event) => {
        if (event.type === 'batch-validated') progress.push(event.blockIds);
      },
    });

    expect(requested).toEqual([['b1', 'b2'], ['b2']]);
    expect(saved).toEqual(['b1', 'b2']);
    expect(progress).toEqual([['b1'], ['b2']]);
    expect(result.completedBlockIds).toEqual(['b1', 'b2']);
  });

  it('repairs a single output-limited block once with thinking disabled', async () => {
    const requested: Array<{ recovery?: { disableThinking?: boolean; reason?: string } }> = [];
    const events: string[] = [];

    const result = await runTranslationTask({
      projectId: 'p1', modelId: 'deepseek-v4-pro',
      batches: [batch('batch-1', [block('b1', 'One.')])],
      concurrency: 1, maxRetries: 2,
      request: async (pending) => {
        const recovery = (pending as TranslationBatch & {
          recovery?: { disableThinking?: boolean; reason?: string };
        }).recovery;
        requested.push({ recovery });
        if (!recovery) {
          const error = new Error('finish_reason=length');
          error.name = 'DeepSeekOutputLimitError';
          throw error;
        }
        return {
          blocks: [translated('b1', 'One.译')],
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
      findCached: async () => undefined,
      saveValidated: async () => undefined,
      onEvent: (event) => { events.push(event.type); },
    });

    expect(requested).toEqual([
      { recovery: undefined },
      { recovery: { disableThinking: true, reason: 'output-limit' } },
    ]);
    expect(events.filter((type) => type === 'retry')).toHaveLength(1);
    expect(result.completedBlockIds).toEqual(['b1']);
  });

  it('reports the unresolved block IDs when a final batch failure occurs', async () => {
    const errors: string[][] = [];
    await expect(runTranslationTask({
      projectId: 'p1', modelId: 'deepseek-v4-pro',
      batches: [batch('batch-1', [block('b1', 'One.')])],
      concurrency: 1, maxRetries: 0,
      request: async () => { throw new Error('network down'); },
      findCached: async () => undefined,
      saveValidated: async () => undefined,
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.blockIds);
      },
    })).rejects.toThrow('network down');

    expect(errors).toEqual([['b1']]);
  });

  it('counts progress only after cache persistence and retries only the unsaved record', async () => {
    const requested: string[][] = [];
    const progress: string[][] = [];
    const saved: string[] = [];
    let failSecondSave = true;

    const result = await runTranslationTask({
      projectId: 'p1', modelId: 'deepseek-v4-pro',
      batches: [batch('batch-1', [block('b1', 'One.'), block('b2', 'Two.')])],
      concurrency: 1, maxRetries: 1,
      request: async (pending) => {
        requested.push(pending.blocks.map((item) => item.blockId));
        return {
          blocks: pending.blocks.map((item) => translated(item.blockId, `${item.source}译`)),
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
      findCached: async () => undefined,
      saveValidated: async (record) => {
        if (record.blockId === 'b2' && failSecondSave) {
          failSecondSave = false;
          throw new Error('IndexedDB write failed');
        }
        saved.push(record.blockId);
      },
      onEvent: (event) => {
        if (event.type === 'batch-validated') progress.push(event.blockIds);
      },
    });

    expect(requested).toEqual([['b1', 'b2'], ['b2']]);
    expect(saved).toEqual(['b1', 'b2']);
    expect(progress).toEqual([['b1'], ['b2']]);
    expect(result.completedBlockIds).toEqual(['b1', 'b2']);
  });
});
