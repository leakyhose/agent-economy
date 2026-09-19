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
import type { LLMProvider, LLMUsage } from '@aw/types';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';

export interface OpenAIOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  timeout?: number;
  /** Simultaneous in-flight completions. A population of agents will otherwise
   *  open one connection each on the same tick and be rate limited. */
  concurrency?: number;
  /** [input, output] US dollars per 1M tokens, so the provider can price its
   *  own usage. Without it tokens are still counted and cost reads zero. */
  price?: [number, number];
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
  private readonly price: [number, number];
  private client: OpenAIClient | null = null;
  private readonly spend: LLMUsage = {
    calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
    costUsd: 0, errors: 0, rateLimited: 0,
  };

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
    this.price = options.price ?? [0, 0];
  }

  usage(): LLMUsage { return { ...this.spend }; }

  private async ensureClient(): Promise<OpenAIClient> {
    if (this.client) return this.client;
    const sdk = await import('openai');
    const Client = sdk.default;
    this.client = new Client({ apiKey: this.apiKey, timeout: this.timeout });
    return this.client;
  }

  async complete(system: string, user: string): Promise<string> {
    const client = await this.ensureClient();
    let response;
    try {
      response = await this.gate(() =>
        client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_completion_tokens: this.maxTokens,
          // The agent's contract is one JSON object, so ask the API to guarantee
          // it rather than hoping. Malformed replies are still rejected
          // downstream. The word "json" must appear in the messages for this
          // mode, which the system prompt satisfies.
          response_format: { type: 'json_object' },
          // gpt-5.x reasons by default. This is a small, fast, frequent
          // decision: reasoning makes it slower and dearer without making it
          // better.
          ...(this.model.startsWith('gpt-5') ? { reasoning_effort: 'none' as const } : {}),
        }),
      );
    } catch (error) {
      // A failed call still cost time; record it and let the decision layer
      // treat an empty reply as a malformed one.
      const status = (error as { status?: number }).status;
      if (status === 429) this.spend.rateLimited += 1;
      else this.spend.errors += 1;
      return '';
    }

    const usage = response.usage;
    if (usage) {
      const input = usage.prompt_tokens ?? 0;
      const output = usage.completion_tokens ?? 0;
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
      this.spend.calls += 1;
      this.spend.promptTokens += input;
      this.spend.completionTokens += output;
      this.spend.cachedTokens += cached;
      this.spend.costUsd +=
        (input / 1e6) * this.price[0] + (output / 1e6) * this.price[1];
    }

    // An empty reply is not an answer. Returning '' lets the decision layer
    // reject it as malformed instead of this layer inventing an action.
    return response.choices[0]?.message?.content?.trim() ?? '';
  }
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}
