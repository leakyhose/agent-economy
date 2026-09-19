import type { SimEvent } from '@aw/types';
import { ENGINE_EVENTS, type ViewConfig } from './viewConfig.ts';

export type Severity = 'chain' | 'reject' | 'market' | 'alert' | 'normal';

/** Severity comes from where an event originated, never from what it is called. */
export function severityOf(event: SimEvent, config: ViewConfig | null): Severity {
  if (event.signature) return 'chain';
  if (event.type === ENGINE_EVENTS.rejected) return 'reject';
  if (event.type === ENGINE_EVENTS.cleared) return 'market';
  if (config?.alertEventTypes.includes(event.type)) return 'alert';
  return 'normal';
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  chain: 'var(--info)',
  reject: 'var(--down)',
  market: 'var(--up)',
  alert: 'var(--alert)',
  normal: 'var(--text-2)',
};

/** A one-line summary composed only from whatever keys the payload happens to carry. */
export function summarize(event: SimEvent, limit = 4): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(event.data ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    parts.push(`${key} ${typeof value === 'number' ? formatLoose(value) : String(value)}`);
    if (parts.length >= limit) break;
  }
  return parts.join('  ');
}

function formatLoose(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toFixed(2);
}
