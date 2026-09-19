/**
 * Five memory stores, all of them world-agnostic: they hold strings and
 * numbers. Nothing in this file knows what any of those strings mean.
 *
 *   short        ring buffer over the most recent observations
 *   long         durable facts, capped, evicted by salience
 *   episodic     things that happened to me, stamped with a tick
 *   semantic     generalisations learned from repetition (e.g. observed levels)
 *   relationship per-other-entity notes plus a trust scalar
 */

export type MemoryKind = 'short' | 'long' | 'episodic' | 'semantic' | 'relationship';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'short',
  'long',
  'episodic',
  'semantic',
  'relationship',
] as const;

export interface MemoryRecord {
  /** Monotonic insertion counter. Newer records have a higher seq. */
  seq: number;
  kind: MemoryKind;
  content: string;
  /** 0..1. How much this is worth keeping when the store is full. */
  salience: number;
  tick: number;
  /** For relationship records, the other entity's id; for semantic, the key. */
  subject?: string;
}

export interface MemoryOptions {
  /** Per-store caps. */
  limits?: Partial<Record<MemoryKind, number>>;
  /** Starting tick. */
  tick?: number;
}

export interface RememberOptions {
  tick?: number;
  subject?: string;
}

/** Running statistics for one observed numeric series. */
export interface NumericSummary {
  key: string;
  count: number;
  mean: number;
  last: number;
  low: number;
  high: number;
}

const DEFAULT_LIMITS: Record<MemoryKind, number> = {
  short: 12,
  long: 64,
  episodic: 96,
  semantic: 48,
  relationship: 64,
};

const WORD = /[a-z0-9_.:-]+/g;

