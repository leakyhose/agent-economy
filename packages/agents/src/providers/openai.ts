/**
 * The OpenAI provider. Constructing it without a key fails loudly and
 * immediately — a simulation that silently degrades to canned answers is worse
 * than one that refuses to start. The deliberate fall back to the stub lives in
 * the factory in ./index.ts.
 *
 * The SDK is imported lazily so a checkout without the dependency installed can
 * still run every test that uses the stub.
 */

import type OpenAIClient from 'openai';
import type { LLMProvider } from '@aw/types';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';

export interface OpenAIOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  timeout?: number;
  /** Simultaneous in-flight completions. A population of agents will otherwise
   *  open one connection each on the same tick and be rate limited. */
  concurrency?: number;
}

export class MissingOpenAIKeyError extends Error {
  constructor() {
    super(
      'OpenAIProvider needs an API key: set OPENAI_API_KEY in the environment ' +
        'or pass { apiKey } explicitly. Use StubProvider to run without one.',
    );
    this.name = 'MissingOpenAIKeyError';
  }
}

/** Bounded concurrency, so one tick's worth of agents does not stampede. */
function semaphore(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeout: number;
  private readonly gate: <T>(fn: () => Promise<T>) => Promise<T>;
  private client: OpenAIClient | null = null;

  constructor(options: OpenAIOptions = {}) {
    const key = options.apiKey ?? readEnv('OPENAI_API_KEY');
    if (!key) throw new MissingOpenAIKeyError();
    this.apiKey = key;
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
    // A reply is one small JSON object; anything larger is malformed and would
    // be rejected downstream anyway.
    this.maxTokens = options.maxTokens ?? 512;
    this.timeout = options.timeout ?? 20_000;
    this.gate = semaphore(options.concurrency ?? 12);
  }

  private async ensureClient(): Promise<OpenAIClient> {
    if (this.client) return this.client;
    const sdk = await import('openai');
    const Client = sdk.default;
    this.client = new Client({ apiKey: this.apiKey, timeout: this.timeout });
    return this.client;
  }

  async complete(system: string, user: string): Promise<string> {
    const client = await this.ensureClient();
    const response = await this.gate(() =>
      client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_completion_tokens: this.maxTokens,
        // The agent's contract is one JSON object, so ask the API to guarantee it
        // rather than hoping. Malformed replies are still rejected downstream.
        response_format: { type: 'json_object' },
        // gpt-5.x reasons by default. This is a small, fast, frequent decision:
        // reasoning makes it slower and dearer without making it better.
        ...(this.model.startsWith('gpt-5') ? { reasoning_effort: 'none' as const } : {}),
      }),
    );

    // An empty reply is not an answer. Returning '' lets the decision layer
    // reject it as malformed instead of this layer inventing an action.
    return response.choices[0]?.message?.content?.trim() ?? '';
  }
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}
