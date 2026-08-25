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
  stream?: boolean;
  onStreamProgress?(progress: ChatStreamProgress): void;
}

export interface ChatStreamProgress {
  phase: 'connected' | 'reasoning' | 'content';
  receivedContentChars: number;
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

export class DeepSeekTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`DeepSeek 请求超时：连续 ${Math.ceil(timeoutMs / 1_000)} 秒未收到响应数据`);
    this.name = 'DeepSeekTimeoutError';
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

interface RequestLifetime {
  signal: AbortSignal;
  wait<T>(operation: Promise<T>): Promise<T>;
  heartbeat(): void;
  close(): void;
}

function createRequestLifetime(timeoutMs: number, outerSignal?: AbortSignal): RequestLifetime {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let rejectGate!: (error: unknown) => void;
  const gate = new Promise<never>((_resolve, reject) => { rejectGate = reject; });

  const rejectAndAbort = (error: unknown): void => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    rejectGate(error);
    controller.abort();
  };
  const armWatchdog = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => rejectAndAbort(new DeepSeekTimeoutError(timeoutMs)), timeoutMs);
  };
  const onOuterAbort = (): void => rejectAndAbort(abortError());
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
  armWatchdog();

  return {
    signal: controller.signal,
    wait: <T>(operation: Promise<T>) => Promise.race([operation, gate]),
    heartbeat: armWatchdog,
    close: () => {
      if (!closed) {
        closed = true;
        if (timer) clearTimeout(timer);
      }
      outerSignal?.removeEventListener('abort', onOuterAbort);
    },
  };
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

async function readStreamingCompletion(
  response: Response,
  lifetime: RequestLifetime,
  onProgress?: (progress: ChatStreamProgress) => void,
): Promise<{
  content: string;
  finishReason: string;
  reasoningPresent: boolean;
  usage: ChatUsage;
}> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('DeepSeek 流式响应缺少正文');

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = 'missing';
  let reasoningPresent = false;
  let doneReceived = false;
  const usage: ChatUsage = { promptTokens: 0, completionTokens: 0 };

  const consumeEvent = (eventText: string): void => {
    const data = eventText.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') {
      doneReceived = true;
      return;
    }
    const chunk = JSON.parse(data) as StreamChunk;
    const choice = chunk.choices?.[0];
    const reasoningDelta = choice?.delta?.reasoning_content ?? '';
    const contentDelta = choice?.delta?.content ?? '';
    if (reasoningDelta) reasoningPresent = true;
    if (contentDelta) content += contentDelta;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      usage.promptTokens = chunk.usage.prompt_tokens ?? usage.promptTokens;
      usage.completionTokens = chunk.usage.completion_tokens ?? usage.completionTokens;
    }
    if (reasoningDelta) onProgress?.({ phase: 'reasoning', receivedContentChars: content.length });
    if (contentDelta) onProgress?.({ phase: 'content', receivedContentChars: content.length });
  };

  try {
    while (!doneReceived) {
      const { done, value } = await lifetime.wait(reader.read());
      if (done) break;
      lifetime.heartbeat();
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        consumeEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeEvent(buffer);
    if (!doneReceived) throw new Error('DeepSeek 流式响应在完成前中断');

    return { content, finishReason, reasoningPresent, usage };
  } finally {
    try {
      const cancellation = reader.cancel();
      void cancellation.catch(() => undefined).then(() => {
        try { reader.releaseLock(); } catch { /* Pending transports must not block the caller. */ }
      });
    } catch {
      try { reader.releaseLock(); } catch { /* Pending transports must not block the caller. */ }
    }
  }
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
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const lifetime = createRequestLifetime(timeoutMs, opts.signal);

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 4096,
    stream: opts.stream ?? false,
  };
  if (opts.stream) body.stream_options = { include_usage: true };
  if (opts.thinkingMode) body.thinking = { type: opts.thinkingMode };
  if (opts.responseFormat) body.response_format = { type: opts.responseFormat };
  if (opts.thinkingMode !== 'enabled') body.temperature = opts.temperature ?? 0.2;

  try {
    const response = await lifetime.wait(fetchImpl(buildChatUrl(opts.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: lifetime.signal,
    }));
    lifetime.heartbeat();

    if (!response.ok) {
      if (response.status === 402) throw new DeepSeekInsufficientBalanceError();
      throw new Error(`DeepSeek HTTP ${response.status}`);
    }

    let content: string | null | undefined;
    let finishReason: string;
    let reasoningPresent: boolean;
    let usage: ChatUsage;
    if (opts.stream) {
      opts.onStreamProgress?.({ phase: 'connected', receivedContentChars: 0 });
      const streamed = await readStreamingCompletion(response, lifetime, opts.onStreamProgress);
      ({ content, finishReason, reasoningPresent, usage } = streamed);
    } else {
      const data = (await lifetime.wait(response.json())) as {
        choices?: {
          finish_reason?: string | null;
          message?: { content?: string | null; reasoning_content?: string | null };
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      content = choice?.message?.content;
      finishReason = choice?.finish_reason ?? 'missing';
      reasoningPresent = Boolean(choice?.message?.reasoning_content);
      usage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      };
    }

    const reasoningState = reasoningPresent ? 'present' : 'absent';
    const outputDiagnostic = `finish_reason=${finishReason}, completion_tokens=${usage.completionTokens}, prompt_tokens=${usage.promptTokens}, reasoning_content=${reasoningState}`;
    if (finishReason === 'length') {
      throw new DeepSeekOutputLimitError(`DeepSeek 本次响应达到最大生成长度（这不是账户余额不足；${outputDiagnostic}）`);
    }
    if (!content?.trim()) {
      const message = `DeepSeek 未返回最终内容（${outputDiagnostic}）`;
      if (reasoningPresent) throw new DeepSeekOutputLimitError(message);
      throw new Error(message);
    }

    return { content, usage };
  } catch (error) {
    if (opts.signal?.aborted) throw abortError();
    throw error;
  } finally {
    lifetime.close();
  }
}
