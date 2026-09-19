// Mirrors every world definition in /worlds into the static asset directory and
// writes a manifest beside them. Discovery is by directory listing, so dropping
// a new, unseen world file into /worlds makes it selectable with no code change.
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(here, '..', '..', '..', 'worlds');
const targetDir = join(here, '..', 'public', 'worlds');

const files = (await readdir(sourceDir)).filter((f) => f.endsWith('.json')).sort();

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

const manifest = [];
for (const file of files) {
  const raw = await readFile(join(sourceDir, file), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err && err.message) || err}`);
  }
  const slug = basename(file, '.json');
  await writeFile(join(targetDir, file), raw);
  manifest.push({
    slug,
    file: `worlds/${file}`,
    name: typeof parsed.name === 'string' ? parsed.name : slug,
  });
}

await writeFile(join(targetDir, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[worlds] ${manifest.length} definition(s) available: ${manifest.map((m) => m.slug).join(', ')}`);
