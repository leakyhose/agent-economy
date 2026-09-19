'use client';

import type { Entity, Json, SimEvent } from '@aw/types';
import type { ViewConfig } from '../derive/viewConfig.ts';
import { explorerAddress, walletOf } from '../derive/chain.ts';
import { severityOf, SEVERITY_COLOR } from '../derive/events.ts';
import { abbreviate, humanize, num, truncateMiddle } from '../derive/format.ts';

interface Props {
  entity: Entity;
  config: ViewConfig;
  events: SimEvent[];
  resourceMax: Record<string, number>;
  onSelect: (id: string) => void;
}

function readable(value: Json): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return num(value, Number.isInteger(value) ? 0 : 2);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return `${value.length} entries`;
  if (typeof value === 'object') return 'object';
  return String(value);
}

export function EntityInspector({ entity, config, events, resourceMax, onSelect }: Props) {
  const type = config.entityTypeById[entity.type];
  const color = type?.color ?? 'var(--text-1)';
  const wallet = walletOf(entity);
  const action = entity.state['action'];
  const reason = entity.state['reason'];
  const until = entity.state['until'];

  const related = events
    .filter((event) => Object.values(event.data ?? {}).includes(entity.id))
    .slice(-8)
    .reverse();

  const relationEntries = Object.entries(entity.relationships).filter(([, ids]) => ids.length > 0);

  return (
    <div className="inspector">
      <div>
        <div className="inspect-id">
          <i className="swatch" style={{ background: color }} />
          <span className="mono">{entity.id}</span>
          <span className="tag">{type?.label ?? humanize(entity.type)}</span>
        </div>
        <a className="link sig" href={explorerAddress(wallet)} target="_blank" rel="noreferrer">
          {truncateMiddle(wallet, 8, 8)}
        </a>
      </div>

      <div>
        <div className="section-label">Doing now</div>
        {typeof action === 'string' ? (
          <>
            <div className="inspect-action">{humanize(action)}</div>
            {typeof reason === 'string' ? <p className="inspect-reason">{reason}</p> : null}
            {typeof until === 'number' ? (
              <div className="hint">occupied until t{until}</div>
            ) : null}
          </>
        ) : (
          <div className="dim">No proposal on record.</div>
        )}
      </div>

      <div>
        <div className="section-label">Holdings</div>
        {config.resources.map((resource) => {
          const held = entity.resources[resource.id] ?? 0;
          const ceiling = resourceMax[resource.id] ?? 1;
          const share = ceiling > 0 ? Math.min(1, held / ceiling) : 0;
          return (
            <div className="bar-row" key={resource.id}>
              <span className="dim" title={resource.label}>{resource.label}</span>
              <span className="bar-track">
                <span
                  className="bar-fill"
                  style={{ width: `${(share * 100).toFixed(1)}%`, background: resource.color }}
                />
              </span>
              <span className="numeric">{abbreviate(held)}</span>
            </div>
          );
        })}
      </div>

      {Object.keys(entity.attributes).length > 0 ? (
        <div>
          <div className="section-label">Attributes</div>
          <dl className="kv">
            {Object.entries(entity.attributes).map(([key, value]) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt>{humanize(key)}</dt>
                <dd>{readable(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {relationEntries.length > 0 || entity.owns.length > 0 || entity.ownedBy ? (
        <div>
          <div className="section-label">Ties</div>
          {relationEntries.map(([kind, ids]) => (
            <div className="tie-row" key={kind}>
              <span className="dim">{humanize(kind)}</span>
              <span className="chip-row">
                {ids.slice(0, 6).map((id) => (
                  <button key={id} className="chip" onClick={() => onSelect(id)}>{id}</button>
                ))}
              </span>
            </div>
          ))}
          {entity.ownedBy ? (
            <div className="tie-row">
              <span className="dim">Held by</span>
              <span className="chip-row">
                <button className="chip" onClick={() => onSelect(entity.ownedBy ?? '')}>{entity.ownedBy}</button>
              </span>
            </div>
          ) : null}
          {entity.owns.length > 0 ? (
            <div className="tie-row">
              <span className="dim">Owns</span>
              <span className="chip-row">
                {entity.owns.slice(0, 6).map((id) => (
                  <button key={id} className="chip" onClick={() => onSelect(id)}>{id}</button>
                ))}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div>
        <div className="section-label">Recent record</div>
        {related.length === 0 ? (
          <div className="dim">Nothing yet at this tick depth.</div>
        ) : (
          <ul className="mini-log">
            {related.map((event) => (
              <li key={event.seq}>
                <span className="mono dim">t{event.tick}</span>
                <span style={{ color: SEVERITY_COLOR[severityOf(event, config)] }}>
                  {humanize(event.type)}
                </span>
                {event.signature ? <span className="tag">settled</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
