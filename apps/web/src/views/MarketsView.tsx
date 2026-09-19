'use client';

import type { OrderBook, OrderBookLevel } from '../data/contract.ts';
import { useSim } from '../store/useSim.ts';
import { TimeSeries } from '../components/Chart.tsx';
import { Empty, Panel } from '../components/Panel.tsx';
import type { MarketView } from '../derive/viewConfig.ts';
import { num, percent, price as fmtPrice } from '../derive/format.ts';

function Ladder({ levels, side, peak }: { levels: OrderBookLevel[]; side: 'demand' | 'supply'; peak: number }) {
  return (
    <div className="ladder" data-side={side}>
      {levels.map((level, index) => {
        const depth = peak > 0 ? Math.min(100, (level.quantity / peak) * 100) : 0;
        const price = <span className="ladder-price numeric">{fmtPrice(level.price)}</span>;
        const quantity = <span className="ladder-qty numeric">{num(level.quantity)}</span>;
        return (
          <div className="ladder-row" key={`${level.price}-${index}`}>
            <span className="ladder-depth" style={{ width: `${depth}%` }} />
            {side === 'demand' ? quantity : price}
            {side === 'demand' ? price : quantity}
          </div>
        );
      })}
    </div>
  );
}

function MarketPanel({ market, book, ticks, values }: {
  market: MarketView;
  book: OrderBook | undefined;
  ticks: number[];
  values: number[];
}) {
  const last = book?.lastPrice ?? values[values.length - 1] ?? 0;
  const previous = book?.previousPrice ?? values[values.length - 2] ?? last;
  const change = previous > 0 ? (last - previous) / previous : 0;
  const tone = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const peak = Math.max(
    1,
    ...(book?.demand ?? []).map((l) => l.quantity),
    ...(book?.supply ?? []).map((l) => l.quantity),
  );

  return (
    <Panel
      title={market.label}
      note={`${market.mechanism.replace('_', ' ')} · clears every ${market.roundTicks}`}
      controls={
        <span className="readout">
          <span className="readout-value">{fmtPrice(last)}</span>
          <span className="readout-unit">{market.currency}</span>
          <span className={tone} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-xs)' }}>
            {percent(change)}
          </span>
        </span>
      }
    >
      <TimeSeries
        ticks={ticks}
        series={[{ id: market.id, label: market.resource, color: market.color, values }]}
        height={132}
        format={(v) => fmtPrice(v)}
        showArea
      />
      {book ? (
        <div className="book">
          <div className="book-head">
            <span>Demand</span>
            <span className="numeric">{num(book.volume)} cleared</span>
            <span style={{ textAlign: 'right' }}>Supply</span>
          </div>
          <div className="book-body">
            <Ladder levels={book.demand} side="demand" peak={peak} />
            <Ladder levels={book.supply} side="supply" peak={peak} />
          </div>
        </div>
      ) : (
        <div className="hint" style={{ paddingTop: 'var(--s3)' }}>
          This channel carries no resting interest.
        </div>
      )}
    </Panel>
  );
}

export function MarketsView() {
  const config = useSim((s) => s.config);
  const books = useSim((s) => s.books);
  const series = useSim((s) => s.priceSeries);

  if (!config) return <Empty title="No world loaded" />;
  if (config.markets.length === 0) {
    return <Empty title="This world declares no markets" hint="Nothing clears, so nothing is priced." />;
  }

  return (
    <div className="grid-2">
      {config.markets.map((market) => (
        <MarketPanel
          key={market.id}
          market={market}
          book={books[market.id]}
          ticks={series.ticks}
          values={series.values[market.id] ?? []}
        />
      ))}
    </div>
  );
}
