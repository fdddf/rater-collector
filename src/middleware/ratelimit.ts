import { createMiddleware } from 'hono/factory';
import { Errors } from '../lib/errors';
import type { HonoEnv } from '../types';

/**
 * Rate limits on `<client IP>:<app id>`, plus the reporter on conversation routes.
 *
 * The reporter is in the key so that people behind one carrier-grade NAT, all polling an
 * open conversation, don't spend a single shared quota. It doesn't make the limit easier to
 * dodge: a token is free to mint, but so is a fresh IP for anyone determined enough.
 *
 * Local `wrangler dev` and some test environments don't always inject the ratelimit
 * binding, so this degrades softly: a missing binding lets the request through rather
 * than 500ing.
 */
export function rateLimit(binding: 'SUBMIT_LIMIT' | 'READ_LIMIT' | 'MESSAGE_LIMIT') {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const limiter = c.env[binding];
    if (!limiter?.limit) return next();

    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
    const appID = c.get('app')?.id ?? c.req.query('app_id') ?? 'anonymous';

    const reporter = c.get('reporter');
    const key = reporter ? `${ip}:${appID}:${reporter}` : `${ip}:${appID}`;

    const { success } = await limiter.limit({ key });
    if (!success) throw Errors.rateLimited();

    await next();
  });
}
