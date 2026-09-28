import { CONTEXT_LIMITS } from './config';
import { SSEParser } from './sse';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class OpenAIError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Minimal OpenAI REST client. `fetch` is injected: expo/fetch on the phone (streams bodies), Node's in tests. */
export class OpenAIClient {
  constructor(
    readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchImpl(this.baseUrl + path, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let message = body;
      try {
        message = JSON.parse(body).error?.message ?? body;
      } catch {}
      throw new OpenAIError(response.status, `OpenAI ${response.status}: ${message}`);
    }
    return response;
  }

  /** A non-streamed Responses API call; returns the output text. */
  async responseText(body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const response = await this.request('/responses', { method: 'POST', body: JSON.stringify(body), signal });
    return outputText(await response.json());
  }

  /** A streamed Responses API call; yields text deltas. Stopping iteration aborts the request. */
  async *streamText(body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<string> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort);
    try {
      const response = await this.request('/responses', {
        method: 'POST',
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const parser = new SSEParser();
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const data of parser.push(value)) {
          if (data === '[DONE]') return;
          const event = JSON.parse(data);
          if (event.type === 'response.output_text.delta') yield event.delta as string;
          else if (event.type === 'error' || event.type === 'response.failed') {
            throw new OpenAIError(0, event.error?.message ?? event.response?.error?.message ?? 'Response failed');
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      controller.abort(); // no-op when finished; cancels the HTTP stream when the consumer stops early
    }
  }

  /** Unit-length embeddings, one per text. */
  async embed(model: string, texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += 256) {
      const response = await this.request('/embeddings', {
        method: 'POST',
        body: JSON.stringify({
          model,
          input: texts.slice(start, start + 256),
          dimensions: CONTEXT_LIMITS.embeddingDimensions,
        }),
      });
      const json = await response.json();
      for (const item of json.data as { embedding: number[] }[]) out.push(normalize(Float32Array.from(item.embedding)));
    }
    return out;
  }

  /** Opens (or keeps open) a connection before the first question needs it. Free: no tokens. */
  async warm(model: string): Promise<void> {
    await this.request(`/models/${model}`).catch(() => undefined);
  }

  /** Throws with the API's message if the key cannot use this model. Free: no tokens. */
  async checkAccess(model: string): Promise<void> {
    await this.request(`/models/${model}`);
  }
}

export function outputText(response: { output?: { type: string; content?: { type: string; text?: string }[] }[] }): string {
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const content of item.content ?? []) if (content.type === 'output_text' && content.text) parts.push(content.text);
  }
  return parts.join('');
}

export function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}
