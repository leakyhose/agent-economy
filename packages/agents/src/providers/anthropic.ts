/**
 * The real provider. Constructing it without a key fails loudly and
 * immediately — a simulation that silently degrades to canned answers is worse
 * than one that refuses to start. The factory in ./index.ts is where the
 * deliberate fall back to the stub lives.
 *
 * The SDK is imported lazily so that a checkout without the dependency
 * installed can still run every test that uses the stub.
 */

import type AnthropicClient from '@anthropic-ai/sdk';
import type { LLMProvider } from '@aw/types';

export const DEFAULT_MODEL = 'claude-haiku-4-5';

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Milliseconds before a single completion is abandoned. */
  timeout?: number;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'AnthropicProvider needs an API key: set ANTHROPIC_API_KEY in the environment ' +
        'or pass { apiKey } explicitly. Use StubProvider to run without one.',
    );
    this.name = 'MissingApiKeyError';
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeout: number;
  private client: AnthropicClient | null = null;

  constructor(options: AnthropicOptions = {}) {
    const key = options.apiKey ?? readEnv('ANTHROPIC_API_KEY');
    if (!key) throw new MissingApiKeyError();
    this.apiKey = key;
    this.model = options.model ?? DEFAULT_MODEL;
    // Replies are one small JSON object; anything larger is a malformed reply
    // we would reject anyway.
    this.maxTokens = options.maxTokens ?? 512;
    this.timeout = options.timeout ?? 20_000;
  }

  private async ensureClient(): Promise<AnthropicClient> {
    if (this.client) return this.client;
    const sdk = await import('@anthropic-ai/sdk');
    const Client = sdk.default;
    this.client = new Client({ apiKey: this.apiKey, timeout: this.timeout });
    return this.client;
  }

  async complete(system: string, user: string): Promise<string> {
    const client = await this.ensureClient();
    const response = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });

    // A declined request is not an answer. Returning empty lets the decision
    // engine treat it like any other unusable reply and fall through to null.
    if (response.stop_reason === 'refusal') return '';

    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
    }
    return text;
  }
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = env?.[name];
  return value && value.length > 0 ? value : undefined;
}
