/** Local time, minute precision — feedback timestamps don't need seconds. */
export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "3 min ago" / "2 d ago" — the column keeps the absolute time in its tooltip. */
export function fmtRelative(ms: number | null | undefined): string {
  if (!ms) return '—';
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) return 'just now';
  const steps: [number, string][] = [
    [60, 'min'],
    [3600, 'h'],
    [86400, 'd'],
  ];
  for (let i = steps.length - 1; i >= 0; i--) {
    const [unit, label] = steps[i];
    if (secs >= unit) return `${Math.floor(secs / unit)} ${label} ago`;
  }
  return 'just now';
}

/** Stat-tile figures: 1,284 · 12.9K · 3.4M. */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) < 10_000) return n.toLocaleString();
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export const fmtPercent = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
