import type { Env } from '../types';

/** D1 caps bound parameters per statement at 100, so `IN (…)` lists go out in chunks. */
const DELETE_CHUNK = 100;

/**
 * Deletes feedback rows, their conversations, and the screenshots behind them.
 *
 * Order matters: the R2 keys only exist in the `attachments` rows, so they have to be
 * read and the objects dropped *before* the rows go — reversing it strands the images in
 * the bucket with nothing left pointing at them.
 */
export async function deleteFeedback(env: Env, ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    deleted += await deleteChunk(env, ids.slice(i, i + DELETE_CHUNK));
  }
  return deleted;
}

async function deleteChunk(env: Env, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');

  const { results } = await env.DB.prepare(
    `SELECT r2_key FROM attachments WHERE feedback_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ r2_key: string }>();

  const keys = (results ?? []).map((r) => r.r2_key);
  if (keys.length > 0) await env.ATTACHMENTS.delete(keys);

  // ON DELETE CASCADE would cover the child rows, but foreign-key enforcement is a
  // database setting rather than something this code controls — so say it explicitly.
  for (const table of ['attachments', 'feedback_messages', 'feedback_replies']) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE feedback_id IN (${placeholders})`)
      .bind(...ids)
      .run();
  }

  const res = await env.DB.prepare(`DELETE FROM feedback WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
  return res.meta.changes;
}

/** One message in a conversation, as both the client API and the console return it. */
export interface MessageRow {
  seq: number;
  id: string;
  author: 'user' | 'admin';
  body: string;
  created_at: number;
}

export const MESSAGE_COLUMNS = 'seq, id, author, body, created_at';
