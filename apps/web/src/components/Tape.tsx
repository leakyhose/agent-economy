'use client';

import { useSampled, useSim } from '../store/useSim.ts';
import { severityOf, summarize } from '../derive/events.ts';
import { humanize } from '../derive/format.ts';

export function Tape() {
  const events = useSampled((s) => s.events.slice(-22), 220);
  const config = useSim((s) => s.config);

  const items = [...events].reverse();

  return (
    <div className="tape" aria-label="Event tape" aria-live="off">
      <span className="tape-label">tape</span>
      <div className="tape-track">
        {items.map((event, index) => (
          <span
            key={event.seq}
            className={index === 0 ? 'tape-item tape-new' : 'tape-item'}
            data-severity={severityOf(event, config)}
          >
            <span className="t">t{event.tick}</span>
            <span>{humanize(event.type)}</span>
            <span className="t">{summarize(event, 2)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
