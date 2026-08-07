import { Hono } from 'hono';
import { requireAdmin } from '../middleware/auth';
import { newID, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { Errors } from '../lib/errors';
import {
  feedbackBulkDeleteSchema,
  feedbackPatchSchema,
  promptConfigUpsertSchema,
  promptTranslateSchema,
} from '../lib/schemas';
import {
  translateConfig,
  translateConfigured,
  translateCopy,
  type TranslatableCopy,
} from '../lib/translate';
import { dashboardHTML } from '../admin/dashboard';
import type { HonoEnv } from '../types';

export const adminRoutes = new Hono<HonoEnv>();

/** The console itself. The page trades the password for a cookie on its own, so this HTML is unguarded. */
adminRoutes.get('/', (c) => c.html(dashboardHTML));

/**
 * Trades ADMIN_TOKEN for an HttpOnly cookie, so the frontend doesn't have to attach a
 * header to every request.
 *
 * Login/logout must live on adminRoutes rather than the protected `api` instance below —
 * they exist precisely for callers who aren't authenticated yet. Registering them before
 * `adminRoutes.route('/api', api)` makes them match first.
 */
adminRoutes.post('/api/login', async (c) => {
  const { token } = await c.req
    .json<{ token?: string }>()
    .catch((): { token?: string } => ({}));
  if (!token || !c.env.ADMIN_TOKEN || !timingSafeEqual(token, c.env.ADMIN_TOKEN)) {
    throw Errors.unauthorized('Incorrect password.');
  }
  const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : '';
  return c.json(
    { ok: true },
    200,
    {
      'Set-Cookie': `rater_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure}`,
    },
  );
});

adminRoutes.post('/api/logout', (c) =>
  c.json({ ok: true }, 200, { 'Set-Cookie': 'rater_admin=; Path=/; HttpOnly; Max-Age=0' }),
);

/**
 * The authenticated admin API. A separate instance so `requireAdmin` can be applied once,
 * then mounted wholesale under `/api`.
 *
 * Login/logout were registered above and Hono matches in registration order, so they never
 * hit this guard.
 */
const api = new Hono<HonoEnv>();
api.use('*', requireAdmin);

/** Server capabilities the console has to know about before it can render — currently just whether the translator has an API key. */
api.get('/settings', (c) => c.json({ translate_enabled: translateConfigured(c.env) }));

// ── Apps ─────────────────────────────────────────────────────────────────────

api.get('/apps', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, app_store_id, enabled, created_at FROM apps ORDER BY created_at DESC',
  ).all();
  return c.json({ apps: results ?? [] });
});

/** Registers a new app. The plaintext API key is returned here once and only here — the database keeps only its SHA-256. */
api.post('/apps', async (c) => {
  type NewApp = { id?: string; name?: string; app_store_id?: string };
  const body = await c.req.json<NewApp>().catch((): NewApp => ({}));
  const name = body.name?.trim();
  if (!name) throw Errors.badRequest('name is required.');

  const id = (body.id?.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw Errors.badRequest('id may contain only lowercase letters, digits and hyphens.');
  }

  const exists = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?').bind(id).first();
  if (exists) throw Errors.badRequest(`App id "${id}" already exists.`);

  // The `rtr_pub_` prefix is deliberate on both counts. `pub` because this key ships
  // inside the app binary and is not a secret — see requireAppKey. And it stays clear
  // of Stripe's restricted-key prefix, which an earlier version of this line matched:
  // a key in that shape trips GitHub's secret scanner, blocking any push that carries
  // it with a misleading warning about leaked Stripe credentials.
  const apiKey = `rtr_pub_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  await c.env.DB.prepare(
    'INSERT INTO apps (id, name, app_store_id, api_key_hash, enabled, created_at) VALUES (?,?,?,?,1,?)',
  )
    .bind(id, name, body.app_store_id?.trim() || null, await sha256Hex(apiKey), Date.now())
    .run();

  return c.json({ id, name, app_store_id: body.app_store_id ?? null, api_key: apiKey }, 201);
});

api.patch('/apps/:id', async (c) => {
  type AppPatch = { name?: string; app_store_id?: string | null; enabled?: boolean };
  const body = await c.req.json<AppPatch>().catch((): AppPatch => ({}));

  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.name !== undefined) (sets.push('name = ?'), args.push(body.name));
  if (body.app_store_id !== undefined) (sets.push('app_store_id = ?'), args.push(body.app_store_id));
  if (body.enabled !== undefined) (sets.push('enabled = ?'), args.push(body.enabled ? 1 : 0));
  if (sets.length === 0) throw Errors.badRequest('At least one field must be provided.');

  args.push(c.req.param('id'));
  const res = await c.env.DB.prepare(`UPDATE apps SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...args)
    .run();
  if (res.meta.changes === 0) throw Errors.notFound('No such app.');
  return c.json({ ok: true });
});

