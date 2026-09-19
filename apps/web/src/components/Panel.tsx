'use client';

import type { CSSProperties, ReactNode } from 'react';

interface PanelProps {
  title: string;
  note?: ReactNode;
  controls?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
}

export function Panel({ title, note, controls, flush, children, style, bodyStyle }: PanelProps) {
  return (
    <section className="panel" style={style}>
      <header className="panel-head">
        <h2 className="panel-title">{title}</h2>
        {note ? <span className="panel-note">{note}</span> : null}
        {controls ? <div className="panel-controls">{controls}</div> : null}
      </header>
      <div className={flush ? 'panel-body flush' : 'panel-body'} style={bodyStyle}>
        {children}
      </div>
    </section>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}

export interface StatSpec {
  id: string;
  label: string;
  value: string;
  foot?: ReactNode;
  color?: string;
}

export function StatStrip({ stats }: { stats: StatSpec[] }) {
  return (
    <div className="strip">
      {stats.map((stat) => (
        <div className="stat" key={stat.id}>
          <span className="stat-label">{stat.label}</span>
          <span className="stat-value" style={stat.color ? { color: stat.color } : undefined}>
            {stat.value}
          </span>
          {stat.foot ? <span className="stat-foot">{stat.foot}</span> : <span className="stat-foot">&nbsp;</span>}
        </div>
      ))}
    </div>
  );
}
