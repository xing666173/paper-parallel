import { describe, it, expect, vi } from 'vitest';
import { chatCompletion, buildChatUrl } from '../../src/core/translate/client';

describe('translate: DeepSeek client', () => {
  it('buildChatUrl 去除尾部斜杠并拼接路径', () => {
    expect(buildChatUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
    expect(buildChatUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/chat/completions');
    expect(buildChatUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('chatCompletion 请求体与鉴权正确,解析 choices/usage', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'pong' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200 })) as any;
    const r = await chatCompletion({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
      fetchFn,
    });
    expect(r.content).toBe('pong');
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
    const [url, init] = fetchFn.mock.calls[0] as any[];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'deepseek-chat', max_tokens: 1, stream: false });
  });

  it('非 2xx 抛出含状态码的错误', async () => {
    const fetchFn = vi.fn(async () => new Response('{"error":"bad key"}', { status: 401 })) as any;
    await expect(
      chatCompletion({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-bad', model: 'm', messages: [], fetchFn }),
    ).rejects.toThrow('DeepSeek HTTP 401');
  });
});
