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

export class DeepSeekOutputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekOutputLimitError';
  }
}

export class DeepSeekInsufficientBalanceError extends Error {
  constructor(message = 'DeepSeek 账户余额不足（HTTP 402）') {
    super(message);
    this.name = 'DeepSeekInsufficientBalanceError';
  }
}

export const CURRENT_DEEPSEEK_MODELS: readonly DeepSeekModel[] = [
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
      if (response.status === 402) throw new DeepSeekInsufficientBalanceError();
      throw new Error(`DeepSeek HTTP ${response.status}`);
    }

    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const available = new Set(data.data?.map((model) => model.id) ?? []);
    return CURRENT_DEEPSEEK_MODELS.filter((model) => available.has(model.id)).map((model) => ({ ...model }));
  } catch (error) {
    if (opts.signal?.aborted) throw abortError();
    if (opts.offlineFallback) return CURRENT_DEEPSEEK_MODELS.map((model) => ({ ...model }));
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
    if (response.status === 402) throw new DeepSeekInsufficientBalanceError();
    throw new Error(`DeepSeek HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: {
      finish_reason?: string | null;
      message?: { content?: string | null; reasoning_content?: string | null };
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason ?? 'missing';
  const completionTokens = data.usage?.completion_tokens ?? 0;
  const promptTokens = data.usage?.prompt_tokens ?? 0;
  const reasoningState = choice?.message?.reasoning_content ? 'present' : 'absent';
  const outputDiagnostic = `finish_reason=${finishReason}, completion_tokens=${completionTokens}, prompt_tokens=${promptTokens}, reasoning_content=${reasoningState}`;
  if (finishReason === 'length') {
    throw new DeepSeekOutputLimitError(`DeepSeek 本次响应达到最大生成长度（这不是账户余额不足；${outputDiagnostic}）`);
  }
  if (!content?.trim()) {
    const message = `DeepSeek 未返回最终内容（${outputDiagnostic}）`;
    if (reasoningState === 'present') {
      throw new DeepSeekOutputLimitError(message);
    }
    throw new Error(message);
  }

  return {
    content,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}
