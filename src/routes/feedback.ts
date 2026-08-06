import { Hono } from 'hono';
import { requireAppKey } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import { newID, signUploadToken, verifyUploadToken } from '../lib/crypto';
import { Errors } from '../lib/errors';
import { feedbackSubmissionSchema } from '../lib/schemas';
import { notifyNewFeedback } from '../lib/notify';
import { LIMITS, type HonoEnv } from '../types';

export const feedbackRoutes = new Hono<HonoEnv>();

/**
 * POST /v1/feedback — step one of the three-step submission.
 *
 * The written content is persisted first to get an id, then a short-lived upload token
 * is issued for the screenshots. That way the message is safely stored even if the user
 * loses connectivity while uploading attachments.
 *
 * Idempotent: resubmitting the same (app_id, idempotency_key) returns the same record.
 * Together with the client's offline retry queue, flaky networks can't produce duplicates.
 */
feedbackRoutes.post('/feedback', requireAppKey, rateLimit('SUBMIT_LIMIT'), async (c) => {
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

  const parsed = feedbackSubmissionSchema.safeParse(raw);
  if (!parsed.success) {
    throw Errors.badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const body = parsed.data;

  // On an idempotency hit, reuse the existing record.
  const existing = await c.env.DB.prepare(
    'SELECT id, attachment_count, completed_at FROM feedback WHERE app_id = ? AND idempotency_key = ?',
  )
    .bind(app.id, body.idempotency_key)
    .first<{ id: string; attachment_count: number; completed_at: number | null }>();

  const now = Date.now();
  let feedbackID: string;

  if (existing) {
    feedbackID = existing.id;
  } else {
    feedbackID = newID('fb');
    const d = body.device;
    await c.env.DB.prepare(
      `INSERT INTO feedback (
         id, app_id, created_at, status, category, message, email,
         app_version, build, bundle_id, os_version, device_model,
         locale, region, timezone, install_days, launch_count,
         metadata_json, ip_country, idempotency_key, attachment_count
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        feedbackID,
        app.id,
        now,
        'pending',
        body.category ?? null,
        body.message,
        body.email ?? null,
        d.app_version ?? null,
        d.build ?? null,
        d.bundle_id ?? null,
        d.os_version ?? null,
        d.device_model ?? null,
        d.locale ?? null,
        d.region ?? null,
        d.timezone ?? null,
        d.install_days ?? null,
        d.launch_count ?? null,
        body.metadata ? JSON.stringify(body.metadata) : null,
        (c.req.raw.cf?.country as string | undefined) ?? null,
        body.idempotency_key,
        body.attachment_count,
      )
      .run();
  }

  const expiresAt = Math.floor(now / 1000) + LIMITS.uploadTokenTTL;
  const uploadToken =
    body.attachment_count > 0
      ? await signUploadToken(c.env.UPLOAD_HMAC_SECRET, {
          fid: feedbackID,
          aid: app.id,
          n: body.attachment_count,
          exp: expiresAt,
        })
      : null;

  return c.json(
    {
      id: feedbackID,
      upload_token: uploadToken,
      expires_at: expiresAt,
      max_attachment_bytes: LIMITS.attachmentBytes,
      duplicate: existing !== null,
    },
    existing ? 200 : 201,
  );
});

/**
 * PUT /v1/feedback/:id/attachments/:idx — step two, uploading a single screenshot.
 *
 * Proxied through the Worker rather than a presigned R2 URL: screenshots are already
 * compressed to under 2MB, and proxying avoids maintaining S3 credentials on both the
 * client and the Worker while giving size/type validation one place to live.
 */
feedbackRoutes.put('/feedback/:id/attachments/:idx', async (c) => {
  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) throw Errors.unauthorized('Missing upload token.');

  const claims = await verifyUploadToken(c.env.UPLOAD_HMAC_SECRET, auth.slice(7));
  if (!claims) throw Errors.unauthorized('Upload token is invalid or has expired.');

  const feedbackID = c.req.param('id');
  if (claims.fid !== feedbackID) throw Errors.forbidden('Token does not match this feedback.');

  const idx = Number.parseInt(c.req.param('idx'), 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= claims.n) {
    throw Errors.badRequest(`Attachment index must be between 0 and ${claims.n - 1}.`);
  }

  const contentType = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(LIMITS.imageTypes as readonly string[]).includes(contentType)) {
    throw Errors.unsupportedMedia(`Only ${LIMITS.imageTypes.join(' / ')} are accepted.`);
  }

  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (declared > LIMITS.attachmentBytes) {
    throw Errors.payloadTooLarge(`A screenshot must not exceed ${LIMITS.attachmentBytes} bytes.`);
  }

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) throw Errors.badRequest('Attachment body is empty.');
  if (bytes.byteLength > LIMITS.attachmentBytes) {
    throw Errors.payloadTooLarge(`A screenshot must not exceed ${LIMITS.attachmentBytes} bytes.`);
  }

  const month = new Date().toISOString().slice(0, 7); // yyyy-mm
  const ext = contentType.split('/')[1] ?? 'bin';
  const key = `${claims.aid}/${month}/${feedbackID}/${idx}.${ext}`;

  await c.env.ATTACHMENTS.put(key, bytes, { httpMetadata: { contentType } });

  // REPLACE lets a re-upload of the same index overwrite the old row, which is what the
  // client's resumable retry needs.
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO attachments (id, feedback_id, idx, r2_key, content_type, bytes, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(newID('att'), feedbackID, idx, key, contentType, bytes.byteLength, Date.now())
    .run();

  return c.json({ key, bytes: bytes.byteLength });
});

/**
 * POST /v1/feedback/:id/complete — step three, marking it done and pushing the notification.
 *
 * The notification goes out via waitUntil, so the client never waits on the webhook round trip.
 */
feedbackRoutes.post('/feedback/:id/complete', requireAppKey, async (c) => {
  const app = c.get('app');
  const feedbackID = c.req.param('id');

  const row = await c.env.DB.prepare(
    `SELECT id, category, message, email, app_version, device_model, os_version,
            ip_country, completed_at
       FROM feedback WHERE id = ? AND app_id = ?`,
  )
    .bind(feedbackID, app.id)
    .first<{
      id: string;
      category: string | null;
      message: string;
      email: string | null;
      app_version: string | null;
      device_model: string | null;
      os_version: string | null;
      ip_country: string | null;
      completed_at: number | null;
    }>();

  if (!row) throw Errors.notFound('No such feedback.');

  const counted = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM attachments WHERE feedback_id = ?',
  )
    .bind(feedbackID)
    .first<{ n: number }>();
  const attachmentCount = counted?.n ?? 0;

  // Return early on a repeat call so the notification isn't pushed twice.
  if (row.completed_at !== null) {
    return c.json({ id: feedbackID, status: 'completed', attachment_count: attachmentCount });
  }

  await c.env.DB.prepare(
    "UPDATE feedback SET completed_at = ?, status = 'open', attachment_count = ? WHERE id = ?",
  )
    .bind(Date.now(), attachmentCount, feedbackID)
    .run();

  c.executionCtx.waitUntil(
    notifyNewFeedback(c.env, {
      appName: app.name,
      appID: app.id,
      feedbackID,
      category: row.category,
      message: row.message,
      email: row.email,
      appVersion: row.app_version,
      deviceModel: row.device_model,
      osVersion: row.os_version,
      attachmentCount,
      country: row.ip_country,
    }),
  );

  return c.json({ id: feedbackID, status: 'completed', attachment_count: attachmentCount });
});
