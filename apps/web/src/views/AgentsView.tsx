'use client';

import { useMemo, useState } from 'react';
import type { Entity } from '@aw/types';
import { useSampled, useSim } from '../store/useSim.ts';
import { EntityInspector } from '../components/EntityInspector.tsx';
import { Empty, Panel } from '../components/Panel.tsx';
import { abbreviate, humanize } from '../derive/format.ts';

type Direction = 'asc' | 'desc';

export function AgentsView() {
  const state = useSampled((s) => s.state, 350);
  const config = useSim((s) => s.config);
  const events = useSampled((s) => s.events, 600);
  const selected = useSim((s) => s.selected);
  const select = useSim((s) => s.select);

  const [sortKey, setSortKey] = useState<string>('id');
  const [direction, setDirection] = useState<Direction>('asc');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const columns = useMemo(() => config?.resources.slice(0, 6) ?? [], [config]);

  const { rows, resourceMax, total } = useMemo(() => {
    const entities: Entity[] = state ? Object.values(state.entities) : [];
    const max: Record<string, number> = {};
    for (const entity of entities) {
      for (const [id, held] of Object.entries(entity.resources)) {
        if (held > (max[id] ?? 0)) max[id] = held;
      }
    }
    const needle = query.trim().toLowerCase();
    let filtered = entities;
    if (typeFilter) filtered = filtered.filter((e) => e.type === typeFilter);
    if (needle) {
      filtered = filtered.filter((entity) => {
        const action = String(entity.state['action'] ?? '');
        const reason = String(entity.state['reason'] ?? '');
        return (
          entity.id.toLowerCase().includes(needle) ||
          entity.type.toLowerCase().includes(needle) ||
          action.toLowerCase().includes(needle) ||
          reason.toLowerCase().includes(needle)
        );
      });
    }

    const factor = direction === 'asc' ? 1 : -1;
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === 'id') return factor * a.id.localeCompare(b.id);
      if (sortKey === 'type') return factor * (a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
      if (sortKey === 'action') {
        return factor * String(a.state['action'] ?? '').localeCompare(String(b.state['action'] ?? ''));
      }
      const av = a.resources[sortKey] ?? 0;
      const bv = b.resources[sortKey] ?? 0;
      return factor * (av - bv || a.id.localeCompare(b.id));
    });

    return { rows: sorted, resourceMax: max, total: entities.length };
  }, [state, query, typeFilter, sortKey, direction]);

  if (!state || !config) {
    return <Empty title="No roster yet" hint="The channel has not delivered a state frame." />;
  }

  const sortBy = (key: string): void => {
    if (key === sortKey) setDirection(direction === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setDirection(key === 'id' || key === 'type' || key === 'action' ? 'asc' : 'desc');
    }
  };

  const heading = (key: string, label: string, numeric = false) => (
    <th
      key={key}
      className={`sortable${numeric ? ' num' : ''}`}
      aria-sort={sortKey === key ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
      onClick={() => sortBy(key)}
    >
      {label}
      {sortKey === key ? <span className="caret">{direction === 'asc' ? '↑' : '↓'}</span> : null}
    </th>
  );

  const chosen = selected ? state.entities[selected] : undefined;
  const capped = rows.slice(0, 250);

  return (
    <div className="split" style={{ minHeight: 'clamp(460px, 70vh, 900px)' }}>
      <Panel
        title="Roster"
        note={`${rows.length} of ${total}`}
        controls={
          <>
            {config.entityTypes.map((type) => (
              <button
                key={type.id}
                className="chip"
                aria-pressed={typeFilter === type.id}
                onClick={() => setTypeFilter(typeFilter === type.id ? null : type.id)}
              >
                <i className="swatch" style={{ background: type.color }} />
                {type.label}
              </button>
            ))}
            <input
              className="control"
              style={{ backgroundImage: 'none', paddingRight: 8, width: 150 }}
              placeholder="Filter rows"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </>
        }
        flush
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {heading('id', 'Entity')}
                {heading('type', 'Type')}
                {columns.map((resource) => heading(resource.id, resource.label, true))}
                {heading('action', 'Doing')}
                <th>Stated reason</th>
              </tr>
            </thead>
            <tbody>
              {capped.map((entity) => {
                const type = config.entityTypeById[entity.type];
                const action = entity.state['action'];
                const reason = entity.state['reason'];
                return (
                  <tr
                    key={entity.id}
                    aria-selected={entity.id === selected}
                    onClick={() => select(entity.id)}
                  >
                    <td className="id-cell">{entity.id}</td>
                    <td>
                      <i className="swatch" style={{ background: type?.color ?? 'var(--text-2)' }} />
                      {type?.label ?? humanize(entity.type)}
                    </td>
                    {columns.map((resource) => {
                      const held = entity.resources[resource.id] ?? 0;
                      return (
                        <td className="num" key={resource.id} style={held === 0 ? { color: 'var(--text-3)' } : undefined}>
                          {abbreviate(held)}
                        </td>
                      );
                    })}
                    <td style={{ color: 'var(--text-0)' }}>
                      {typeof action === 'string' ? humanize(action) : '—'}
                    </td>
                    <td className="reason" title={typeof reason === 'string' ? reason : undefined}>
                      {typeof reason === 'string' ? reason : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > capped.length ? (
            <div className="hint" style={{ padding: 'var(--s3) var(--s4)' }}>
              {rows.length - capped.length} further rows match. Narrow the filter to reach them.
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Detail" note={chosen ? chosen.id : 'no row selected'}>
        {chosen ? (
          <EntityInspector
            entity={chosen}
            config={config}
            events={events}
            resourceMax={resourceMax}
            onSelect={select}
          />
        ) : (
          <Empty title="Select a row" hint="Every entity carries its own record." />
        )}
      </Panel>
    </div>
  );
}
