'use client';

import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { EntityId, SimEvent, WorldDefinition, WorldState } from '@aw/types';
import type {
  BrainChoice, LLMUsage, ModelChoice, OrderBook, ServerMessage, SimSource, TransportStatus,
} from '../data/contract.ts';
import { FixtureSource } from '../data/fixtureSource.ts';
import { DEFAULT_ENDPOINT, LiveSource } from '../data/liveSource.ts';
import { loadManifest, loadWorld, type WorldEntry } from '../data/worlds.ts';
import { resolveViewConfig, type ViewConfig } from '../derive/viewConfig.ts';

const EVENT_CAP = 2500;
const SERIES_CAP = 600;

export type ViewId = 'world' | 'agents' | 'markets' | 'events' | 'chain' | 'analytics';

export interface Series {
  ticks: number[];
  values: Record<string, number[]>;
}

function pushSeries(series: Series, tick: number, sample: Record<string, number>): Series {
  const ticks = [...series.ticks, tick];
  const values: Record<string, number[]> = {};
  const keys = new Set([...Object.keys(series.values), ...Object.keys(sample)]);
  for (const key of keys) {
    const prior = series.values[key] ?? [];
    const next = [...prior, sample[key] ?? prior[prior.length - 1] ?? 0];
    values[key] = next.length > SERIES_CAP ? next.slice(-SERIES_CAP) : next;
  }
  return { ticks: ticks.length > SERIES_CAP ? ticks.slice(-SERIES_CAP) : ticks, values };
}

const emptySeries: Series = { ticks: [], values: {} };

export interface SimStore {
  manifest: WorldEntry[];
  activeSlug: string | null;
  world: WorldDefinition | null;
  config: ViewConfig | null;
  state: WorldState | null;
  books: Record<string, OrderBook>;
  events: SimEvent[];
  metrics: Record<string, number>;
  metricSeries: Series;
  priceSeries: Series;

  view: ViewId;
  selected: EntityId | null;
  eventFilter: string[];
  sourceKind: 'fixture' | 'live';
  endpoint: string;
  status: TransportStatus;
  statusDetail: string;
  running: boolean;
  speed: number;
  scale: number;
  /** How many agents to request. null means whatever the world file specifies. */
  agentCount: number | null;
  /** What the server reported it actually spawned. */
  serverAgents: number;
  agentLimits: { min: number; max: number };
  agentNote: string;
  /** null means: adopt whatever the server reports. Set once the user chooses. */
  model: string | null;
  brain: string | null;
  catalogue: { models: ModelChoice[]; brains: BrainChoice[] };
  hasKey: boolean;
  loading: boolean;
  usage: LLMUsage | null;
  error: string | null;
  ready: boolean;

  boot: () => Promise<void>;
  selectWorld: (slug: string) => Promise<void>;
  setSourceKind: (kind: 'fixture' | 'live') => Promise<void>;
  control: (command: 'start' | 'pause' | 'step' | 'reset') => void;
  setSpeed: (multiplier: number) => void;
  setScale: (scale: number) => void;
  setAgentCount: (count: number | null) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setBrain: (brain: string) => Promise<void>;
  setView: (view: ViewId) => void;
  select: (id: EntityId | null) => void;
  toggleEventFilter: (type: string) => void;
  clearEventFilter: () => void;
}

let source: SimSource | null = null;
let unsubscribe: (() => void) | null = null;
let unstatus: (() => void) | null = null;

function teardown(): void {
  unsubscribe?.();
  unstatus?.();
  source?.dispose();
  unsubscribe = null;
  unstatus = null;
  source = null;
}

