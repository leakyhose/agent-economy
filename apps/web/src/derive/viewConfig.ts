/**
 * Reads a world definition and produces the entire configuration the dashboard
 * renders from: which colours identify which entity types, which columns the
 * tables carry, which charts exist, which relationship kinds can appear as
 * edges, which assets settle on chain.
 *
 * Nothing here knows the meaning of a single identifier. A world file this code
 * has never seen produces a complete dashboard.
 */
import type {
  ActionDef,
  EntityTypeId,
  Expr,
  MarketDef,
  MetricDef,
  ResourceId,
  Rule,
  WorldDefinition,
} from '@aw/types';
import { humanize } from './format.ts';
import { identityColor, materialColor } from './palette.ts';

export interface EntityTypeView {
  id: EntityTypeId;
  index: number;
  label: string;
  color: string;
  agent: boolean;
  attributeKeys: string[];
  resourceKeys: ResourceId[];
}

export interface ResourceView {
  id: ResourceId;
  index: number;
  label: string;
  color: string;
  onChain: boolean;
  spoilage: number;
  startPrice: number;
  divisible: boolean;
  isCurrency: boolean;
  /** Market ids where this resource is the traded side. */
  tradedOn: string[];
}

export interface MarketView {
  id: string;
  label: string;
  resource: ResourceId;
  currency: ResourceId;
  mechanism: MarketDef['mechanism'];
  roundTicks: number;
  color: string;
}

export type MetricKind = 'count' | 'index' | 'currency' | 'quantity';

export interface MetricView {
  id: string;
  label: string;
  kind: MetricKind;
  aggregate: MetricDef['aggregate'];
  over: EntityTypeId | null;
  color: string;
}

export interface RelationView {
  kind: string;
  label: string;
  color: string;
  fromTypes: EntityTypeId[];
  toTypes: EntityTypeId[];
  viaAction: string | null;
}

export interface SpawnView {
  type: EntityTypeId;
  viaAction: string | null;
  ownerTypes: EntityTypeId[];
}

export interface ViewConfig {
  name: string;
  seed: number;
  tickMs: number;
  tickUnit: string;
  /** The world's unit of account: the first resource it declares. */
  currency: ResourceId;
  entityTypes: EntityTypeView[];
  entityTypeById: Record<EntityTypeId, EntityTypeView>;
  agentTypes: EntityTypeId[];
  resources: ResourceView[];
  resourceById: Record<ResourceId, ResourceView>;
  onChainResources: ResourceId[];
  markets: MarketView[];
  metrics: MetricView[];
  actions: ActionDef[];
  actionsByType: Record<EntityTypeId, ActionDef[]>;
  relations: RelationView[];
  spawns: SpawnView[];
  settlementAssets: ResourceId[];
  /** Every event name the world can emit, from its rules and its own events. */
  eventTypes: string[];
  /** Emitted only by scheduled or probabilistic world events: worth shouting. */
  alertEventTypes: string[];
  populationTotal: number;
  ruleCount: number;
}

/** Event names the engine produces for every world, independent of vocabulary. */
export const ENGINE_EVENTS = {
  cleared: 'market_cleared',
  settled: 'settlement_confirmed',
  rejected: 'proposal_rejected',
} as const;

function emittedBy(rules: Rule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    for (const effect of rule.effects ?? []) {
      if (effect.op === 'emit') out.push(effect.event);
    }
  }
  return out;
}

function typesForPath(path: string, action: ActionDef | undefined, all: EntityTypeId[], spawned: EntityTypeId | null): EntityTypeId[] {
  const token = path.split('.')[0] ?? path;
  if (token === '$actor') {
    const listed = action?.actorTypes ?? [];
    return listed.length > 0 ? listed : all;
  }
  if (token === '$target') {
    const listed = action?.targetTypes ?? [];
    return listed.length > 0 ? listed : all;
  }
  if (spawned) return [spawned];
  return all;
}

function metricKind(def: MetricDef, currency: ResourceId): MetricKind {
  if (def.aggregate === 'count') return 'count';
  if (def.aggregate === 'gini') return 'index';
  const ref = refOf(def.value);
  if (ref && ref.endsWith(`.${currency}`)) return 'currency';
  return 'quantity';
}

function refOf(expr: Expr | undefined): string | null {
  if (!expr || typeof expr !== 'object') return null;
  if ('ref' in expr) return expr.ref;
  return null;
}

