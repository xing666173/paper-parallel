// ============================================================================
// client.ts —— DeepSeek OpenAI 兼容客户端(浏览器 / Node 通用)
// 纯 fetch;不引入 SDK。请求构造可注入 fetch 以便 Vitest mock。
// ============================================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  baseUrl: string;          // 默认 https://api.deepseek.com
  apiKey: string;
  model: string;            // 默认 deepseek-chat
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;   // 测试注入
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatCompletionResult {
  content: string;
  usage: ChatUsage;
}

export function buildChatUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

export async function chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const fetchImpl = opts.fetchFn || fetch;
  const url = buildChatUrl(opts.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 4096,
        stream: false,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 响应缺少 choices[0].message.content');
  return {
    content,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}
