/**
 * Compares dotted version strings. Missing segments count as 0, so "1.2" equals
 * "1.2.0". Returns <0 / 0 / >0, matching the Array.sort comparator convention.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const nb = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Expands "zh-Hans-CN" into candidates, most specific first: ["zh-Hans-CN", "zh-Hans", "zh"]. */
export function localeCandidates(locale: string | undefined): string[] {
  if (!locale) return [];
  const parts = locale.split(/[-_]/).filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join('-'));
  return out;
}
