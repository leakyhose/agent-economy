// Models the dashboard may offer.
//
// Prices are $ per 1M tokens [input, output], carried over from the prototype's
// table so the console can show what a run is likely to cost before it starts.
// `stub` is not a model: it is the deterministic provider, and it is free.
export interface ModelChoice {
  id: string;
  label: string;
  provider: 'stub' | 'openai';
  /** [input, output] $ per 1M tokens. Absent for the stub. */
  price?: [number, number];
  note?: string;
}

export const MODELS: ModelChoice[] = [
  { id: 'stub', label: 'Deterministic stub', provider: 'stub',
    note: 'No API calls, no cost, fully reproducible' },
  { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna', provider: 'openai', price: [0.20, 1.20] },
  { id: 'gpt-5-mini',   label: 'gpt-5-mini',   provider: 'openai', price: [0.25, 2.00] },
  { id: 'gpt-5-nano',   label: 'gpt-5-nano',   provider: 'openai', price: [0.05, 0.40],
    note: 'Cheapest; weaker reasoning' },
  { id: 'gpt-5.4-nano', label: 'gpt-5.4-nano', provider: 'openai', price: [0.20, 1.25] },
  { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini', provider: 'openai', price: [0.40, 1.60] },
  { id: 'gpt-4o-mini',  label: 'gpt-4o-mini',  provider: 'openai', price: [0.15, 0.60] },
];

export function modelChoice(id: string): ModelChoice {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!;
}

/** Which engines an agent population should run. */
export const BRAINS = [
  { id: 'mix',     label: 'Mixed',        note: 'A quarter LLM, a quarter hybrid, half deterministic' },
  { id: 'llm',     label: 'All LLM',      note: 'Every agent calls the model every decision' },
  { id: 'hybrid',  label: 'All hybrid',   note: 'Model only at decision points' },
  { id: 'utility', label: 'All utility',  note: 'Deterministic scoring, no model' },
  { id: 'rule',    label: 'All rule',     note: 'Deterministic heuristics, no model' },
] as const;