/**
 * Clears the prompt funnel for one app.
 *
 * Telemetry only. The Stats page also charts feedback volume, but feedback is real user
 * writing — throwing it away is a separate, deliberate act (DELETE /feedback/:id), not a
 * side effect of resetting a counter.
 */
api.post('/apps/:id/reset-stats', async (c) => {
  const appID = c.req.param('id');
  const app = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?').bind(appID).first();
  if (!app) throw Errors.notFound('No such app.');

  const res = await c.env.DB.prepare('DELETE FROM telemetry WHERE app_id = ?').bind(appID).run();
  return c.json({ ok: true, deleted: res.meta.changes });
});

// ── Prompt configs (server-side copy) ─────────────────────────────────────────

api.get('/apps/:id/prompts', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM prompt_configs WHERE app_id = ? ORDER BY locale, min_app_version',
  )
    .bind(c.req.param('id'))
    .all();

  const prompts = (results ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      ...row,
      enabled: row.enabled === 1,
      email_required: row.email_required === 1,
      categories: safeParse(row.categories_json as string, []),
      rules: safeParse(row.rules_json as string | null, null),
    };
  });
  return c.json({ prompts });
});

/** Upserts on (app_id, locale, min_app_version) — a copy edit takes effect for every client at once. */
api.put('/apps/:id/prompts', async (c) => {
  const appID = c.req.param('id');
  const app = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?').bind(appID).first();
  if (!app) throw Errors.notFound('No such app.');

  const parsed = promptConfigUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw Errors.badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const p = parsed.data;

  await c.env.DB.prepare(
    `INSERT INTO prompt_configs (
       id, app_id, locale, min_app_version, enabled, variant, title, message,
       positive_label, negative_label, later_label, feedback_title, feedback_message,
       categories_json, email_required, rules_json, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(app_id, locale, min_app_version) DO UPDATE SET
       enabled = excluded.enabled, variant = excluded.variant,
       title = excluded.title, message = excluded.message,
       positive_label = excluded.positive_label, negative_label = excluded.negative_label,
       later_label = excluded.later_label, feedback_title = excluded.feedback_title,
       feedback_message = excluded.feedback_message, categories_json = excluded.categories_json,
       email_required = excluded.email_required, rules_json = excluded.rules_json,
       updated_at = excluded.updated_at`,
  )
    .bind(
      newID('pc'),
      appID,
      p.locale,
      p.min_app_version,
      p.enabled ? 1 : 0,
      p.variant,
      p.title,
      p.message,
      p.positive_label,
      p.negative_label,
      p.later_label,
      p.feedback_title || null,
      p.feedback_message || null,
      JSON.stringify(p.categories),
      p.email_required ? 1 : 0,
      p.rules ? JSON.stringify(p.rules) : null,
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
});

/**
 * Machine-translates one draft into several locales and hands the results back *without*
 * saving them. Copy is the first thing a user reads, so a human approves it in the editor
 * before it reaches `prompt_configs`.
 *
 * Locales are translated concurrently and settled independently — one provider hiccup
 * shouldn't discard eleven good translations.
 */
api.post('/apps/:id/prompts/translate', async (c) => {
  const appID = c.req.param('id');
  const app = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?').bind(appID).first();
  if (!app) throw Errors.notFound('No such app.');

  // Before the fan-out below, so a missing key is one 400 naming the variable rather than
  // a 200 carrying the same failure once per locale.
  const config = translateConfig(c.env);

  const parsed = promptTranslateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw Errors.badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const { source, target_locales } = parsed.data;

  const copy: TranslatableCopy = {
    title: source.title,
    message: source.message,
    positive_label: source.positive_label,
    negative_label: source.negative_label,
    later_label: source.later_label,
    feedback_title: source.feedback_title ?? '',
    feedback_message: source.feedback_message ?? '',
    category_labels: source.categories.map((cat) => cat.label),
  };

  const locales = [...new Set(target_locales)];
  const settled = await Promise.allSettled(locales.map((l) => translateCopy(config, copy, l)));

  const prompts = [];
  const errors: { locale: string; message: string }[] = [];
  for (const [i, outcome] of settled.entries()) {
    const locale = locales[i]!;
    if (outcome.status === 'rejected') {
      const reason = outcome.reason as unknown;
      errors.push({
        locale,
        message: reason instanceof Error ? reason.message : String(reason),
      });
      continue;
    }
    const t = outcome.value;
    prompts.push({
      locale,
      min_app_version: source.min_app_version,
      enabled: source.enabled,
      variant: source.variant,
      title: t.title,
      message: t.message,
      positive_label: t.positive_label,
      negative_label: t.negative_label,
      later_label: t.later_label,
      feedback_title: t.feedback_title || null,
      feedback_message: t.feedback_message || null,
      // Ids are the client's lookup keys and are never translated — only the labels move.
      categories: source.categories.map((cat, idx) => ({
        id: cat.id,
        label: t.category_labels[idx] ?? cat.label,
      })),
      email_required: source.email_required,
      rules: source.rules ?? null,
    });
  }

  return c.json({ prompts, errors });
});

api.delete('/prompts/:pid', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM prompt_configs WHERE id = ?')
    .bind(c.req.param('pid'))
    .run();
  if (res.meta.changes === 0) throw Errors.notFound('No such prompt config.');
  return c.json({ ok: true });
});

