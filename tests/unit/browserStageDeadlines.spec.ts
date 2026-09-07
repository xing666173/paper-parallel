import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPipelineStages } from '../../src/core/pipeline/browserStages';
import type { ProjectRepository } from '../../src/core/project/repository';
import { createTaskSnapshot } from '../../src/core/task/stateMachine';
import type { TaskSnapshot } from '../../src/types/models';

const doubles = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('../../src/core/pdf/runtime', () => ({ getDocument: doubles.getDocument, OPS: {} }));

function harness() {
  const settings: NonNullable<TaskSnapshot['settings']> = {
    sourceFileHash: 'local-test', sourceFileName: 'local.pdf', modelId: 'deepseek-v4-flash',
    thinkingMode: 'disabled',
  };
  const stages = createBrowserPipelineStages({ projectId: 'test', apiKey: 'local-placeholder', maxRetries: 0,
    snapshot: { ...createTaskSnapshot('test', 1), settings },
    repository: {
      findArtifact: async () => ({ blob: new Blob(['local-pdf-fixture']) }),
      findTranslation: async () => undefined,
    } as unknown as ProjectRepository,
  });
  return { stages, settings };
}

describe('browser stage deadlines', () => {
  beforeEach(() => { vi.useFakeTimers(); doubles.getDocument.mockReset(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('stops a PDF operator-list wait even if PDF.js destruction never resolves', async () => {
    const getOperatorList = vi.fn(() => new Promise<never>(() => {}));
    const destroy = vi.fn(() => new Promise<never>(() => {}));
    doubles.getDocument.mockReturnValue({ destroy, promise: Promise.resolve({ numPages: 1,
      getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }),
        getTextContent: async () => ({ items: [] }), getOperatorList }),
    }) });
    const controller = new AbortController();
    const promise = harness().stages.parse({}, controller.signal);
    const outcome = promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(getOperatorList).toHaveBeenCalledOnce();
    controller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports the failing page when PDF graphics extraction exceeds its deadline', async () => {
    const destroy = vi.fn(async () => undefined);
    doubles.getDocument.mockReturnValue({ destroy, promise: Promise.resolve({ numPages: 1,
      getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }),
        getTextContent: async () => ({ items: [] }), getOperatorList: () => new Promise<never>(() => {}) }),
    }) });
    const outcome = harness().stages.parse({}, new AbortController().signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await outcome).toMatchObject({ name: 'AsyncOperationTimeoutError', message: '解析 PDF 第 1 页图形超时' });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('cleans up a document whose loading promise never settles', async () => {
    const destroy = vi.fn(async () => undefined);
    doubles.getDocument.mockReturnValue({ destroy, promise: new Promise<never>(() => {}) });
    const outcome = harness().stages.parse({}, new AbortController().signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await outcome).toMatchObject({ name: 'AsyncOperationTimeoutError', message: '打开 PDF 超时' });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('bounds a real translation request even while SSE keep-alives continue', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const cancel = vi.fn(() => clearInterval(timer));
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => controller.enqueue(new TextEncoder().encode(': keep-alive\n\n')), 40_000);
      },
      cancel,
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const { stages, settings } = harness();
    const outcome = stages.translate({ settings,
      doc: { meta: { title: 'Local' }, semanticUnits: [], layoutMode: 'single' },
      requests: [{ blockId: 'body', kind: 'paragraph', source: 'A local test sentence.',
        alignmentMode: 'paragraph-fallback', sourceSentences: [], protectedTokens: [] }],
    }, new AbortController().signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(299_000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await outcome).toMatchObject({ name: 'DeepSeekTimeoutError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
