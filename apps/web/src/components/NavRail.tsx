'use client';

import { useSim, type ViewId } from '../store/useSim.ts';
import { num } from '../derive/format.ts';

export function NavRail() {
  const view = useSim((s) => s.view);
  const setView = useSim((s) => s.setView);
  const config = useSim((s) => s.config);
  const entityCount = useSim((s) => (s.state ? Object.keys(s.state.entities).length : 0));
  const eventCount = useSim((s) => s.events.length);
  const settledCount = useSim((s) => s.events.reduce((a, e) => a + (e.signature ? 1 : 0), 0));

  const items: Array<{ id: ViewId; label: string; count: number }> = [
    { id: 'world', label: 'World', count: entityCount },
    { id: 'agents', label: 'Agents', count: entityCount },
    { id: 'markets', label: 'Markets', count: config?.markets.length ?? 0 },
    { id: 'events', label: 'Events', count: eventCount },
    { id: 'chain', label: 'Chain', count: settledCount },
    { id: 'analytics', label: 'Analytics', count: config?.metrics.length ?? 0 },
  ];

  return (
    <nav className="rail" aria-label="Views">
      {items.map((item, index) => (
        <button
          key={item.id}
          className="rail-item"
          aria-current={view === item.id}
          onClick={() => setView(item.id)}
          title={`${item.label} — press ${index + 1}`}
        >
          <span>{item.label}</span>
          <span className="rail-count">{num(item.count)}</span>
        </button>
      ))}

      <div className="rail-foot">
        <div className="rail-meta"><span>seed</span><span>{config?.seed ?? '—'}</span></div>
        <div className="rail-meta"><span>tick</span><span>{config?.tickMs ?? 0}ms</span></div>
        <div className="rail-meta"><span>types</span><span>{config?.entityTypes.length ?? 0}</span></div>
        <div className="rail-meta"><span>actions</span><span>{config?.actions.length ?? 0}</span></div>
        <div className="rail-meta"><span>rules</span><span>{config?.ruleCount ?? 0}</span></div>
        <div className="rail-meta"><span>signals</span><span>{config?.eventTypes.length ?? 0}</span></div>
      </div>
    </nav>
  );
}