// ── Feedback ─────────────────────────────────────────────────────────────────

api.get('/feedback', async (c) => {
  const appID = c.req.query('app_id');
  const status = c.req.query('status');
  const q = c.req.query('q');
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  // The cursor is the previous page's last created_at, paging along the
  // (app_id, created_at DESC) index.
  const before = Number(c.req.query('before') ?? 0) || null;

  const where: string[] = ['completed_at IS NOT NULL'];
  const args: unknown[] = [];
  if (appID) (where.push('f.app_id = ?'), args.push(appID));
  if (status) (where.push('f.status = ?'), args.push(status));
  if (q) (where.push('(f.message LIKE ? OR f.email LIKE ?)'), args.push(`%${q}%`, `%${q}%`));
  if (before) (where.push('f.created_at < ?'), args.push(before));
  args.push(limit);

  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.app_id, a.name AS app_name, f.created_at, f.status, f.category,
            f.message, f.email, f.app_version, f.device_model, f.os_version,
            f.ip_country, f.attachment_count
       FROM feedback f JOIN apps a ON a.id = f.app_id
      WHERE ${where.join(' AND ')}
      ORDER BY f.created_at DESC LIMIT ?`,
  )
    .bind(...args)
    .all();

  const items = results ?? [];
  const last = items.at(-1) as { created_at: number } | undefined;
  return c.json({
    items,
    next_before: items.length === limit && last ? last.created_at : null,
  });
});

api.get('/feedback/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT f.*, a.name AS app_name FROM feedback f JOIN apps a ON a.id = f.app_id WHERE f.id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw Errors.notFound('No such feedback.');

  const { results } = await c.env.DB.prepare(
    'SELECT idx, r2_key, content_type, bytes FROM attachments WHERE feedback_id = ? ORDER BY idx',
  )
    .bind(id)
    .all();

  return c.json({
    feedback: { ...row, metadata: safeParse(row.metadata_json as string | null, null) },
    attachments: results ?? [],
  });
});

api.patch('/feedback/:id', async (c) => {
  const parsed = feedbackPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw Errors.badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  const sets: string[] = [];
  const args: unknown[] = [];
  if (parsed.data.status !== undefined) (sets.push('status = ?'), args.push(parsed.data.status));
  if (parsed.data.admin_note !== undefined) (sets.push('admin_note = ?'), args.push(parsed.data.admin_note));
  args.push(c.req.param('id'));

  const res = await c.env.DB.prepare(`UPDATE feedback SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...args)
    .run();
  if (res.meta.changes === 0) throw Errors.notFound('No such feedback.');
  return c.json({ ok: true });
});

