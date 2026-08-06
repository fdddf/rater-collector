import { Hono } from 'hono';
import { requireAppKey } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import { newID } from '../lib/crypto';
import { Errors } from '../lib/errors';
import { telemetryBatchSchema } from '../lib/schemas';
import { LIMITS, type HonoEnv } from '../types';

export const telemetryRoutes = new Hono<HonoEnv>();

/**
 * POST /v1/telemetry — batched reporting of prompt funnel events.
 *
 * The client flushes once a batch fills up or on the next launch, so this is a batch-only
 * endpoint. Events carry no user identifier; they exist purely so the console can compute
 * the shown → positive/negative → submitted conversion rate and inform trigger tuning.
 */
telemetryRoutes.post('/telemetry', requireAppKey, rateLimit('READ_LIMIT'), async (c) => {
  const app = c.get('app');

  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (declared > LIMITS.jsonBodyBytes) {
    throw Errors.payloadTooLarge(`Request body must not exceed ${LIMITS.jsonBodyBytes} bytes.`);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw Errors.badRequest('Request body is not valid JSON.');
  }

  const parsed = telemetryBatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw Errors.badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  const now = Date.now();
  const statements = parsed.data.events.map((e) =>
    c.env.DB.prepare(
      'INSERT INTO telemetry (id, app_id, created_at, kind, app_version, variant, locale) VALUES (?,?,?,?,?,?,?)',
    ).bind(newID('tl'), app.id, now, e.kind, e.app_version ?? null, e.variant ?? null, e.locale ?? null),
  );

  await c.env.DB.batch(statements);
  return c.json({ accepted: statements.length });
});
