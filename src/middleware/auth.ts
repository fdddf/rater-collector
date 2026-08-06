import { createMiddleware } from 'hono/factory';
import { sha256Hex, timingSafeEqual } from '../lib/crypto';
import { Errors } from '../lib/errors';
import type { AppRecord, HonoEnv } from '../types';

/**
 * Client authentication: `X-Rater-Key: rtr_pub_xxx`.
 *
 * The key ships inside the app binary, so it is not a secret — it only attributes
 * traffic to an app and lets an abused key be revoked. Actual abuse protection comes
 * from the rateLimit middleware and the size caps.
 */
export const requireAppKey = createMiddleware<HonoEnv>(async (c, next) => {
  const key = c.req.header('X-Rater-Key');
  if (!key) throw Errors.unauthorized();

  const hash = await sha256Hex(key);
  const app = await c.env.DB.prepare(
    'SELECT id, name, app_store_id, enabled FROM apps WHERE api_key_hash = ?',
  )
    .bind(hash)
    .first<AppRecord>();

  if (!app) throw Errors.unauthorized();
  if (!app.enabled) throw Errors.forbidden('This app has been disabled.');

  c.set('app', app);
  await next();
});

/** Admin authentication: `Authorization: Bearer <ADMIN_TOKEN>`, or the `rater_admin` cookie. */
export const requireAdmin = createMiddleware<HonoEnv>(async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) throw Errors.forbidden('ADMIN_TOKEN is not configured on the server.');

  const header = c.req.header('Authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const cookie = readCookie(c.req.header('Cookie'), 'rater_admin') ?? '';
  const supplied = bearer || cookie;

  if (!supplied || !timingSafeEqual(supplied, expected)) {
    throw Errors.unauthorized('Incorrect admin password.');
  }
  await next();
});

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
