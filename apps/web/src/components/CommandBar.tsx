'use client';

import { useSim } from '../store/useSim.ts';
import { Pause, Play, Rewind, Step } from './Icons.tsx';
import { padTick } from '../derive/format.ts';

const SPEEDS = [0.5, 1, 2, 4, 8];
const SCALES = [1, 4, 12];
/** Round sizes spanning the ledger's 2..320 range, without a free-text box. */
const HEADCOUNTS = [10, 24, 50, 100, 150, 200, 320];

/** What a run would cost per hour, very roughly: a model-backed agent decides a
 *  few times a minute on a prompt of a few hundred tokens. Shown before a run
 *  starts, so nobody launches 320 agents on the dear model blind. Once the run
 *  is under way the metered figure replaces it. */
function costPerHour(price: [number, number] | undefined, agents: number): string | null {
  if (!price || agents <= 0) return null;
  const decisionsPerHour = agents * 0.5 * 60;     // ~half the population, twice a minute
  const usd = decisionsPerHour * (450 / 1e6 * price[0] + 60 / 1e6 * price[1]);
  if (usd < 0.01) return '<$0.01/hr';
  return usd < 1 ? `~$${usd.toFixed(2)}/hr` : `~$${usd.toFixed(usd < 10 ? 1 : 0)}/hr`;
}

function money(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return usd < 10 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

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
  const agentCount = useSim((s) => s.agentCount);
  const serverAgents = useSim((s) => s.serverAgents);
  const agentLimits = useSim((s) => s.agentLimits);
  const agentNote = useSim((s) => s.agentNote);
  const setAgentCount = useSim((s) => s.setAgentCount);
  const model = useSim((s) => s.model);
  const setModel = useSim((s) => s.setModel);
  const brain = useSim((s) => s.brain);
  const setBrain = useSim((s) => s.setBrain);
  const catalogue = useSim((s) => s.catalogue);
  const hasKey = useSim((s) => s.hasKey);
  const loading = useSim((s) => s.loading);
  const usage = useSim((s) => s.usage);

  const live = sourceKind === 'live';
  const models = catalogue.models.length > 0 ? catalogue.models : [];
  const chosen = models.find((m) => m.id === model);
  const options = HEADCOUNTS.filter((n) => n >= agentLimits.min && n <= agentLimits.max);
  const cost = costPerHour(chosen?.price, serverAgents || (agentCount ?? 0));

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

        {!live ? (
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
        ) : (
          <>
            <div className="field">
              <label className="field-label" htmlFor="agents-select">Agents</label>
              <select
                id="agents-select"
                className="control"
                value={agentCount ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  void setAgentCount(raw === '' ? null : Number(raw));
                }}
                title={agentNote || 'Scales the mix of entity types the world file specifies'}
              >
                <option value="">World default{serverAgents ? ` (${serverAgents})` : ''}</option>
                {options.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="model-select">Model</label>
              <select
                id="model-select"
                className="control"
                value={model ?? ''}
                onChange={(event) => void setModel(event.target.value)}
                title={chosen?.note ?? 'Which model the agents reason with'}
              >
                {models.map((entry) => (
                  <option
                    key={entry.id}
                    value={entry.id}
                    disabled={entry.provider !== 'stub' && !hasKey}
                  >
                    {entry.label}{entry.provider !== 'stub' && !hasKey ? ' \u2014 no key' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="brain-select">Agents run</label>
              <select
                id="brain-select"
                className="control"
                value={brain ?? ''}
                onChange={(event) => void setBrain(event.target.value)}
                title={catalogue.brains.find((b) => b.id === brain)?.note ?? ''}
              >
                {catalogue.brains.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
            </div>

            {usage && usage.calls > 0 ? (
              <div
                className="spend"
                title={[
                  `${usage.calls} model calls`,
                  `${usage.promptTokens.toLocaleString()} prompt tokens`,
                  `${usage.completionTokens.toLocaleString()} completion tokens`,
                  usage.cachedTokens ? `${usage.cachedTokens.toLocaleString()} cached` : null,
                  usage.errors ? `${usage.errors} errors` : null,
                  usage.rateLimited ? `${usage.rateLimited} rate limited` : null,
                  'Priced from this model\u2019s published rate; reset when the world reloads.',
                ].filter(Boolean).join('\n')}
              >
                <span className="spend-value">{money(usage.costUsd)}</span>
                <span className="spend-detail">
                  {tokens(usage.promptTokens + usage.completionTokens)} tok
                  {' \u00b7 '}
                  {usage.calls} calls
                  {usage.rateLimited > 0 ? ` \u00b7 ${usage.rateLimited} limited` : ''}
                </span>
              </div>
            ) : cost ? (
              <span className="field-note" title="Rough forecast: assumes half the population decides twice a minute">
                {cost}
              </span>
            ) : null}
          </>
        )}
      </div>

      <div className="readout">
        <span className="readout-unit">t</span>
        <span className="readout-value">{padTick(tick)}</span>
        <span className="readout-unit">{config?.tickUnit ?? 'tick'}s elapsed</span>
      </div>

      <div
        className="status"
        data-status={loading ? 'connecting' : status}
        title={loading ? 'Building the population: a keypair and token accounts per agent' : statusDetail}
      >
        <span className={`status-dot${loading || status === 'connecting' ? ' pulse' : ''}`} />
        {loading ? 'building' : sourceKind === 'fixture' ? 'fixture replay' : status}
      </div>
    </header>
  );
}
