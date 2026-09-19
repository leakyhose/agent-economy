/**
 * World discovery. The manifest is produced by scripts/sync-worlds.mjs from a
 * directory listing of /worlds, so a new definition dropped in that folder shows
 * up in the selector with no code change.
 */
import type { WorldDefinition } from '@aw/types';

export interface WorldEntry {
  slug: string;
  file: string;
  name: string;
}

function assetUrl(path: string): string {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  return new URL(path, base).toString();
}

export async function loadManifest(): Promise<WorldEntry[]> {
  const response = await fetch(assetUrl('worlds/index.json'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`World manifest unavailable (${response.status})`);
  return (await response.json()) as WorldEntry[];
}

export async function loadWorld(entry: WorldEntry): Promise<WorldDefinition> {
  const response = await fetch(assetUrl(entry.file), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${entry.slug} could not be read (${response.status})`);
  return (await response.json()) as WorldDefinition;
}
