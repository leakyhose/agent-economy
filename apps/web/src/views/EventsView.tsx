'use client';

import { useMemo } from 'react';
import { useSampled, useSim } from '../store/useSim.ts';
import { Empty, Panel } from '../components/Panel.tsx';
import { severityOf, SEVERITY_COLOR, summarize } from '../derive/events.ts';
import { humanize, num, padTick, truncateMiddle } from '../derive/format.ts';

export function EventsView() {
  const events = useSampled((s) => s.events, 250);
  const config = useSim((s) => s.config);
  const filter = useSim((s) => s.eventFilter);
  const toggle = useSim((s) => s.toggleEventFilter);
  const clear = useSim((s) => s.clearEventFilter);
  const select = useSim((s) => s.select);
  const setView = useSim((s) => s.setView);

  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const event of events) tally.set(event.type, (tally.get(event.type) ?? 0) + 1);
    return tally;
  }, [events]);

  const visible = useMemo(() => {
    const filtered = filter.length === 0 ? events : events.filter((e) => filter.includes(e.type));
    return filtered.slice(-400).reverse();
  }, [events, filter]);

  if (!config) return <Empty title="No world loaded" />;

  const known = Array.from(new Set([...config.eventTypes, ...counts.keys()])).sort();

  return (
    <>
      <Panel
        title="Channels"
        note={`${num(events.length)} retained · ${known.length} kinds`}
        controls={filter.length > 0 ? <button className="chip" onClick={clear}>Clear filter</button> : null}
      >
        <div className="chip-row">
          {known.map((type) => {
            const count = counts.get(type) ?? 0;
            const on = filter.includes(type);
            return (
              <button key={type} className="chip" aria-pressed={on} onClick={() => toggle(type)}>
                <i
                  className="swatch"
                  style={{
                    background: SEVERITY_COLOR[
                      severityOf({ seq: 0, tick: 0, type, data: {} }, config)
                    ],
                  }}
                />
                {humanize(type)}
                <b style={{ color: 'var(--text-3)', fontWeight: 400 }}>{count}</b>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel
        title="Stream"
        note={filter.length > 0 ? `${visible.length} matching, newest first` : 'newest first'}
        flush
        style={{ minHeight: 'clamp(380px, 58vh, 820px)' }}
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="num">Tick</th>
                <th className="num">Seq</th>
                <th>Event</th>
                <th>Payload</th>
                <th>Signature</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((event) => {
                const severity = severityOf(event, config);
                const actor = event.data?.['actor'];
                return (
                  <tr
                    key={event.seq}
                    onClick={() => {
                      if (typeof actor === 'string') {
                        select(actor);
                        setView('agents');
                      }
                    }}
                  >
                    <td className="num dim">{padTick(event.tick)}</td>
                    <td className="num dim">{event.seq}</td>
                    <td style={{ color: SEVERITY_COLOR[severity] }}>
                      <i className="swatch" style={{ background: SEVERITY_COLOR[severity] }} />
                      {humanize(event.type)}
                    </td>
                    <td className="mono" style={{ color: 'var(--text-2)', fontSize: 'var(--t-xs)' }}>
                      {summarize(event, 5)}
                    </td>
                    <td className="sig">
                      {event.signature ? truncateMiddle(event.signature, 6, 6) : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length === 0 ? (
            <Empty title="Nothing on this filter" hint="Clear it, or wait for the next tick." />
          ) : null}
        </div>
      </Panel>
    </>
  );
}
