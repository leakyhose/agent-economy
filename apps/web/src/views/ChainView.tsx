'use client';

import { useMemo } from 'react';
import { useSampled, useSim } from '../store/useSim.ts';
import { Empty, Panel, StatStrip, type StatSpec } from '../components/Panel.tsx';
import { explorerTx, EXPLORER_CLUSTER } from '../derive/chain.ts';
import { abbreviate, num, padTick, truncateMiddle } from '../derive/format.ts';

export function ChainView() {
  const events = useSampled((s) => s.events, 400);
  const config = useSim((s) => s.config);
  const select = useSim((s) => s.select);
  const setView = useSim((s) => s.setView);

  const settled = useMemo(() => events.filter((e) => typeof e.signature === 'string'), [events]);

  const totals = useMemo(() => {
    const byAsset = new Map<string, { count: number; amount: number }>();
    for (const event of settled) {
      const asset = String(event.data?.['asset'] ?? 'unknown');
      const amount = Number(event.data?.['amount'] ?? 0);
      const prior = byAsset.get(asset) ?? { count: 0, amount: 0 };
      byAsset.set(asset, { count: prior.count + 1, amount: prior.amount + (Number.isFinite(amount) ? amount : 0) });
    }
    return byAsset;
  }, [settled]);

  if (!config) return <Empty title="No world loaded" />;

  const stats: StatSpec[] = [
    { id: 'count', label: 'Confirmed transactions', value: num(settled.length), foot: <span>cluster {EXPLORER_CLUSTER}</span> },
    {
      id: 'assets',
      label: 'Assets on chain',
      value: num(config.onChainResources.length),
      foot: <span>of {config.resources.length} in this world</span>,
    },
    ...Array.from(totals.entries()).slice(0, 4).map(([asset, value]) => ({
      id: `a-${asset}`,
      label: `${asset} settled`,
      value: abbreviate(value.amount),
      color: config.resourceById[asset]?.color,
      foot: <span>{value.count} transfers</span>,
    })),
  ];

  return (
    <>
      <StatStrip stats={stats} />

      <Panel title="Settlement policy" note="read from the resource table">
        <div className="chip-row">
          {config.resources.map((resource) => (
            <span
              key={resource.id}
              className="chip chip-static"
              style={resource.onChain ? { borderColor: 'var(--line-2)' } : { opacity: 0.45 }}
            >
              <i className="swatch" style={{ background: resource.onChain ? resource.color : 'var(--text-3)' }} />
              {resource.label}
              <b style={{ color: resource.onChain ? 'var(--info)' : 'var(--text-3)', fontWeight: 400 }}>
                {resource.onChain ? 'on chain' : 'off chain'}
              </b>
            </span>
          ))}
        </div>
      </Panel>

      <Panel title="Settled transfers" note={`${settled.length} with a signature`} flush
        style={{ minHeight: 'clamp(320px, 48vh, 700px)' }}>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="num">Tick</th>
                <th>Asset</th>
                <th>From</th>
                <th>To</th>
                <th className="num">Amount</th>
                <th>Signature</th>
              </tr>
            </thead>
            <tbody>
              {settled.slice(-300).reverse().map((event) => {
                const asset = String(event.data?.['asset'] ?? '—');
                const from = String(event.data?.['from'] ?? '—');
                const to = String(event.data?.['to'] ?? '—');
                const amount = Number(event.data?.['amount'] ?? 0);
                return (
                  <tr key={event.key} onClick={() => { select(from); setView('agents'); }}>
                    <td className="num dim">{padTick(event.tick)}</td>
                    <td>
                      <i className="swatch" style={{ background: config.resourceById[asset]?.color ?? 'var(--text-2)' }} />
                      {asset}
                    </td>
                    <td className="id-cell">{from}</td>
                    <td className="id-cell">{to}</td>
                    <td className="num">{abbreviate(amount)}</td>
                    <td className="sig">
                      <a
                        className="link"
                        href={explorerTx(event.signature ?? '')}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {truncateMiddle(event.signature ?? '', 8, 8)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {settled.length === 0 ? (
            <Empty
              title="No settlement yet"
              hint="Transfers appear here once a signature confirms."
            />
          ) : null}
        </div>
      </Panel>
    </>
  );
}