export function resolveViewConfig(world: WorldDefinition): ViewConfig {
  const allTypeIds = world.entityTypes.map((t) => t.id);
  const currency = world.resources[0]?.id ?? '';

  const marketsRaw = world.markets ?? [];

  const resources: ResourceView[] = world.resources.map((r, index) => ({
    id: r.id,
    index,
    label: humanize(r.id),
    color: materialColor(index),
    onChain: r.onChain === true,
    spoilage: r.spoilage ?? 0,
    startPrice: r.startPrice ?? 0,
    divisible: r.divisible === true,
    isCurrency: r.id === currency,
    tradedOn: marketsRaw.filter((m) => m.resource === r.id).map((m) => m.id),
  }));
  const resourceById: Record<ResourceId, ResourceView> = {};
  for (const r of resources) resourceById[r.id] = r;

  const entityTypes: EntityTypeView[] = world.entityTypes.map((t, index) => ({
    id: t.id,
    index,
    label: humanize(t.id),
    color: identityColor(index),
    agent: t.agent === true,
    attributeKeys: Object.keys(t.attributes ?? {}),
    resourceKeys: Object.keys(t.resources ?? {}),
  }));
  const entityTypeById: Record<EntityTypeId, EntityTypeView> = {};
  for (const t of entityTypes) entityTypeById[t.id] = t;

  const actionsByType: Record<EntityTypeId, ActionDef[]> = {};
  for (const type of allTypeIds) actionsByType[type] = [];
  for (const action of world.actions) {
    const actors = action.actorTypes && action.actorTypes.length > 0 ? action.actorTypes : allTypeIds;
    for (const type of actors) {
      const bucket = actionsByType[type];
      if (bucket) bucket.push(action);
    }
  }

  const actionById: Record<string, ActionDef> = {};
  for (const action of world.actions) actionById[action.id] = action;

  const relationMap = new Map<string, RelationView>();
  const spawns: SpawnView[] = [];
  const settlementAssets = new Set<ResourceId>();

  for (const rule of world.rules ?? []) {
    const action = rule.when?.action ? actionById[rule.when.action] : undefined;
    const spawnEffect = (rule.effects ?? []).find((e) => e.op === 'spawn');
    const spawned = spawnEffect && spawnEffect.op === 'spawn' ? spawnEffect.type : null;

    if (spawned) {
      spawns.push({
        type: spawned,
        viaAction: rule.when?.action ?? null,
        ownerTypes: typesForPath('$actor', action, allTypeIds, null),
      });
    }

    for (const effect of rule.effects ?? []) {
      if (effect.op === 'settle') settlementAssets.add(effect.asset);
      if (effect.op !== 'relate') continue;
      const fromTypes = typesForPath(effect.from, action, allTypeIds, spawned);
      const toTypes = typesForPath(effect.to, action, allTypeIds, spawned);
      const existing = relationMap.get(effect.kind);
      if (existing) {
        existing.fromTypes = Array.from(new Set([...existing.fromTypes, ...fromTypes]));
        existing.toTypes = Array.from(new Set([...existing.toTypes, ...toTypes]));
      } else {
        relationMap.set(effect.kind, {
          kind: effect.kind,
          label: humanize(effect.kind),
          color: materialColor(relationMap.size + 2),
          fromTypes,
          toTypes,
          viaAction: rule.when?.action ?? null,
        });
      }
    }
  }

  const worldEventEmissions = new Set<string>();
  for (const we of world.events ?? []) {
    for (const effect of we.effects ?? []) {
      if (effect.op === 'emit') worldEventEmissions.add(effect.event);
    }
  }

  const eventTypes = Array.from(
    new Set([
      ...emittedBy(world.rules ?? []),
      ...worldEventEmissions,
      ...Object.values(ENGINE_EVENTS),
    ]),
  ).sort();

  const metrics: MetricView[] = (world.metrics ?? []).map((m, index) => ({
    id: m.id,
    label: humanize(m.id),
    kind: metricKind(m, currency),
    aggregate: m.aggregate,
    over: m.over ?? null,
    color: m.over && entityTypeById[m.over] ? (entityTypeById[m.over]?.color ?? identityColor(index)) : identityColor(index),
  }));

  const markets: MarketView[] = marketsRaw.map((m) => ({
    id: m.id,
    label: humanize(m.id),
    resource: m.resource,
    currency: m.currency,
    mechanism: m.mechanism,
    roundTicks: m.roundTicks ?? 1,
    color: resourceById[m.resource]?.color ?? materialColor(0),
  }));

  return {
    name: world.name,
    seed: world.seed,
    tickMs: world.time?.tickMs ?? 500,
    tickUnit: world.time?.unit ?? 'tick',
    currency,
    entityTypes,
    entityTypeById,
    agentTypes: entityTypes.filter((t) => t.agent).map((t) => t.id),
    resources,
    resourceById,
    onChainResources: resources.filter((r) => r.onChain).map((r) => r.id),
    markets,
    metrics,
    actions: world.actions,
    actionsByType,
    relations: Array.from(relationMap.values()),
    spawns,
    settlementAssets: Array.from(settlementAssets),
    eventTypes,
    alertEventTypes: Array.from(worldEventEmissions).sort(),
    populationTotal: (world.population ?? []).reduce((a, p) => a + p.count, 0),
    ruleCount: (world.rules ?? []).length,
  };
}
