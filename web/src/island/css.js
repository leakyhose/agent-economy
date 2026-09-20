// The island's markup came from a runtime that took `style="…"` strings. Rather than hand
// translate 120 style attributes into objects (and risk changing the look), the strings are
// kept verbatim and parsed once, here.
const cache = new Map();

export function S(text) {
  if (!text || typeof text !== 'string') return text || undefined;
  const hit = cache.get(text);
  if (hit) return hit;
  const style = {};
  for (const decl of text.split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim();
    const value = decl.slice(at + 1).trim();
    if (!prop || !value) continue;
    style[prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  if (cache.size > 4000) cache.clear();     // interpolated styles (per-agent delays) churn
  cache.set(text, style);
  return style;
}
