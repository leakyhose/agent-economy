'use client';

import { useMemo, useRef, useState } from 'react';
import { withAlpha } from '../derive/palette.ts';

export interface SeriesSpec {
  id: string;
  label: string;
  color: string;
  values: number[];
}

interface TimeSeriesProps {
  ticks: number[];
  series: SeriesSpec[];
  height?: number;
  format?: (value: number) => string;
  /** Pin the vertical extent, e.g. for a 0..1 index. */
  domain?: [number, number];
  showArea?: boolean;
}

const PAD = { top: 10, right: 54, bottom: 16, left: 8 };

export function TimeSeries({
  ticks,
  series,
  height = 150,
  format = (v) => v.toFixed(2),
  domain,
  showArea = false,
}: TimeSeriesProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [cursor, setCursor] = useState<number | null>(null);

  const measure = (node: HTMLDivElement | null): void => {
    if (!node) return;
    hostRef.current = node;
    const next = node.clientWidth;
    if (next > 0 && Math.abs(next - width) > 2) setWidth(next);
  };

  const { min, max } = useMemo(() => {
    if (domain) return { min: domain[0], max: domain[1] };
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (const v of s.values) {
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1 };
    if (lo === hi) return { min: lo - 1, max: hi + 1 };
    const pad = (hi - lo) * 0.12;
    return { min: lo - pad, max: hi + pad };
  }, [series, domain]);

  const count = ticks.length;
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const xAt = (i: number): number => PAD.left + (count <= 1 ? plotW : (i / (count - 1)) * plotW);
  const yAt = (v: number): number => PAD.top + plotH - ((v - min) / (max - min || 1)) * plotH;

  const gridLines = [0, 0.5, 1].map((f) => ({ f, value: max - f * (max - min) }));

  const onMove = (event: React.MouseEvent<SVGRectElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / (rect.width || 1);
    setCursor(Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))));
  };

  const active = cursor ?? count - 1;

  return (
    <div ref={measure} style={{ width: '100%' }}>
      <svg width={width} height={height} role="img" aria-label="time series">
        {gridLines.map((line) => (
          <g key={line.f}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={PAD.top + line.f * plotH}
              y2={PAD.top + line.f * plotH}
              stroke="var(--line)"
              strokeDasharray={line.f === 1 ? undefined : '2 4'}
            />
            <text
              x={PAD.left + plotW + 6}
              y={PAD.top + line.f * plotH + 3}
              fill="var(--text-3)"
              fontSize={9}
              fontFamily="var(--font-mono)"
            >
              {format(line.value)}
            </text>
          </g>
        ))}

        {series.map((s) => {
          if (s.values.length === 0) return null;
          const points = s.values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
          const lastIndex = s.values.length - 1;
          const lastValue = s.values[lastIndex] ?? 0;
          return (
            <g key={s.id}>
              {showArea && series.length === 1 ? (
                <polygon
                  points={`${PAD.left},${PAD.top + plotH} ${points} ${xAt(lastIndex)},${PAD.top + plotH}`}
                  fill={withAlpha(s.color, 0.1)}
                />
              ) : null}
              <polyline points={points} fill="none" stroke={s.color} strokeWidth={1.25} />
              <circle cx={xAt(lastIndex)} cy={yAt(lastValue)} r={2} fill={s.color} />
            </g>
          );
        })}

        {cursor !== null && count > 1 ? (
          <line
            x1={xAt(active)}
            x2={xAt(active)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke="var(--brass)"
            strokeWidth={0.75}
            opacity={0.7}
          />
        ) : null}

        <rect
          x={PAD.left}
          y={PAD.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setCursor(null)}
        />
      </svg>

      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.id} className="chart-legend-item">
            <i className="swatch" style={{ background: s.color }} />
            {s.label}
            <b className="mono">{format(s.values[active] ?? s.values[s.values.length - 1] ?? 0)}</b>
          </span>
        ))}
        <span className="chart-legend-tick mono">
          {cursor !== null && ticks[active] !== undefined ? `t${ticks[active]}` : ''}
        </span>
      </div>
    </div>
  );
}

interface SparklineProps {
  values: number[];
  color: string;
  width?: number;
  height?: number;
}

export function Sparkline({ values, color, width = 78, height = 18 }: SparklineProps) {
  if (values.length < 2) return <svg width={width} height={height} />;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - ((v - lo) / span) * (height - 2) - 1).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1} />
    </svg>
  );
}