function tokenize(text: string): string[] {
  const matched = text.toLowerCase().match(WORD);
  if (!matched) return [];
  return matched.filter((t) => t.length >= 2);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export class Memory {
  private readonly stores = new Map<MemoryKind, MemoryRecord[]>();
  private readonly limits: Record<MemoryKind, number>;
  private readonly trustScores = new Map<string, number>();
  private readonly numeric = new Map<string, NumericSummary>();
  private seq = 0;
  private currentTick: number;

  constructor(options: MemoryOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    for (const kind of MEMORY_KINDS) {
      this.stores.set(kind, []);
      const cap = this.limits[kind];
      if (!Number.isFinite(cap) || cap < 1) this.limits[kind] = DEFAULT_LIMITS[kind];
    }
    this.currentTick = options.tick ?? 0;
  }

  get tick(): number {
    return this.currentTick;
  }

  setTick(tick: number): void {
    if (Number.isFinite(tick)) this.currentTick = tick;
  }

  private store(kind: MemoryKind): MemoryRecord[] {
    const existing = this.stores.get(kind);
    if (existing) return existing;
    const created: MemoryRecord[] = [];
    this.stores.set(kind, created);
    return created;
  }

  /** Write one item into one store. Returns the stored record. */
  remember(
    kind: MemoryKind,
    content: string,
    salience = 0.5,
    options: RememberOptions = {},
  ): MemoryRecord {
    const record: MemoryRecord = {
      seq: this.seq++,
      kind,
      content: String(content),
      salience: clamp01(salience),
      tick: options.tick ?? this.currentTick,
    };
    if (options.subject !== undefined) record.subject = options.subject;
    const bucket = this.store(kind);
    bucket.push(record);
    this.evict(kind);
    return record;
  }

  /**
   * `short` is a ring buffer: oldest out first, regardless of salience — it is
   * a window on the present, not an archive. Every other store keeps whatever
   * it considers most worth keeping.
   */
  private evict(kind: MemoryKind): void {
    const bucket = this.store(kind);
    const cap = this.limits[kind];
    while (bucket.length > cap) {
      if (kind === 'short') {
        bucket.shift();
        continue;
      }
      let worst = 0;
      for (let i = 1; i < bucket.length; i++) {
        const candidate = bucket[i];
        const incumbent = bucket[worst];
        if (!candidate || !incumbent) continue;
        if (candidate.salience < incumbent.salience) {
          worst = i;
        } else if (candidate.salience === incumbent.salience && candidate.seq < incumbent.seq) {
          worst = i;
        }
      }
      bucket.splice(worst, 1);
    }
  }

  /**
   * Keyword overlap, then salience, then recency. No embeddings: there is no
   * time for them and this ranks well enough over a few dozen short strings.
   * Ordering is total and deterministic, so tests can assert it exactly.
   */
  recall(query: string, limit = 5): string[] {
    const wanted = tokenize(query ?? '');
    const scored: Array<{ record: MemoryRecord; score: number }> = [];
    for (const kind of MEMORY_KINDS) {
      for (const record of this.store(kind)) {
        scored.push({ record, score: this.score(record, wanted) });
      }
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.record.seq - a.record.seq;
    });
    const out: string[] = [];
    const cap = Math.max(0, Math.trunc(limit));
    for (const item of scored) {
      if (out.length >= cap) break;
      if (!out.includes(item.record.content)) out.push(item.record.content);
    }
    return out;
  }

  private score(record: MemoryRecord, wanted: string[]): number {
    let overlap = 0;
    if (wanted.length > 0) {
      const have = new Set(tokenize(record.content));
      if (record.subject) for (const t of tokenize(record.subject)) have.add(t);
      let hits = 0;
      for (const token of wanted) if (have.has(token)) hits++;
      overlap = hits / wanted.length;
    }
    const age = Math.max(0, this.currentTick - record.tick);
    const recency = 1 / (1 + age);
    return round(2 * overlap + record.salience + 0.5 * recency);
  }

  /** Everything in one store, oldest first. A copy; callers cannot mutate us. */
  all(kind?: MemoryKind): MemoryRecord[] {
    if (kind) return [...this.store(kind)];
    const out: MemoryRecord[] = [];
    for (const k of MEMORY_KINDS) out.push(...this.store(k));
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  size(kind: MemoryKind): number {
    return this.store(kind).length;
  }

  // -- relationship store ---------------------------------------------------

  /** A note about another entity, plus an optional nudge to its trust scalar. */
  note(other: string, content: string, salience = 0.5, trustDelta = 0): MemoryRecord {
    // Always register the subject, even at a delta of zero: "I have met this
    // one" is itself worth knowing, and it is what stops a caller re-noting the
    // same neighbour on every tick.
    this.adjustTrust(other, trustDelta);
    return this.remember('relationship', content, salience, { subject: other });
  }

  /** -1 (burned me) .. 0 (unknown) .. 1 (reliable). */
  trustOf(other: string): number {
    return this.trustScores.get(other) ?? 0;
  }

  adjustTrust(other: string, delta: number): number {
    if (!Number.isFinite(delta)) return this.trustOf(other);
    const next = Math.max(-1, Math.min(1, this.trustOf(other) + delta));
    this.trustScores.set(other, round(next));
    return next;
  }

  knownOthers(): string[] {
    return [...this.trustScores.keys()].sort();
  }

  notesAbout(other: string): MemoryRecord[] {
    return this.store('relationship').filter((r) => r.subject === other);
  }

  // -- semantic store -------------------------------------------------------

  /**
   * Fold one sample into a running generalisation. The key is an opaque string
   * chosen by the caller; this store has no idea what is being measured.
   */
  observeValue(key: string, value: number): NumericSummary | null {
    if (!Number.isFinite(value)) return null;
    const previous = this.numeric.get(key);
    const summary: NumericSummary = previous
      ? {
          key,
          count: previous.count + 1,
          mean: round(previous.mean + (value - previous.mean) / (previous.count + 1)),
          last: value,
          low: Math.min(previous.low, value),
          high: Math.max(previous.high, value),
        }
      : { key, count: 1, mean: round(value), last: value, low: value, high: value };
    this.numeric.set(key, summary);

    // Keep exactly one semantic record per key so repetition sharpens the
    // generalisation instead of flooding the store.
    const bucket = this.store('semantic');
    const at = bucket.findIndex((r) => r.subject === key);
    if (at >= 0) bucket.splice(at, 1);
    const salience = clamp01(0.3 + Math.min(0.6, summary.count / 20));
    this.remember('semantic', renderSummary(summary), salience, { subject: key });
    return summary;
  }

  valueOf(key: string): NumericSummary | null {
    return this.numeric.get(key) ?? null;
  }

  /** Every series this agent has generalised about, in stable key order. */
  values(): NumericSummary[] {
    return [...this.numeric.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

function renderSummary(s: NumericSummary): string {
  return `${s.key} avg=${s.mean} last=${s.last} range=${s.low}..${s.high} n=${s.count}`;
}
