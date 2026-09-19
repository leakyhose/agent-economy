import type { ResourceId, WorldDefinition } from '@aw/types';

/**
 * How one world's resources map onto the program's good indices.
 *
 * The on-chain program is generic: it knows `num_goods` integers per agent and
 * nothing about what they are called. This is the whole of the world-specific
 * knowledge, and it is derived from the world file — never hardcoded. `Economic
 * Sandbox` yields `[SOL, food, wood, tools]`, `Medieval Kingdom` yields
 * `[gold, food, wood, iron, land]`, and the same client code drives both.
 */
export interface GoodMap {
  /** Index-aligned with the program's good indices. `goods[0]` is the currency. */
  readonly goods: readonly ResourceId[];
  /** What this world calls money: `SOL` in one, `gold` in the other. */
  readonly currency: ResourceId;
  /** `goods.length`. What `initialize` is called with. */
  readonly numGoods: number;
  /** Good index for a resource, or `undefined` if it does not settle on chain. */
  indexOf(resource: ResourceId): number | undefined;
  /** Good index, throwing rather than returning `undefined`. */
  mustIndexOf(resource: ResourceId): number;
  /** The tradable goods, i.e. every index except the currency. */
  readonly tradable: readonly { index: number; resource: ResourceId }[];
}

/** Program capacity. Mirrors `MAX_GOODS` in `programs/world/src/lib.rs`. */
export const MAX_GOODS = 8;
/** Program capacity. Mirrors `MAX_AGENTS` in `programs/world/src/lib.rs`. */
export const MAX_AGENTS = 320;

/**
 * Derive the good indices for a world.
 *
 * The currency is not "resource zero" by fiat — it is read off the world's markets,
 * every one of which names the resource it prices things in. That is the world
 * telling us what money is. A world with no markets falls back to its first on-chain
 * resource, which is the same answer for both shipped worlds but is a guess, so it is
 * only used when there is nothing better.
 */
export function mapWorldGoods(world: WorldDefinition): GoodMap {
  const onChain = world.resources.filter((r) => r.onChain === true).map((r) => r.id);
  if (onChain.length === 0) {
    throw new Error(`world "${world.name}" declares no onChain resources`);
  }
  if (onChain.length > MAX_GOODS) {
    throw new Error(
      `world "${world.name}" declares ${onChain.length} onChain resources; ` +
        `the program holds ${MAX_GOODS}`,
    );
  }

  const quoted = new Set((world.markets ?? []).map((m) => m.currency));
  if (quoted.size > 1) {
    throw new Error(
      `world "${world.name}" quotes markets in more than one currency ` +
        `(${[...quoted].join(', ')}); the ledger holds one cash balance per agent`,
    );
  }
  const currency = [...quoted][0] ?? onChain[0]!;
  if (!onChain.includes(currency)) {
    throw new Error(
      `world "${world.name}" prices its markets in "${currency}", which is not an ` +
        `onChain resource; the ledger cannot settle it`,
    );
  }

  const goods: ResourceId[] = [currency, ...onChain.filter((r) => r !== currency)];
  const index = new Map(goods.map((g, i) => [g, i]));

  return {
    goods,
    currency,
    numGoods: goods.length,
    indexOf: (r) => index.get(r),
    mustIndexOf(r) {
      const i = index.get(r);
      if (i === undefined) {
        throw new Error(`resource "${r}" does not settle on chain in "${world.name}"`);
      }
      return i;
    },
    tradable: goods.slice(1).map((resource, k) => ({ index: k + 1, resource })),
  };
}

/** A world's population, flattened into the agent indices the ledger uses. */
export interface AgentRoster {
  /** `entityId` for each agent index, in order. */
  readonly ids: readonly string[];
  /** Entity *type* for each agent index. */
  readonly types: readonly string[];
  readonly count: number;
  indexOf(entity: string): number | undefined;
}

/**
 * Lay a world's population out into ledger slots.
 *
 * Ids are synthesised as `<type>_<n>` so that a fresh run of the same world file
 * always produces the same slot for the same agent. The engine owns real entity ids;
 * when it does, pass its own ordering in instead of calling this.
 */
export function rosterFromWorld(world: WorldDefinition): AgentRoster {
  const ids: string[] = [];
  const types: string[] = [];
  // Ids run continuously per entity type, exactly as the engine allocates them.
  // A world may declare several cohorts of one type - to give them different
  // goals or attributes - and numbering must not restart at each one, or two
  // cohorts of people both claim person_0.
  const nextOfType = new Map<string, number>();
  for (const cohort of world.population) {
    let n = nextOfType.get(cohort.type) ?? 0;
    for (let k = 0; k < cohort.count; k++) {
      ids.push(`${cohort.type}_${n}`);
      types.push(cohort.type);
      n += 1;
    }
    nextOfType.set(cohort.type, n);
  }
  if (ids.length > MAX_AGENTS) {
    throw new Error(
      `world "${world.name}" has ${ids.length} agents; the ledger holds ${MAX_AGENTS}`,
    );
  }
  const index = new Map(ids.map((id, i) => [id, i]));
  return { ids, types, count: ids.length, indexOf: (e) => index.get(e) };
}

/** One absolute balance to write during genesis. */
export interface Endowment {
  agent: number;
  good: number;
  amount: number;
}

/**
 * The genesis endowments a world file asks for.
 *
 * `initialize` gives every slot the same purse, which is right for a single-type
 * world and wrong for a kingdom of peasants and nobles. This produces the corrections:
 * one entry per agent per good whose starting balance differs from the uniform one.
 * The caller sends them with `endow` before `seal`.
 */
export function endowmentsFor(
  world: WorldDefinition,
  roster: AgentRoster,
  map: GoodMap,
  uniform: { cash: number; goods: number[] },
): Endowment[] {
  const byType = new Map(world.entityTypes.map((t) => [t.id, t.resources ?? {}]));
  const out: Endowment[] = [];
  for (let agent = 0; agent < roster.count; agent++) {
    const want = byType.get(roster.types[agent]!) ?? {};
    for (let good = 0; good < map.numGoods; good++) {
      const amount = Math.trunc(want[map.goods[good]!] ?? 0);
      const already = good === 0 ? uniform.cash : (uniform.goods[good] ?? 0);
      if (amount !== already) out.push({ agent, good, amount });
    }
  }
  return out;
}

/**
 * The uniform endowment to pass to `initialize`: the most common starting balance
 * across the population, so `endowmentsFor` has the fewest corrections to send.
 */
export function modalEndowment(
  world: WorldDefinition,
  roster: AgentRoster,
  map: GoodMap,
): { cash: number; goods: number[] } {
  const byType = new Map(world.entityTypes.map((t) => [t.id, t.resources ?? {}]));
  const tally = new Map<string, number>();
  for (const type of roster.types) tally.set(type, (tally.get(type) ?? 0) + 1);
  let best = roster.types[0] ?? '';
  for (const [type, n] of tally) {
    if (n > (tally.get(best) ?? 0)) best = type;
  }
  const res = byType.get(best) ?? {};
  const goods = Array.from({ length: MAX_GOODS }, (_, g) =>
    g === 0 || g >= map.numGoods ? 0 : Math.trunc(res[map.goods[g]!] ?? 0),
  );
  return { cash: Math.trunc(res[map.currency] ?? 0), goods };
}
