// DeepSeek OpenAI-compatible browser client. Native fetch keeps the API key in
// the caller's browser and allows tests to inject a local transport.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type DeepSeekModelId = 'deepseek-v4-flash' | 'deepseek-v4-pro';

export interface DeepSeekModel {
  id: DeepSeekModelId;
  label: 'DeepSeek V4 Flash' | 'DeepSeek V4 Pro';
}

export interface DeepSeekConnectionOptions {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  offlineFallback?: boolean;
}

export interface ChatCompletionOptions extends DeepSeekConnectionOptions {
  model: string;
  messages: ChatMessage[];
  thinkingMode?: 'enabled' | 'disabled';
  responseFormat?: 'json_object';
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatCompletionResult {
  content: string;
  usage: ChatUsage;
}

const CURRENT_MODELS: readonly DeepSeekModel[] = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];

function baseUrlWithSlash(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/`;
}

function buildApiUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrlWithSlash(baseUrl)).toString();
}

export function buildChatUrl(baseUrl: string): string {
  return buildApiUrl(baseUrl, 'chat/completions');
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

export async function listModels(opts: DeepSeekConnectionOptions): Promise<DeepSeekModel[]> {
  if (opts.signal?.aborted) throw abortError();

  const fetchImpl = opts.fetchFn ?? fetch;
  try {
    const response = await fetchImpl(buildApiUrl(opts.baseUrl, 'models'), {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: opts.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`DeepSeek HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const available = new Set(data.data?.map((model) => model.id) ?? []);
    return CURRENT_MODELS.filter((model) => available.has(model.id)).map((model) => ({ ...model }));
  } catch (error) {
    if (opts.signal?.aborted) throw abortError();
    if (opts.offlineFallback) return CURRENT_MODELS.map((model) => ({ ...model }));
    throw error;
  }
}

export async function chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  if (opts.signal?.aborted) throw abortError();

  const fetchImpl = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 4096,
    stream: false,
  };
  if (opts.thinkingMode) body.thinking = { type: opts.thinkingMode };
  if (opts.responseFormat) body.response_format = { type: opts.responseFormat };
  if (opts.thinkingMode !== 'enabled') body.temperature = opts.temperature ?? 0.2;

  let response: Response;
  try {
    response = await fetchImpl(buildChatUrl(opts.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw new Error('DeepSeek 请求超时');
    if (opts.signal?.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    throw new Error(`DeepSeek HTTP ${response.status}: ${responseBody.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
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
