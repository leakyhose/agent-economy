'use client';

import { useMemo, useState } from 'react';
import { useSim } from '../store/useSim.ts';
import { ForceGraph } from '../components/ForceGraph.tsx';
import { EntityInspector } from '../components/EntityInspector.tsx';
import { Empty, Panel, StatStrip, type StatSpec } from '../components/Panel.tsx';
import { abbreviate, num } from '../derive/format.ts';

export function WorldView() {
  const state = useSim((s) => s.state);
  const config = useSim((s) => s.config);
  const events = useSim((s) => s.events);
  const selected = useSim((s) => s.selected);
  const select = useSim((s) => s.select);
  const [highlight, setHighlight] = useState<string | null>(null);

  const summary = useMemo(() => {
    if (!state || !config) return null;
    const entities = Object.values(state.entities);
    const byType = new Map<string, number>();
    let ties = 0;
    let circulating = 0;
    let acting = 0;
    const resourceMax: Record<string, number> = {};
    for (const entity of entities) {
      byType.set(entity.type, (byType.get(entity.type) ?? 0) + 1);
      for (const ids of Object.values(entity.relationships)) ties += ids.length;
      if (entity.ownedBy) ties += 1;
      circulating += entity.resources[config.currency] ?? 0;
      if (typeof entity.state['action'] === 'string') acting += 1;
      for (const resource of config.resources) {
        const held = entity.resources[resource.id] ?? 0;
        if (held > (resourceMax[resource.id] ?? 0)) resourceMax[resource.id] = held;
      }
    }
    return { entities, byType, ties, circulating, acting, resourceMax };
  }, [state, config]);

  if (!state || !config || !summary) {
    return <Empty title="Waiting for the first frame" hint="No state has arrived on this channel yet." />;
  }

  const stats: StatSpec[] = [
    {
      id: 'entities',
      label: 'Entities',
      value: num(summary.entities.length),
      foot: <span>{summary.acting} with a live proposal</span>,
    },
    {
      id: 'circulating',
      label: `${config.currency} in circulation`,
      value: abbreviate(summary.circulating),
      foot: <span>unit of account</span>,
    },
    {
      id: 'ties',
      label: 'Ties drawn',
      value: num(summary.ties),
      foot: <span>{config.relations.length} kinds in play</span>,
    },
    ...config.entityTypes.map((type) => ({
      id: `t-${type.id}`,
      label: type.label,
      value: num(summary.byType.get(type.id) ?? 0),
      color: type.color,
      foot: <span>{type.agent ? 'decides' : 'passive'}</span>,
    })),
  ];

  const chosen = selected ? state.entities[selected] : undefined;

  return (
    <>
      <StatStrip stats={stats} />
      <div className="split fill">
        <Panel
          title={config.name}
          note={`tick ${state.tick} · one ${config.tickUnit}`}
          controls={
            highlight ? (
              <button className="chip" onClick={() => setHighlight(null)}>Show all types</button>
            ) : (
              <span className="hint">click a node to inspect</span>
            )
          }
          flush
        >
          <ForceGraph
            state={state}
            config={config}
            selected={selected}
            highlight={highlight}
            onSelect={select}
          />
        </Panel>

        <div style={{ display: 'grid', gap: 'var(--s4)', alignContent: 'start', minHeight: 0 }}>
          <Panel title="Composition" note="sized by holdings">
            <div className="legend">
              {config.entityTypes.map((type) => {
                const count = summary.byType.get(type.id) ?? 0;
                const share = summary.entities.length > 0 ? count / summary.entities.length : 0;
                const on = highlight === type.id;
                return (
                  <button
                    key={type.id}
                    className="legend-row"
                    aria-pressed={on}
                    onClick={() => setHighlight(on ? null : type.id)}
                  >
                    <i className="swatch" style={{ background: type.color }} />
                    <span>{type.label}</span>
                    <span className="bar-track" style={{ width: 54 }}>
                      <span className="bar-fill" style={{ width: `${share * 100}%`, background: type.color }} />
                    </span>
                    <span className="numeric">{count}</span>
                  </button>
                );
              })}
            </div>
            {config.relations.length > 0 ? (
              <div style={{ marginTop: 'var(--s4)' }}>
                <div className="section-label">Edge kinds</div>
                <div className="chip-row">
                  {config.relations.map((relation) => (
                    <span key={relation.kind} className="chip chip-static">
                      <i className="swatch" style={{ background: relation.color }} />
                      {relation.label}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </Panel>

          <Panel title="Selection" note={chosen ? chosen.id : 'nothing selected'}>
            {chosen ? (
              <EntityInspector
                entity={chosen}
                config={config}
                events={events}
                resourceMax={summary.resourceMax}
                onSelect={select}
              />
            ) : (
              <Empty title="Pick an entity" hint="Click a node, or open the roster." />
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
