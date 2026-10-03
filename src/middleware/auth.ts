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

/**
 * The SDK's per-install reporter token: 32 random bytes, base64url. The bounds leave room
 * for a longer token later without letting a header of arbitrary size through.
 */
const REPORTER_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/** Hashes a well-formed `X-Rater-Reporter` header, or returns null for a missing or malformed one. */
export async function reporterHash(header: string | undefined): Promise<string | null> {
  if (!header || !REPORTER_TOKEN.test(header)) return null;
  return sha256Hex(header);
}

/**
 * Conversation endpoints: `X-Rater-Reporter: <token>`, after `requireAppKey`.
 *
 * The app key says which app is calling and nothing about who — anyone can lift it out of
 * the binary. Owning a thread is proved by the reporter token instead: a random secret the
 * SDK generated on this device and has sent with every feedback since. Like app keys, D1
 * keeps only its SHA-256, so a database leak doesn't hand out read access to every thread.
 */
export const requireReporter = createMiddleware<HonoEnv>(async (c, next) => {
  const hash = await reporterHash(c.req.header('X-Rater-Reporter'));
  if (!hash) throw Errors.unauthorized('Missing or malformed X-Rater-Reporter token.');
  c.set('reporter', hash);
  await next();
});
