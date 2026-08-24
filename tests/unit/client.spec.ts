import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildChatUrl,
  chatCompletion,
  listModels,
} from '../../src/core/translate/client';

function pendingUntilAbortFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  })) as typeof fetch;
}

describe('translate: DeepSeek client', () => {
  afterEach(() => vi.useRealTimers());

  it('buildChatUrl removes trailing slashes and appends the endpoint', () => {
    expect(buildChatUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
    expect(buildChatUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/chat/completions');
    expect(buildChatUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('lists current models and excludes deprecated aliases', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
      ],
    }), { status: 200 }));

    const models = await listModels({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      fetchFn: fetchSpy as unknown as typeof fetch,
    });

    expect(models).toEqual([
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ]);
    const calls = fetchSpy.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    expect(calls[0]?.[0]).toBe('https://api.deepseek.com/models');
  });

  it('uses current models as an explicit offline fallback only', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;

    await expect(listModels({
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', fetchFn,
    })).rejects.toThrow('offline');
    await expect(listModels({
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', fetchFn, offlineFallback: true,
    })).resolves.toEqual([
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ]);
  });

  it('sends thinking and JSON response options without temperature', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"blocks":[]}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200 }));

    const result = await chatCompletion({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-v4-pro',
      thinkingMode: 'enabled',
      responseFormat: 'json_object',
      messages: [{ role: 'user', content: 'translate' }],
      maxTokens: 1,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });

    expect(result).toEqual({
      content: '{"blocks":[]}',
      usage: { promptTokens: 10, completionTokens: 2 },
    });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'translate' }],
      thinking: { type: 'enabled' },
      response_format: { type: 'json_object' },
      max_tokens: 1,
      stream: false,
    });
  });

  it('normalizes an internal timeout without masking caller aborts', async () => {
    vi.useFakeTimers();
    const timedOut = chatCompletion({
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-v4-flash',
      messages: [], fetchFn: pendingUntilAbortFetch(), timeoutMs: 25,
    });
    const timeoutAssertion = expect(timedOut).rejects.toThrow('DeepSeek 请求超时');
    await vi.advanceTimersByTimeAsync(25);
    await timeoutAssertion;

    const controller = new AbortController();
    const aborted = chatCompletion({
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-v4-flash',
      messages: [], fetchFn: pendingUntilAbortFetch(), signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws an error containing the HTTP status for non-2xx responses', async () => {
    const fetchFn = vi.fn(async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof fetch;
    await expect(chatCompletion({
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-bad', model: 'deepseek-v4-flash',
      messages: [], fetchFn,
    })).rejects.toThrow('DeepSeek HTTP 401');
  });
});
