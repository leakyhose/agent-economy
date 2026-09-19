/**
 * Categorical colour is assigned by position in the world definition, never by
 * name, so an unseen world gets a coherent scheme for free.
 */

/** Entity identity. Saturated, legible on slate, distinct at 4px on canvas. */
const IDENTITY = [
  '#E8B33C',
  '#4FC1A6',
  '#6BA8E8',
  '#E4685D',
  '#A88BE0',
  '#A9C64C',
  '#E08AB0',
  '#C98A5B',
] as const;

/** Materials. Cooler and quieter, so a chart never reads as an entity legend. */
const MATERIAL = [
  '#8FB9C9',
  '#C4B78A',
  '#9AA9D4',
  '#C79BA6',
  '#8CC0A4',
  '#BBA0C4',
  '#A9B98F',
  '#CFA98E',
] as const;

function rotate(base: readonly string[], index: number): string {
  const hue = (index * 47) % 360;
  const first = base[0] ?? '#888888';
  const lightness = index % 2 === 0 ? 62 : 52;
  return index < base.length ? (base[index] ?? first) : `hsl(${hue} 46% ${lightness}%)`;
}

export function identityColor(index: number): string {
  return rotate(IDENTITY, index);
}

export function materialColor(index: number): string {
  return rotate(MATERIAL, index);
}

/** Flat alpha blend against the panel ink, for fills behind a stroked line. */
export function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#') || hex.length !== 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
