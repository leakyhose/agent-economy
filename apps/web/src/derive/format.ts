/** Turns any identifier from a world file into readable display text. */
export function humanize(id: string): string {
  const spaced = id
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (spaced.length === 0) return id;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function num(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function abbreviate(value: number): string {
  if (!Number.isFinite(value)) return '--';
  if (Math.abs(value) < 10000) return num(value, Number.isInteger(value) ? 0 : 1);
  return compact.format(value);
}

/** Prices travel as integer minor units; one hundred of them make one unit. */
export function fromMinor(minor: number): number {
  return minor / 100;
}

export function price(minor: number): string {
  return num(fromMinor(minor), 2);
}

export function signed(value: number, digits = 2): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${num(Math.abs(value), digits)}`;
}

export function percent(fraction: number, digits = 1): string {
  return `${signed(fraction * 100, digits)}%`;
}

export function ratio(value: number): string {
  return num(value, 3);
}

export function truncateMiddle(text: string, head = 4, tail = 4): string {
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export function padTick(tick: number): string {
  return tick.toString().padStart(5, '0');
}
