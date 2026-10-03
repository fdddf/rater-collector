import { Hono } from 'hono';
import { requireAppKey, requireReporter } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import { newID } from '../lib/crypto';
import { Errors } from '../lib/errors';
import { deleteFeedback, MESSAGE_COLUMNS, type MessageRow } from '../lib/feedback';
import { notifyNewFeedback } from '../lib/notify';
import { threadMessageSchema, threadReadSchema } from '../lib/schemas';
import type { HonoEnv } from '../types';

/**
 * In-app conversations — the user's side.
 *
 * A thread is a feedback the caller's reporter token sent, plus the messages after it.
 * Every query is scoped by (app_id, reporter_hash), and a thread outside that scope is a
 * plain 404, the same as one that doesn't exist, so ids can't be probed.
 *
 * Spam stays out of the list and can't be written to. Feedback that never completed
 * isn't a thread yet either — the user saw an error, not a sent message.
 *
 * Clients poll: `GET /threads/:id?after=<seq>` while a conversation is on screen, and
 * `GET /inbox` for the unread badge.
 */
export const threadRoutes = new Hono<HonoEnv>();

/** Only the user-facing states: the console's pending / open distinction is internal. */
const userStatus = (status: string) => (status === 'resolved' ? 'resolved' : 'open');

const VISIBLE = "f.completed_at IS NOT NULL AND f.status != 'spam'";

const PREVIEW_CHARS = 140;

interface ThreadRow {
  id: string;
  created_at: number;
  last_message_at: number;
  status: string;
  category: string | null;
  message: string;
  attachment_count: number;
  last_author: 'user' | 'admin' | null;
  last_body: string | null;
  unread_count: number;
}

const THREAD_SELECT = `
  SELECT f.id, f.created_at, COALESCE(f.last_message_at, f.created_at) AS last_message_at,
         f.status, f.category, f.message, f.attachment_count,
         (SELECT m.author FROM feedback_messages m WHERE m.feedback_id = f.id
           ORDER BY m.seq DESC LIMIT 1) AS last_author,
         (SELECT m.body FROM feedback_messages m WHERE m.feedback_id = f.id
           ORDER BY m.seq DESC LIMIT 1) AS last_body,
         (SELECT COUNT(*) FROM feedback_messages m WHERE m.feedback_id = f.id
           AND m.author = 'admin' AND m.seq > f.user_read_seq) AS unread_count
    FROM feedback f`;

function summarize(row: ThreadRow) {
  const latest = row.last_body ?? row.message;
  return {
    id: row.id,
    created_at: row.created_at,
    last_message_at: row.last_message_at,
    status: userStatus(row.status),
    category: row.category,
    preview: latest.length > PREVIEW_CHARS ? `${latest.slice(0, PREVIEW_CHARS)}…` : latest,
    // Who spoke last — the feedback itself counts as the user's.
    last_author: row.last_author ?? 'user',
    unread_count: row.unread_count,
  };
}

/** GET /v1/threads — the caller's feedback, most recent activity first. */
threadRoutes.get('/threads', requireAppKey, requireReporter, rateLimit('READ_LIMIT'), async (c) => {
  const app = c.get('app');
  const limit = Math.min(Number(c.req.query('limit') ?? 30) || 30, 100);
  // Cursor: the previous page's last last_message_at.
  const before = Number(c.req.query('before') ?? 0) || null;

  const args: unknown[] = [app.id, c.get('reporter')];
  let cursor = '';
  if (before) {
    cursor = 'AND COALESCE(f.last_message_at, f.created_at) < ?';
    args.push(before);
  }
  args.push(limit);

  const { results } = await c.env.DB.prepare(
    `${THREAD_SELECT}
      WHERE f.app_id = ? AND f.reporter_hash = ? AND ${VISIBLE} ${cursor}
      ORDER BY COALESCE(f.last_message_at, f.created_at) DESC LIMIT ?`,
  )
    .bind(...args)
    .all<ThreadRow>();

  const items = (results ?? []).map(summarize);
  const last = items.at(-1);
  return c.json({
    items,
    next_before: items.length === limit && last ? last.last_message_at : null,
  });
});

/**
 * GET /v1/threads/:id — one conversation.
 *
 * With `after=<seq>`, only the messages past that cursor: what a client polling an open
 * conversation asks for. The thread header comes back every time — it's one row, and it
 * carries the status, which the console can change between polls.
 */