api.delete('/feedback/:id', async (c) => {
  const deleted = await deleteFeedback(c.env, [c.req.param('id')]);
  if (deleted === 0) throw Errors.notFound('No such feedback.');
  return c.json({ ok: true, deleted });
});

/** Bulk delete, so clearing out a spam wave doesn't mean a hundred round trips. */
api.post('/feedback/bulk-delete', async (c) => {
  const parsed = feedbackBulkDeleteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw Errors.badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return c.json({ ok: true, deleted: await deleteFeedback(c.env, parsed.data.ids) });
});

/**
 * Deletes feedback rows and the screenshots behind them.
 *
 * Order matters: the R2 keys only exist in the `attachments` rows, so they have to be
 * read and the objects dropped *before* the rows go — reversing it strands the images in
 * the bucket with nothing left pointing at them.
 */
async function deleteFeedback(env: HonoEnv['Bindings'], ids: string[]): Promise<number> {
  const placeholders = ids.map(() => '?').join(',');

  const { results } = await env.DB.prepare(
    `SELECT r2_key FROM attachments WHERE feedback_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ r2_key: string }>();

  const keys = (results ?? []).map((r) => r.r2_key);
  if (keys.length > 0) await env.ATTACHMENTS.delete(keys);

  // ON DELETE CASCADE would cover the attachment rows, but foreign-key enforcement is a
  // database setting rather than something this code controls — so say it explicitly.
  await env.DB.prepare(`DELETE FROM attachments WHERE feedback_id IN (${placeholders})`)
    .bind(...ids)
    .run();

  const res = await env.DB.prepare(`DELETE FROM feedback WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
  return res.meta.changes;
}

/** Serves the original image from R2. Keys contain slashes, hence the wildcard route. */
api.get('/attachments/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const object = await c.env.ATTACHMENTS.get(key);
  if (!object) throw Errors.notFound('No such attachment.');

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

// ── Stats ────────────────────────────────────────────────────────────────────

/** Prompt conversion funnel plus feedback volume — the signal for whether the trigger timing is right. */
api.get('/stats', async (c) => {
  const appID = c.req.query('app_id');
  const days = Math.min(Number(c.req.query('days') ?? 30) || 30, 365);
  const since = Date.now() - days * 86400_000;

  const appFilter = appID ? 'AND app_id = ?' : '';
  const bind = (extra: unknown[] = []) => (appID ? [since, appID, ...extra] : [since, ...extra]);

  const { results: funnel } = await c.env.DB.prepare(
    `SELECT kind, COUNT(*) AS n FROM telemetry WHERE created_at >= ? ${appFilter} GROUP BY kind`,
  )
    .bind(...bind())
    .all<{ kind: string; n: number }>();

  const { results: byStatus } = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM feedback
      WHERE created_at >= ? ${appFilter} AND completed_at IS NOT NULL GROUP BY status`,
  )
    .bind(...bind())
    .all<{ status: string; n: number }>();

  const { results: daily } = await c.env.DB.prepare(
    `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
       FROM feedback WHERE created_at >= ? ${appFilter} AND completed_at IS NOT NULL
      GROUP BY day ORDER BY day`,
  )
    .bind(...bind())
    .all<{ day: string; n: number }>();

  const counts = Object.fromEntries((funnel ?? []).map((r) => [r.kind, r.n]));
  const shown = counts.shown ?? 0;
  return c.json({
    days,
    funnel: {
      shown,
      positive: counts.positive ?? 0,
      negative: counts.negative ?? 0,
      dismissed: counts.dismissed ?? 0,
      submitted: counts.submitted ?? 0,
      positive_rate: shown ? (counts.positive ?? 0) / shown : null,
      negative_rate: shown ? (counts.negative ?? 0) / shown : null,
    },
    feedback_by_status: Object.fromEntries((byStatus ?? []).map((r) => [r.status, r.n])),
    feedback_daily: daily ?? [],
  });
});

adminRoutes.route('/api', api);

function safeParse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
