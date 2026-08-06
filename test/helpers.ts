import { env } from 'cloudflare:test';
import { sha256Hex } from '../src/lib/crypto';

export async function resetDatabase(): Promise<void> {
  const tables = ['attachments', 'telemetry', 'feedback', 'prompt_configs', 'apps'];
  for (const table of tables) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

export const TEST_KEY = 'rtr_pub_testkey0000000000000000000000';
export const TEST_APP_ID = 'test-app';
export const ADMIN_TOKEN = 'test-admin-token';

export async function seedApp(
  id = TEST_APP_ID,
  key = TEST_KEY,
  appStoreID: string | null = '123456789',
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO apps (id, name, app_store_id, api_key_hash, enabled, created_at) VALUES (?,?,?,?,1,?)',
  )
    .bind(id, `Test ${id}`, appStoreID, await sha256Hex(key), Date.now())
    .run();
}

/** The smallest valid PNG, used to exercise attachment upload. */
export function tinyPNG(): ArrayBuffer {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export const clientHeaders = { 'X-Rater-Key': TEST_KEY, 'Content-Type': 'application/json' };
export const adminHeaders = {
  Authorization: `Bearer ${ADMIN_TOKEN}`,
  'Content-Type': 'application/json',
};
