'use client';

import { useEffect } from 'react';
import { useSim, type ViewId } from '../store/useSim.ts';
import { CommandBar } from './CommandBar.tsx';
import { NavRail } from './NavRail.tsx';
import { Tape } from './Tape.tsx';
import { Empty } from './Panel.tsx';
import { WorldView } from '../views/WorldView.tsx';
import { AgentsView } from '../views/AgentsView.tsx';
import { MarketsView } from '../views/MarketsView.tsx';
import { EventsView } from '../views/EventsView.tsx';
import { ChainView } from '../views/ChainView.tsx';
import { AnalyticsView } from '../views/AnalyticsView.tsx';

const ORDER: ViewId[] = ['world', 'agents', 'markets', 'events', 'chain', 'analytics'];

let booted = false;

export function Dashboard() {
  const view = useSim((s) => s.view);
  const setView = useSim((s) => s.setView);
  const boot = useSim((s) => s.boot);
  const control = useSim((s) => s.control);
  const running = useSim((s) => s.running);
  const ready = useSim((s) => s.ready);
  const error = useSim((s) => s.error);

  useEffect(() => {
    if (booted) return;
    booted = true;
    void boot();
  }, [boot]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === ' ') {
        event.preventDefault();
        control(running ? 'pause' : 'start');
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        control('step');
        return;
      }
      const index = Number(event.key);
      if (Number.isInteger(index) && index >= 1 && index <= ORDER.length) {
        const next = ORDER[index - 1];
        if (next) setView(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [control, running, setView]);

  if (error) {
    return (
      <div className="boot">
        <strong style={{ color: 'var(--down)' }}>The console could not start</strong>
        <span>{error}</span>
        <span className="hint">Run npm run sync:worlds, then reload.</span>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="boot">
        <span className="pulse">reading world definitions</span>
      </div>
    );
  }

  return (
    <div className="shell">
      <CommandBar />
      <div className="shell-body">
        <NavRail />
        <main className="stage">
          <div className={view === 'world' ? 'stage-inner fill' : 'stage-inner'}>
            {view === 'world' ? <WorldView /> : null}
            {view === 'agents' ? <AgentsView /> : null}
            {view === 'markets' ? <MarketsView /> : null}
            {view === 'events' ? <EventsView /> : null}
            {view === 'chain' ? <ChainView /> : null}
            {view === 'analytics' ? <AnalyticsView /> : null}
            {!ORDER.includes(view) ? <Empty title="Unknown view" /> : null}
          </div>
        </main>
      </div>
      <Tape />
    </div>
  );
}