threadRoutes.get('/threads/:id', requireAppKey, requireReporter, rateLimit('READ_LIMIT'), async (c) => {
  const app = c.get('app');
  const id = c.req.param('id');
  const after = Math.max(Number(c.req.query('after') ?? 0) || 0, 0);

  const row = await c.env.DB.prepare(
    `${THREAD_SELECT} WHERE f.id = ? AND f.app_id = ? AND f.reporter_hash = ? AND ${VISIBLE}`,
  )
    .bind(id, app.id, c.get('reporter'))
    .first<ThreadRow>();
  if (!row) throw Errors.notFound('No such thread.');

  const { results } = await c.env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM feedback_messages
      WHERE feedback_id = ? AND seq > ? ORDER BY seq`,
  )
    .bind(id, after)
    .all<MessageRow>();

  return c.json({
    thread: {
      ...summarize(row),
      // The opening message in full; `preview` is only the latest one, cut short.
      message: row.message,
      attachment_count: row.attachment_count,
    },
    messages: results ?? [],
  });
});

/**
 * POST /v1/threads/:id/messages — the user writes back.
 *
 * Idempotent on (thread, idempotency_key), like submissions: the SDK queues a message that
 * failed to send and replays it later, so a resend must not post it twice. A reply to a
 * resolved thread reopens it — the user evidently isn't done.
 */
threadRoutes.post('/threads/:id/messages', requireAppKey, requireReporter, rateLimit('MESSAGE_LIMIT'), async (c) => {
  const app = c.get('app');
  const id = c.req.param('id');

  const parsed = threadMessageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw Errors.badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const { idempotency_key, body } = parsed.data;

  const thread = await c.env.DB.prepare(
    `SELECT f.id, f.category, f.email, f.app_version, f.device_model, f.os_version,
            f.ip_country, f.attachment_count
       FROM feedback f
      WHERE f.id = ? AND f.app_id = ? AND f.reporter_hash = ? AND ${VISIBLE}`,
  )
    .bind(id, app.id, c.get('reporter'))
    .first<{
      id: string;
      category: string | null;
      email: string | null;
      app_version: string | null;
      device_model: string | null;
      os_version: string | null;
      ip_country: string | null;
      attachment_count: number;
    }>();
  if (!thread) throw Errors.notFound('No such thread.');

  const now = Date.now();
  // DO NOTHING + RETURNING yields no row on a repeat key, which is how a duplicate shows
  // itself without a separate lookup racing a concurrent resend.
  const inserted = await c.env.DB.prepare(
    `INSERT INTO feedback_messages (id, feedback_id, author, body, idempotency_key, created_at)
     VALUES (?, ?, 'user', ?, ?, ?)
     ON CONFLICT (feedback_id, idempotency_key) DO NOTHING
     RETURNING ${MESSAGE_COLUMNS}`,
  )
    .bind(newID('msg'), id, body, idempotency_key, now)
    .first<MessageRow>();

  if (!inserted) {
    const existing = await c.env.DB.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM feedback_messages WHERE feedback_id = ? AND idempotency_key = ?`,
    )
      .bind(id, idempotency_key)
      .first<MessageRow>();
    return c.json({ message: existing, duplicate: true });
  }

  await c.env.DB.prepare(
    `UPDATE feedback
        SET last_message_at = ?,
            status = CASE status WHEN 'resolved' THEN 'open' ELSE status END
      WHERE id = ?`,
  )
    .bind(now, id)
    .run();

  c.executionCtx.waitUntil(
    notifyNewFeedback(c.env, {
      kind: 'reply',
      appName: app.name,
      appID: app.id,
      feedbackID: id,
      category: thread.category,
      message: body,
      email: thread.email,
      appVersion: thread.app_version,
      deviceModel: thread.device_model,
      osVersion: thread.os_version,
      attachmentCount: 0,
      country: thread.ip_country,
    }),
  );

  return c.json({ message: inserted, duplicate: false }, 201);
});

/**
 * POST /v1/threads/:id/read — moves the user's read marker up to `seq`.
 *
 * The marker is a seq the client has actually rendered rather than "now", so a message
 * that lands between the client's fetch and this call still counts as unread. It only
 * moves forward, and never past the newest message, so a stray value can't silence
 * messages that haven't been written yet.
 */
threadRoutes.post('/threads/:id/read', requireAppKey, requireReporter, rateLimit('READ_LIMIT'), async (c) => {
  const app = c.get('app');
  const id = c.req.param('id');

  const parsed = threadReadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw Errors.badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  const res = await c.env.DB.prepare(
    `UPDATE feedback AS f
        SET user_read_seq = MAX(f.user_read_seq, MIN(?,
              (SELECT COALESCE(MAX(m.seq), 0) FROM feedback_messages m WHERE m.feedback_id = f.id)))
      WHERE f.id = ? AND f.app_id = ? AND f.reporter_hash = ? AND ${VISIBLE}`,
  )
    .bind(parsed.data.seq, id, app.id, c.get('reporter'))
    .run();
  if (res.meta.changes === 0) throw Errors.notFound('No such thread.');

  return c.json({ ok: true });
});

/**
 * DELETE /v1/threads — erases everything this reporter sent: the feedback, the
 * conversations, the screenshots. The in-app "delete my history" path; the SDK forgets
 * its token afterwards.
 *
 * Includes incomplete and spam rows, which the list never showed: the user asked for
 * their data to go, not for the visible part of it to go.
 */
threadRoutes.delete('/threads', requireAppKey, requireReporter, rateLimit('SUBMIT_LIMIT'), async (c) => {
  const app = c.get('app');
  const { results } = await c.env.DB.prepare(
    'SELECT id FROM feedback WHERE app_id = ? AND reporter_hash = ?',
  )
    .bind(app.id, c.get('reporter'))
    .all<{ id: string }>();

  const deleted = await deleteFeedback(c.env, (results ?? []).map((r) => r.id));
  return c.json({ ok: true, deleted });
});

/** GET /v1/inbox — what the host app's badge shows. Cheap enough to call on every foreground. */
threadRoutes.get('/inbox', requireAppKey, requireReporter, rateLimit('READ_LIMIT'), async (c) => {
  const app = c.get('app');
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS unread_count, COUNT(DISTINCT f.id) AS unread_threads
       FROM feedback f JOIN feedback_messages m ON m.feedback_id = f.id
      WHERE f.app_id = ? AND f.reporter_hash = ? AND ${VISIBLE}
        AND m.author = 'admin' AND m.seq > f.user_read_seq`,
  )
    .bind(app.id, c.get('reporter'))
    .first<{ unread_count: number; unread_threads: number }>();

  return c.json({
    unread_count: row?.unread_count ?? 0,
    unread_threads: row?.unread_threads ?? 0,
  });
});
