import { Hono } from 'hono';
import { requireAppKey } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import { sha256Hex } from '../lib/crypto';
import { compareVersions, localeCandidates } from '../lib/version';
import type { HonoEnv } from '../types';

interface PromptConfigRow {
  locale: string;
  min_app_version: string;
  enabled: number;
  variant: string;
  title: string;
  message: string;
  positive_label: string;
  negative_label: string;
  later_label: string;
  feedback_title: string | null;
  feedback_message: string | null;
  categories_json: string;
  email_required: number;
  rules_json: string | null;
}

/**
 * Used when the console has no copy configured at all, so a newly onboarded app works
 * end to end immediately. Kept in sync with `RaterCopy.default` on the client.
 */
const FALLBACK: PromptConfigRow = {
  locale: '*',
  min_app_version: '0',
  enabled: 1,
  variant: 'default',
  title: 'Enjoying this app?',
  message: 'Your opinion matters to us — it only takes a few seconds.',
  positive_label: 'I like it',
  negative_label: 'Not quite',
  later_label: 'Maybe later',
  feedback_title: null,
  feedback_message: null,
  categories_json: JSON.stringify([
    { id: 'bug', label: "Something's broken" },
    { id: 'feature', label: 'Feature request' },
    { id: 'other', label: 'Something else' },
  ]),
  email_required: 0,
  rules_json: null,
};

/**
 * Picks the best-matching row: locale specificity first (zh-Hans-CN > zh-Hans > zh > *),
 * then, among equally specific rows, the highest min_app_version.
 */
function pickBest(rows: PromptConfigRow[], version: string, locale: string): PromptConfigRow | null {
  const candidates = [...localeCandidates(locale), '*'];
  const eligible = rows.filter(
    (r) => r.enabled === 1 && compareVersions(r.min_app_version, version) <= 0,
  );

  for (const tag of candidates) {
    const matched = eligible.filter((r) => r.locale.toLowerCase() === tag.toLowerCase());
    if (matched.length === 0) continue;
    return matched.reduce((best, r) =>
      compareVersions(r.min_app_version, best.min_app_version) > 0 ? r : best,
    );
  }
  return null;
}

function parseJSON<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const configRoutes = new Hono<HonoEnv>();

/**
 * GET /v1/config?version=1.2.0&locale=zh-Hans
 *
 * Returns the pre-prompt copy, the feedback categories, and optional trigger-rule
 * overrides. Clients cache this response, hence the ETag — when the copy hasn't changed
 * the client only pays for a 304.
 */
configRoutes.get('/config', requireAppKey, rateLimit('READ_LIMIT'), async (c) => {
  const app = c.get('app');
  const version = c.req.query('version') ?? '0';
  const locale = c.req.query('locale') ?? '*';

  const { results } = await c.env.DB.prepare(
    `SELECT locale, min_app_version, enabled, variant, title, message,
            positive_label, negative_label, later_label,
            feedback_title, feedback_message, categories_json, email_required, rules_json
       FROM prompt_configs WHERE app_id = ?`,
  )
    .bind(app.id)
    .all<PromptConfigRow>();

  const rows = results ?? [];
  // Nothing configured at all → serve the fallback. Rows exist but none match this
  // version/locale → treat it as a deliberate opt-out and report enabled: false.
  const best = pickBest(rows, version, locale);
  const row = best ?? (rows.length === 0 ? FALLBACK : null);

  const payload = {
    enabled: row !== null,
    variant: row?.variant ?? 'none',
    app_store_id: app.app_store_id,
    prompt: row
      ? {
          title: row.title,
          message: row.message,
          positive_label: row.positive_label,
          negative_label: row.negative_label,
          later_label: row.later_label,
        }
      : null,
    feedback: row
      ? {
          title: row.feedback_title,
          message: row.feedback_message,
          categories: parseJSON<{ id: string; label: string }[]>(row.categories_json, []),
          email_required: row.email_required === 1,
        }
      : null,
    rules: row ? parseJSON<Record<string, number> | null>(row.rules_json, null) : null,
  };

  const etag = `"${(await sha256Hex(JSON.stringify(payload))).slice(0, 32)}"`;
  if (c.req.header('If-None-Match') === etag) {
    return c.body(null, 304, { ETag: etag, 'Cache-Control': 'public, max-age=900' });
  }

  return c.json(payload, 200, { ETag: etag, 'Cache-Control': 'public, max-age=900' });
});
