/**
 * The two structural rules of this package, as tests rather than as promises.
 *
 * 1. @aw/agents must never reach the module that signs. An LLM proposing a
 *    transfer must produce a rejected proposal, never a transaction, and the
 *    cheapest way to guarantee that is for the import to be impossible.
 * 2. No world's vocabulary may appear in the source. Every action, resource and
 *    entity type is learned at runtime from the world definition, which is what
 *    makes one engine run both fixtures — and any world written later.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorlds } from './fixtures.ts';
import type { WorldDefinition } from '@aw/types';

const SRC = fileURLToPath(new URL('../../packages/agents/src/', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../../packages/agents/package.json', import.meta.url));

function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}${entry}`;
    if (statSync(full).isDirectory()) out.push(...sourceFiles(`${full}/`));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function relative(path: string): string {
  return path.slice(SRC.length);
}

const FILES = sourceFiles();
const ALLOWED_PACKAGES = new Set(['@aw/types', 'openai']);

/** Symbols that only exist where key material does. Case-sensitive on purpose:
 *  the prose in these files discusses private keys, it must not touch them. */
const KEY_MATERIAL = [
  '@aw/solana',
  '@solana/',
  'Keypair',
  'secretKey',
  'privateKey',
  'signTransaction',
  'mnemonic',
  'sendAndConfirm',
];

function specifiers(source: string): string[] {
  const out: string[] = [];
  const statiс = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]/g;
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const pattern of [statiс, dynamic, bare]) {
    let match = pattern.exec(source);
    while (match !== null) {
      if (match[1]) out.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return out;
}

describe('import boundary', () => {
  it('finds the package source', () => {
    expect(FILES.length).toBeGreaterThan(8);
  });

  it('imports nothing but @aw/types, the model SDK, and its own files', () => {
    const offences: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of specifiers(source)) {
        if (specifier.startsWith('./') || specifier.startsWith('../')) continue;
        if (ALLOWED_PACKAGES.has(specifier)) continue;
        offences.push(`${relative(file)} imports "${specifier}"`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('never names the signing layer or key material', () => {
    const offences: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const symbol of KEY_MATERIAL) {
        if (source.includes(symbol)) offences.push(`${relative(file)} contains "${symbol}"`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('declares no dependency beyond the contract and the model SDK', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const named = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(named.filter((name) => !ALLOWED_PACKAGES.has(name))).toEqual([]);
  });
});

/**
 * Words that belong to a world rather than to the engine. Derived from the
 * fixtures so that adding a world automatically widens the net.
 */
const GENERIC = new Set([
  'build',
  'market',
  'mine',
  'land',
  'total',
  'mean',
  'count',
  'good',
  'form',
  'free',
  'high',
  'over',
]);

function vocabularyOf(world: WorldDefinition): string[] {
  const ids: string[] = [
    ...world.resources.map((r) => r.id),
    ...world.entityTypes.map((t) => t.id),
    ...world.actions.map((a) => a.id),
    ...(world.markets ?? []).map((m) => m.id),
    ...(world.events ?? []).map((e) => e.id),
    ...(world.metrics ?? []).map((m) => m.id),
  ];
  const tokens = new Set<string>();
  for (const id of ids) {
    tokens.add(id.toLowerCase());
    for (const part of id.split(/[_\-\s]+/)) tokens.add(part.toLowerCase());
  }
  for (const part of world.name.split(/\s+/)) tokens.add(part.toLowerCase());
  return [...tokens].filter((token) => token.length >= 4 && !GENERIC.has(token)).sort();
}

describe('world vocabulary', () => {
  const worlds = loadWorlds();
  const forbidden = [...new Set(worlds.flatMap(vocabularyOf))].sort();

  it('derives a substantial vocabulary from the fixtures', () => {
    expect(forbidden.length).toBeGreaterThan(20);
    // Spot-check the words the brief called out by name.
    for (const word of ['company', 'peasant', 'gather_food', 'kingdom']) {
      expect(forbidden).toContain(word);
    }
  });

  it('appears nowhere in the package source', () => {
    const offences: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const word of forbidden) {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(source)) {
          offences.push(`${relative(file)} contains world vocabulary "${word}"`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
