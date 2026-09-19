import { abbreviate, num, ratio } from './format.ts';
import type { MetricKind } from './viewConfig.ts';

export function formatMetric(kind: MetricKind): (value: number) => string {
  switch (kind) {
    case 'count':
      return (v) => num(Math.round(v), 0);
    case 'index':
      return ratio;
    case 'currency':
      return abbreviate;
    default:
      return (v) => num(v, Math.abs(v) >= 100 ? 0 : 2);
  }
}

export function metricDomain(kind: MetricKind): [number, number] | undefined {
  return kind === 'index' ? [0, 1] : undefined;
}