export const useSim = create<SimStore>((set, get) => {
  const ingest = (message: ServerMessage): void => {
    switch (message.type) {
      case 'status':
        // The server is the authority on what it is actually running.
        set({
          running: message.running,
          serverAgents: message.agents ?? 0,
          ...(message.agentLimits ? { agentLimits: message.agentLimits } : {}),
          agentNote: message.agentNote ?? '',
          ...(message.model && !get().model ? { model: message.model } : {}),
          ...(message.brain && !get().brain ? { brain: message.brain } : {}),
          ...(message.catalogue ? { catalogue: message.catalogue } : {}),
          hasKey: Boolean(message.hasKey),
          loading: Boolean(message.loading),
          usage: message.usage ?? null,
        });
        break;
      case 'world':
        set({ world: message.world, config: resolveViewConfig(message.world) });
        break;
      case 'state': {
        const next = message.state;
        set((prior) => ({
          state: next,
          priceSeries: pushSeries(prior.priceSeries, next.tick, next.prices),
        }));
        break;
      }
      case 'metrics':
        set((prior) => ({
          metrics: message.metrics,
          metricSeries: pushSeries(prior.metricSeries, prior.state?.tick ?? 0, message.metrics),
        }));
        break;
      case 'market':
        set({ books: message.books });
        break;
      case 'events':
        set((prior) => {
          const merged = [...prior.events, ...message.events];
          return { events: merged.length > EVENT_CAP ? merged.slice(-EVENT_CAP) : merged };
        });
        break;
      default:
        break;
    }
  };

  /** Rebuild the running world in place, keeping the transport open. */
  const reload = async (change: { agents?: number | null; model?: string; brain?: string }):
    Promise<void> => {
    const slug = get().activeSlug;
    if (!slug) return;
    // A fixture run has no server to tell, so it restarts locally instead.
    if (get().sourceKind !== 'live' || !source) {
      await attach(slug, get().sourceKind);
      return;
    }
    set({
      state: null, events: [], books: {}, metrics: {},
      metricSeries: emptySeries, priceSeries: emptySeries, selected: null,
      running: false, loading: true,
    });
    const agents = change.agents !== undefined ? change.agents : get().agentCount;
    const model = change.model ?? get().model;
    const brain = change.brain ?? get().brain;
    source.send({
      type: 'load',
      world: slug,
      ...(agents ? { agents } : {}),
      ...(model ? { model } : {}),
      ...(brain ? { brain } : {}),
    });
    // Same reasoning as attach: a rebuilt world waits to be started.
    set({ running: false });
  };

  const attach = async (slug: string, kind: 'fixture' | 'live'): Promise<void> => {
    teardown();
    set({
      state: null,
      events: [],
      books: {},
      metrics: {},
      metricSeries: emptySeries,
      priceSeries: emptySeries,
      selected: null,
      running: false,
      ready: false,
      error: null,
    });

    const entry = get().manifest.find((m) => m.slug === slug);
    if (!entry) {
      set({ error: `No world definition named ${slug}` });
      return;
    }

    let world: WorldDefinition;
    try {
      world = await loadWorld(entry);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    set({ world, config: resolveViewConfig(world), activeSlug: slug, sourceKind: kind, ready: true });

    const next: SimSource = kind === 'fixture'
      ? new FixtureSource(world, { scale: get().scale, warmup: 24 })
      : new LiveSource(get().endpoint);

    source = next;
    unsubscribe = next.subscribe(ingest);
    unstatus = next.onStatus((status, detail) => set({ status, statusDetail: detail ?? '' }));
    next.send({
      type: 'load',
      world: slug,
      ...(get().agentCount ? { agents: get().agentCount as number } : {}),
      ...(get().model ? { model: get().model as string } : {}),
      ...(get().brain ? { brain: get().brain as string } : {}),
    });
    next.send({ type: 'speed', multiplier: get().speed });
    // Deliberately not started. A model-backed run costs money from its first
    // tick, so beginning one is always an explicit act.
    set({ running: false });
  };

  return {
    manifest: [],
    activeSlug: null,
    world: null,
    config: null,
    state: null,
    books: {},
    events: [],
    metrics: {},
    metricSeries: emptySeries,
    priceSeries: emptySeries,

    view: 'world',
    selected: null,
    eventFilter: [],
    sourceKind: 'fixture',
    endpoint: DEFAULT_ENDPOINT,
    status: 'offline',
    statusDetail: '',
    running: false,
    speed: 1,
    scale: 4,
    agentCount: null,
    serverAgents: 0,
    agentLimits: { min: 2, max: 320 },
    agentNote: '',
    model: null,
    brain: null,
    catalogue: { models: [], brains: [] },
    hasKey: false,
    loading: false,
    usage: null,
    error: null,
    ready: false,

    boot: async () => {
      try {
        const manifest = await loadManifest();
        set({ manifest });
        const first = manifest[0];
        if (first) await attach(first.slug, get().sourceKind);
        else set({ error: 'No world definitions were discovered in /worlds' });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    selectWorld: async (slug) => { await attach(slug, get().sourceKind); },

    setSourceKind: async (kind) => {
      const slug = get().activeSlug;
      set({ sourceKind: kind });
      if (slug) await attach(slug, kind);
    },

    control: (command) => {
      source?.send({ type: 'control', command });
      if (command === 'start') set({ running: true });
      if (command === 'pause' || command === 'step') set({ running: false });
      if (command === 'reset') {
        set({ running: false, events: [], metricSeries: emptySeries, priceSeries: emptySeries });
      }
    },

    setSpeed: (multiplier) => {
      set({ speed: multiplier });
      source?.send({ type: 'speed', multiplier });
    },

    setScale: (scale) => {
      set({ scale, events: [], metricSeries: emptySeries, priceSeries: emptySeries, selected: null });
      if (source instanceof FixtureSource) source.setScale(scale);
    },

    // Each of these rebuilds the population, so the run restarts from tick zero.
    // They reload over the existing connection rather than re-attaching: a fresh
    // socket races its own queued load against this one, and the loser wins.
    setAgentCount: async (count) => {
      set({ agentCount: count });
      await reload({ agents: count });
    },

    setModel: async (model) => {
      set({ model });
      await reload({ model });
    },

    setBrain: async (brain) => {
      set({ brain });
      await reload({ brain });
    },

    setView: (view) => set({ view }),
    select: (id) => set({ selected: id }),
    toggleEventFilter: (type) =>
      set((prior) => ({
        eventFilter: prior.eventFilter.includes(type)
          ? prior.eventFilter.filter((t) => t !== type)
          : [...prior.eventFilter, type],
      })),
    clearEventFilter: () => set({ eventFilter: [] }),
  };
});

/**
 * Samples the store at a fixed cadence. The heavy tables use this so a fast
 * clock never forces React to re-render hundreds of rows per frame.
 */
export function useSampled<T>(selector: (state: SimStore) => T, ms = 320): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const [value, setValue] = useState<T>(() => selector(useSim.getState()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const flush = (): void => {
      last = Date.now();
      timer = null;
      setValue(() => selectorRef.current(useSim.getState()));
    };
    flush();
    const unsubscribeStore = useSim.subscribe(() => {
      if (timer !== null) return;
      timer = setTimeout(flush, Math.max(0, ms - (Date.now() - last)));
    });
    return () => {
      unsubscribeStore();
      if (timer !== null) clearTimeout(timer);
    };
  }, [ms]);

  return value;
}
