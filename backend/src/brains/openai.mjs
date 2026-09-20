// OpenAI brain. Same tools, same prompt, same interface as the stub. The loop it runs is
// chat.mjs, which the Baseten brain shares; what is OpenAI's alone is the client, the price
// list, and one quirk of the gpt-5 family.
import OpenAI from 'openai';
import { CFG } from '../config.mjs';
import { chatBrain } from './chat.mjs';

// $ per 1M tokens [input, output], standard tier, checked 2026-09-19
const PRICE = {
  'gpt-5.6-luna': [0.20, 1.20],
  'gpt-4.1-nano': [0.10, 0.40], 'gpt-4.1-mini': [0.40, 1.60], 'gpt-4o-mini': [0.15, 0.60],
  'gpt-5-nano': [0.05, 0.40], 'gpt-5-mini': [0.25, 2.00], 'gpt-5.4-nano': [0.20, 1.25],
};

export function openaiBrain() {
  return chatBrain({
    label: `openai (${CFG.MODEL})`,
    client: new OpenAI(),
    pickModel: () => CFG.MODEL,
    price: model => PRICE[model] ?? [0, 0],
    // gpt-5.x models reason by default, and chat completions refuses tools unless
    // reasoning is off. Off is also faster and cheaper — this is a quick decision.
    params: model => (model.startsWith('gpt-5') ? { reasoning_effort: 'none' } : {}),
  });
}
