/**
 * The dashboard must be driven by the world definition, never by knowledge of
 * any particular world. This check builds the vocabulary of every world file on
 * disk -- entity types, resources, actions, markets, metrics, attribute keys,
 * relationship kinds, emitted event names, and the world's own name -- and
 * fails if any of it is written into the application source.
 *
 * Adding a world to /worlds automatically widens the check.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorldDefinition } from '@aw/types';

const ROOT = join(__dirname, '..');
const WORLD_DIR = join(ROOT, '..', '..', 'worlds');
const SOURCE_DIRS = [join(ROOT, 'src'), join(ROOT, 'app')];
const SOURCE_EXT = /\.(ts|tsx|css)$/;

/**
 * Terms that are part of the frozen type contract or of general market and
 * dashboard language, and so cannot count as world-specific vocabulary.
 * Deliberately short: every entry here weakens the check.
 */
const CONTRACT_TERMS = new Set([
  'action', 'actions', 'count', 'currency', 'duration', 'entity', 'event', 'events',
  'market', 'markets', 'max', 'mean', 'mechanism', 'metric', 'metrics', 'min', 'name',
  'owns', 'price', 'prices', 'rate', 'resource', 'resources', 'rule', 'rules', 'seed',
  'set', 'state', 'sum', 'tick', 'ticks', 'time', 'total', 'type', 'types', 'value',
  'gini', 'params', 'target', 'actor', 'data', 'index',
  // ActionProposal is a frozen-contract type. It only looks world-specific
  // because a world emits proposal_opened; the `propose` action stays banned.
  'proposal', 'proposals',
]);

function splitToken(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function collectVocabulary(): Map<string, string> {
  const vocabulary = new Map<string, string>();
  const add = (raw: string, origin: string): void => {
    for (const candidate of [raw, ...splitToken(raw)]) {
      const term = candidate.toLowerCase();
      if (term.length < 3) continue;
      if (CONTRACT_TERMS.has(term)) continue;
      if (/^\d+$/.test(term)) continue;
      if (!vocabulary.has(term)) vocabulary.set(term, origin);
    }
  };

  for (const file of readdirSync(WORLD_DIR).filter((f) => f.endsWith('.json'))) {
    const world = JSON.parse(readFileSync(join(WORLD_DIR, file), 'utf8')) as WorldDefinition;
    const origin = file;
    add(world.name, origin);
    for (const resource of world.resources) add(resource.id, origin);
    for (const type of world.entityTypes) {
      add(type.id, origin);
      for (const key of Object.keys(type.attributes ?? {})) add(key, origin);
    }
    for (const action of world.actions) add(action.id, origin);
    for (const market of world.markets ?? []) add(market.id, origin);
    for (const metric of world.metrics ?? []) add(metric.id, origin);
    for (const spec of world.population ?? []) add(spec.type, origin);
    for (const rule of world.rules ?? []) {
      for (const effect of rule.effects ?? []) {
        if (effect.op === 'relate' || effect.op === 'unrelate') add(effect.kind, origin);
        if (effect.op === 'emit') add(effect.event, origin);
        if (effect.op === 'spawn') add(effect.type, origin);
      }
    }
    for (const worldEvent of world.events ?? []) {
      for (const effect of worldEvent.effects ?? []) {
        if (effect.op === 'emit') add(effect.event, origin);
      }
    }
  }
  return vocabulary;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_EXT.test(entry)) out.push(full);
    }
  };
  for (const dir of SOURCE_DIRS) walk(dir);
  return out;
}

/** camelCase is split apart, so `foodPrice` cannot hide a banned term. */
function normalize(line: string): string {
  return line.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

describe('world vocabulary never reaches the source', () => {
  const vocabulary = collectVocabulary();
  const files = sourceFiles();

  it('builds a non-trivial vocabulary from the world files on disk', () => {
    expect(vocabulary.size).toBeGreaterThan(30);
    expect(files.length).toBeGreaterThan(10);
  });

  it('finds no world-specific term in any source file', () => {
    const matchers = Array.from(vocabulary.entries()).map(([term, origin]) => ({
      term,
      origin,
      pattern: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    }));

    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const normalized = normalize(line);
        for (const matcher of matchers) {
          if (matcher.pattern.test(normalized)) {
            violations.push(
              `${relative(ROOT, file)}:${index + 1} uses "${matcher.term}" (from ${matcher.origin}): ${line.trim().slice(0, 90)}`,
            );
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
