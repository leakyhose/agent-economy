'use client';

import { useSim } from '../store/useSim.ts';
import { TimeSeries } from '../components/Chart.tsx';
import { Empty, Panel } from '../components/Panel.tsx';
import { formatMetric, metricDomain } from '../derive/metrics.ts';
import { humanize, percent } from '../derive/format.ts';

export function AnalyticsView() {
  const config = useSim((s) => s.config);
  const series = useSim((s) => s.metricSeries);
  const metrics = useSim((s) => s.metrics);

  if (!config) return <Empty title="No world loaded" />;
  if (config.metrics.length === 0) {
    return <Empty title="This world declares no metrics" hint="Add a metrics array to its definition." />;
  }

  return (
    <div className="grid-2">
      {config.metrics.map((metric) => {
        const values = series.values[metric.id] ?? [];
        const format = formatMetric(metric.kind);
        const current = metrics[metric.id] ?? values[values.length - 1] ?? 0;
        const first = values[0] ?? current;
        const drift = first !== 0 ? (current - first) / Math.abs(first) : 0;
        return (
          <Panel
            key={metric.id}
            title={metric.label}
            note={`${metric.aggregate}${metric.over ? ` over ${humanize(metric.over).toLowerCase()}` : ''}`}
            controls={
              <span className="readout">
                <span className="readout-value">{format(current)}</span>
                <span
                  className={drift > 0 ? 'up' : drift < 0 ? 'down' : 'flat'}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-xs)' }}
                >
                  {values.length > 1 ? percent(drift) : ''}
                </span>
              </span>
            }
          >
            <TimeSeries
              ticks={series.ticks}
              series={[{ id: metric.id, label: metric.label, color: metric.color, values }]}
              height={148}
              format={format}
              domain={metricDomain(metric.kind)}
              showArea
            />
          </Panel>
        );
      })}
    </div>
  );
}
