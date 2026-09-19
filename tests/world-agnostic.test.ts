import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WorldDefinition } from '@aw/types';
import { ROOT, WORLD_FILES, readWorldFile } from './harness.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function vocabulary(): string[] {
  const ids = new Set<string>();
  for (const file of WORLD_FILES) {
    const world = JSON.parse(readWorldFile(file)) as WorldDefinition;
    for (const r of world.resources) ids.add(r.id);
    for (const t of world.entityTypes) ids.add(t.id);
    for (const a of world.actions) ids.add(a.id);
  }
  return [...ids].sort();
}

describe('the engine knows no world vocabulary', () => {
  const words = vocabulary();
  const files = walk(`${ROOT}packages/engine`);

  it('found a non-trivial vocabulary and a non-trivial engine', () => {
    expect(words.length).toBeGreaterThan(20);
    expect(files.length).toBeGreaterThan(5);
  });

  it('no resource, entity type or action id appears anywhere under packages/engine', () => {
    const hits: string[] = [];
    for (const word of words) {
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      for (const file of files) {
        if (re.test(file.slice(ROOT.length))) {
          hits.push(`filename "${file.slice(ROOT.length)}" contains "${word}"`);
        }
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (re.test(line)) {
            hits.push(`${file.slice(ROOT.length)}:${i + 1} contains "${word}": ${line.trim()}`);
          }
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
