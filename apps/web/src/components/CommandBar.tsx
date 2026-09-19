'use client';

import { useSim } from '../store/useSim.ts';
import { Pause, Play, Rewind, Step } from './Icons.tsx';
import { padTick } from '../derive/format.ts';

const SPEEDS = [0.5, 1, 2, 4, 8];
const SCALES = [1, 4, 12];

export function CommandBar() {
  const manifest = useSim((s) => s.manifest);
  const activeSlug = useSim((s) => s.activeSlug);
  const selectWorld = useSim((s) => s.selectWorld);
  const config = useSim((s) => s.config);
  const tick = useSim((s) => s.state?.tick ?? 0);
  const running = useSim((s) => s.running);
  const control = useSim((s) => s.control);
  const speed = useSim((s) => s.speed);
  const setSpeed = useSim((s) => s.setSpeed);
  const scale = useSim((s) => s.scale);
  const setScale = useSim((s) => s.setScale);
  const sourceKind = useSim((s) => s.sourceKind);
  const setSourceKind = useSim((s) => s.setSourceKind);
  const status = useSim((s) => s.status);
  const statusDetail = useSim((s) => s.statusDetail);

  return (
    <header className="bar">
      <div className="brand">
        <span className="brand-mark">Agentic World</span>
        <span className="brand-sub">observation console</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="world-select">World</label>
        <select
          id="world-select"
          className="control"
          value={activeSlug ?? ''}
          onChange={(event) => void selectWorld(event.target.value)}
        >
          {manifest.map((entry) => (
            <option key={entry.slug} value={entry.slug}>{entry.name}</option>
          ))}
        </select>
      </div>

      <div className="bar-group">
        <div className="btn-group">
          <button
            className="btn"
            aria-pressed={running}
            onClick={() => control(running ? 'pause' : 'start')}
            title={running ? 'Pause the clock' : 'Run the clock'}
          >
            {running ? <Pause /> : <Play />}
            {running ? 'Pause' : 'Run'}
          </button>
          <button className="btn" onClick={() => control('step')} title="Advance one tick">
            <Step />
            Step
          </button>
          <button className="btn" onClick={() => control('reset')} title="Return to tick zero">
            <Rewind />
            Reset
          </button>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="speed-select">Speed</label>
          <select
            id="speed-select"
            className="control"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>{value}x</option>
            ))}
          </select>
        </div>
      </div>

      <div className="bar-spacer" />

      <div className="bar-group">
        <div className="btn-group">
          <button
            className="btn"
            aria-pressed={sourceKind === 'fixture'}
            onClick={() => void setSourceKind('fixture')}
            title="Replay a generated run"
          >
            Fixture
          </button>
          <button
            className="btn"
            aria-pressed={sourceKind === 'live'}
            onClick={() => void setSourceKind('live')}
            title="Connect to the simulation server"
          >
            Live
          </button>
        </div>

        {sourceKind === 'fixture' ? (
          <div className="field">
            <label className="field-label" htmlFor="scale-select">Population</label>
            <select
              id="scale-select"
              className="control"
              value={scale}
              onChange={(event) => setScale(Number(event.target.value))}
            >
              {SCALES.map((value) => (
                <option key={value} value={value}>{value}x</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="readout">
        <span className="readout-unit">t</span>
        <span className="readout-value">{padTick(tick)}</span>
        <span className="readout-unit">{config?.tickUnit ?? 'tick'}s elapsed</span>
      </div>

      <div className="status" data-status={status} title={statusDetail}>
        <span className={`status-dot${status === 'connecting' ? ' pulse' : ''}`} />
        {sourceKind === 'fixture' ? 'fixture replay' : status}
      </div>
    </header>
  );
}
