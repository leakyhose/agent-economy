/**
 * Provider selection. The stub is the default everywhere, including in the
 * factory: a missing key must degrade the quality of the decisions, never stop
 * the simulation.
 */

import type { LLMProvider } from '@aw/types';
import { OpenAIProvider, MissingOpenAIKeyError, type OpenAIOptions } from './openai.ts';
import { StubProvider, type StubOptions } from './stub.ts';

export { StubProvider, ScriptedProvider, parsePrompt, type StubOptions } from './stub.ts';
export {
  OpenAIProvider,
  MissingOpenAIKeyError,
  DEFAULT_OPENAI_MODEL,
  type OpenAIOptions,
} from './openai.ts';
export {
  renderPrompt,
  systemPrompt,
  userPrompt,
  type PromptOptions,
  type RenderedPrompt,
} from './prompt.ts';

export type ProviderKind = 'stub' | 'openai';

export interface ProviderOptions extends OpenAIOptions, StubOptions {
  kind?: ProviderKind;
  /** Called instead of console.warn when the chosen provider is unavailable. */
  onFallback?: (reason: string) => void;
}

/**
 * Returns the requested provider, or the stub when it cannot be built. The
 * caller is told what happened; it is never surprised by an exception.
 */
export function createProvider(options: ProviderOptions = {}): LLMProvider {
  const kind = options.kind ?? 'stub';
  if (kind === 'stub') return new StubProvider(options);
  try {
    return new OpenAIProvider(options);
  } catch (error) {
    const reason =
      error instanceof MissingOpenAIKeyError
        ? 'no API key available'
        : `provider construction failed: ${String(error)}`;
    const notify = options.onFallback ?? ((message: string) => console.warn(`[agents] ${message}`));
    notify(`falling back to the deterministic stub provider (${reason}).`);
    return new StubProvider(options);
  }
}
