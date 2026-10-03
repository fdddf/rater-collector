import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  ADMIN_TOKEN,
  TEST_APP_ID,
  adminHeaders,
  clientHeaders,
  resetDatabase,
  seedApp,
  tinyPNG,
} from './helpers';

const BASE = 'http://localhost';

/**
 * Runs the full Worker pipeline (middleware and error handling included) rather than
 * calling route handlers directly.
 *
 * Every request gets a distinct client IP by default: rate limiting keys on IP + app, so
 * without this the whole suite would share one "IP" and every submission past the fifth
 * would 429. Tests that exercise rate limiting pass a fixed CF-Connecting-IP themselves.
 */
async function request(
  path: string,
  init?: RequestInit,
  /** Extra bindings for this call only — how the optional secrets get exercised. */
  envOverride?: Record<string, string>,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('CF-Connecting-IP')) {
    headers.set('CF-Connecting-IP', `203.0.113.${Math.floor(Math.random() * 254) + 1}-${crypto.randomUUID()}`);
  }

  const ctx = createExecutionContext();
  const bindings = envOverride ? { ...env, ...envOverride } : env;
  const response = await worker.fetch(new Request(BASE + path, { ...init, headers }), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  idempotency_key: `key-${crypto.randomUUID()}`,
  message: 'The app crashes when I export photos',
  category: 'bug',
  email: 'tester@example.com',
  attachment_count: 0,
  device: {
    app_version: '1.0.0',
    build: '42',
    bundle_id: 'com.example.demo',
    os_version: 'iOS 18.2',
    device_model: 'iPhone 16 Pro',
    locale: 'en-US',
    region: 'US',
    timezone: 'America/Los_Angeles',
    install_days: 12,
    launch_count: 38,
  },
  ...overrides,
});

/** A fresh SDK reporter token — the shape the client generates: 32 random bytes, base64url. */
function newReporter(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Runs the full three-step submission and returns the feedback id. With a reporter token,
 * it's sent the way the SDK sends it, so the feedback becomes one of that reporter's threads.
 */
async function submitFeedback(
  overrides: Record<string, unknown> = {},
  reporter?: string,
): Promise<string> {
  const headers = reporter ? { ...clientHeaders, 'X-Rater-Reporter': reporter } : clientHeaders;
  const created = await request('/v1/feedback', {
    method: 'POST',
    headers,
    body: JSON.stringify(validBody(overrides)),
  });
  const { id } = await created.json<{ id: string }>();
  await request(`/v1/feedback/${id}/complete`, { method: 'POST', headers: clientHeaders });
  return id;
}

beforeEach(async () => {
  await resetDatabase();
  await seedApp();
});

describe('authentication', () => {
  it('returns 401 without an API key', async () => {
    expect((await request('/v1/config')).status).toBe(401);
  });

  it('returns 401 for a bad API key', async () => {
    const res = await request('/v1/config', { headers: { 'X-Rater-Key': 'rtr_pub_bogus' } });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a disabled app', async () => {
    await env.DB.prepare('UPDATE apps SET enabled = 0 WHERE id = ?').bind(TEST_APP_ID).run();
    const res = await request('/v1/config', { headers: clientHeaders });
    expect(res.status).toBe(403);
  });

  it('uses the uniform { error: { code, message } } error shape', async () => {
    const body = await (await request('/v1/config')).json<{ error: { code: string } }>();
    expect(body.error.code).toBe('unauthorized');
  });
});

describe('GET /v1/config', () => {
  it('serves the built-in fallback when no copy is configured, so a new app works immediately', async () => {
    const res = await request('/v1/config?version=1.0.0&locale=en-US', { headers: clientHeaders });
    const body = await res.json<any>();

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.prompt.title).toBeTruthy();
    expect(body.feedback.categories.length).toBeGreaterThan(0);
    expect(body.app_store_id).toBe('123456789');
  });

  it('sends an ETag and answers a repeat request with 304', async () => {
    const first = await request('/v1/config?version=1.0.0', { headers: clientHeaders });
    const etag = first.headers.get('ETag')!;
    expect(etag).toBeTruthy();

    const second = await request('/v1/config?version=1.0.0', {
      headers: { ...clientHeaders, 'If-None-Match': etag },
    });
    expect(second.status).toBe(304);
  });

  it('serves the server-side copy once configured', async () => {
    await request(`/admin/api/apps/${TEST_APP_ID}/prompts`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        locale: '*',
        min_app_version: '0',
        title: 'Server title',
        message: 'Server message',
        positive_label: 'Good',
        negative_label: 'Bad',
        later_label: 'Later',
        categories: [{ id: 'x', label: 'Category X' }],
        rules: { min_launch_count: 7 },
      }),
    });

    const body = await (await request('/v1/config?version=1.0.0', { headers: clientHeaders }))
      .json<any>();

    expect(body.prompt.title).toBe('Server title');
    expect(body.feedback.categories[0].label).toBe('Category X');
    expect(body.rules.min_launch_count).toBe(7);
  });

  it('prefers the more specific locale', async () => {
    const put = (locale: string, title: string) =>
      request(`/admin/api/apps/${TEST_APP_ID}/prompts`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({
          locale, min_app_version: '0', title, message: 'm',
          positive_label: 'a', negative_label: 'b', later_label: 'c',
        }),
      });
    await put('*', 'catch-all');
    await put('zh', 'chinese');
    await put('zh-Hans', 'simplified chinese');

    const pick = async (locale: string) =>
      (await (await request(`/v1/config?version=1.0.0&locale=${locale}`, { headers: clientHeaders }))
        .json<any>()).prompt.title;

    expect(await pick('zh-Hans-CN')).toBe('simplified chinese');
    expect(await pick('zh-Hant')).toBe('chinese');
    expect(await pick('en-US')).toBe('catch-all');
  });

  it('withholds a row from app versions below its min_app_version', async () => {
    await request(`/admin/api/apps/${TEST_APP_ID}/prompts`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        locale: '*', min_app_version: '2.0.0', title: 'New copy', message: 'm',
        positive_label: 'a', negative_label: 'b', later_label: 'c',
      }),
    });

    const old = await (await request('/v1/config?version=1.0.0', { headers: clientHeaders }))
      .json<any>();
    const current = await (await request('/v1/config?version=2.1.0', { headers: clientHeaders }))
      .json<any>();

    expect(old.enabled).toBe(false);
    expect(current.prompt.title).toBe('New copy');
  });

  it('treats enabled=false as a global kill switch', async () => {
    await request(`/admin/api/apps/${TEST_APP_ID}/prompts`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        locale: '*', min_app_version: '0', enabled: false, title: 't', message: 'm',
        positive_label: 'a', negative_label: 'b', later_label: 'c',
      }),
    });

    const body = await (await request('/v1/config?version=1.0.0', { headers: clientHeaders }))
      .json<any>();
    expect(body.enabled).toBe(false);
  });
});

describe('POST /v1/feedback', () => {
  it('persists the row and returns its id', async () => {
    const res = await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders, body: JSON.stringify(validBody()),
    });
    const body = await res.json<any>();

    expect(res.status).toBe(201);
    expect(body.id).toMatch(/^fb_/);
    expect(body.duplicate).toBe(false);
  });

  it('issues an upload token only when attachments are declared', async () => {
    const without = await (await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders, body: JSON.stringify(validBody()),
    })).json<any>();
    expect(without.upload_token).toBeNull();

    const withAttachments = await (await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify(validBody({ attachment_count: 2 })),
    })).json<any>();
    expect(withAttachments.upload_token).toBeTruthy();
  });

  it('stores the full device info and custom metadata', async () => {
    const id = await submitFeedback({ metadata: { plan: 'pro' } });
    const row = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first<any>();

    expect(row.device_model).toBe('iPhone 16 Pro');
    expect(row.app_version).toBe('1.0.0');
    expect(row.install_days).toBe(12);
    expect(JSON.parse(row.metadata_json).plan).toBe('pro');
  });

  it.each([
    ['message too short', { message: 'ab' }],
    ['message too long', { message: 'x'.repeat(4001) }],
    ['malformed email', { email: 'not-an-email' }],
    ['attachment count over the cap', { attachment_count: 99 }],
    ['missing idempotency key', { idempotency_key: '' }],
  ])('rejects an invalid request: %s', async (_label, override) => {
    const res = await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders, body: JSON.stringify(validBody(override)),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-JSON body', async () => {
    const res = await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders, body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('accepts a submission without an email', async () => {
    const res = await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders, body: JSON.stringify(validBody({ email: '' })),
    });
    expect(res.status).toBe(201);
  });

  it('reuses the same record for a repeated idempotency key', async () => {
    const body = validBody();
    const first = await (await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders, body: JSON.stringify(body),
    })).json<any>();

    const second = await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders, body: JSON.stringify(body),
    });
    const secondBody = await second.json<any>();

    expect(second.status).toBe(200);
    expect(secondBody.id).toBe(first.id);
    expect(secondBody.duplicate).toBe(true);

    const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM feedback')
      .first<{ count: number }>() as { count: number };
    expect(count).toBe(1);
  });

  it('scopes idempotency keys per app', async () => {
    const otherKey = 'rtr_pub_other000000000000000000000000';
    await seedApp('other-app', otherKey);

    const body = validBody({ idempotency_key: 'shared-key' });
    await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders, body: JSON.stringify(body),
    });
    const res = await request('/v1/feedback', {
      method: 'POST',
      headers: { 'X-Rater-Key': otherKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
  });
});

describe('attachment upload', () => {
  async function createWithAttachments(count: number) {
    const res = await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify(validBody({ attachment_count: count })),
    });
    return res.json<{ id: string; upload_token: string }>();
  }

  const put = (id: string, idx: number, token: string, body: BodyInit, type = 'image/png') =>
    request(`/v1/feedback/${id}/attachments/${idx}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
      body,
    });

  it('writes the screenshot to R2 and records a row in D1', async () => {
    const { id, upload_token } = await createWithAttachments(1);
    const res = await put(id, 0, upload_token, tinyPNG());

    expect(res.status).toBe(200);
    const { key } = await res.json<{ key: string }>();

    expect(await env.ATTACHMENTS.get(key)).not.toBeNull();
    const row = await env.DB.prepare('SELECT * FROM attachments WHERE feedback_id = ?')
      .bind(id).first<any>();
    expect(row.r2_key).toBe(key);
    expect(row.content_type).toBe('image/png');
    expect(row.bytes).toBeGreaterThan(0);
  });

  it('lays out R2 keys as app / year-month / feedback id', async () => {
    const { id, upload_token } = await createWithAttachments(1);
    const { key } = await (await put(id, 0, upload_token, tinyPNG())).json<{ key: string }>();

    expect(key).toMatch(new RegExp(`^${TEST_APP_ID}/\\d{4}-\\d{2}/${id}/0\\.png$`));
  });

  it('returns 401 for a forged token', async () => {
    const { id } = await createWithAttachments(1);
    const res = await put(id, 0, 'eyJmaWQiOiJmYWtlIn0.AAAA', tinyPNG());
    expect(res.status).toBe(401);
  });

  it('returns 401 when the token is missing', async () => {
    const { id } = await createWithAttachments(1);
    const res = await request(`/v1/feedback/${id}/attachments/0`, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: tinyPNG(),
    });
    expect(res.status).toBe(401);
  });

  it('refuses a token issued for a different feedback', async () => {
    const a = await createWithAttachments(1);
    const b = await createWithAttachments(1);
    const res = await put(b.id, 0, a.upload_token, tinyPNG());
    expect(res.status).toBe(403);
  });

  it('returns 400 for an index beyond the declared count', async () => {
    const { id, upload_token } = await createWithAttachments(2);
    expect((await put(id, 2, upload_token, tinyPNG())).status).toBe(400);
    expect((await put(id, -1, upload_token, tinyPNG())).status).toBe(400);
  });

  it('returns 415 for a non-image content type', async () => {
    const { id, upload_token } = await createWithAttachments(1);
    const res = await put(id, 0, upload_token, tinyPNG(), 'application/pdf');
    expect(res.status).toBe(415);
  });

  it('returns 413 above 5MB', async () => {
    const { id, upload_token } = await createWithAttachments(1);
    const res = await put(id, 0, upload_token, new Uint8Array(6 * 1024 * 1024));
    expect(res.status).toBe(413);
  });

  it('returns 400 for an empty body', async () => {
    const { id, upload_token } = await createWithAttachments(1);
    const res = await put(id, 0, upload_token, new Uint8Array(0));
    expect(res.status).toBe(400);
  });

  it('overwrites on re-upload of the same index instead of duplicating rows', async () => {
    const { id, upload_token } = await createWithAttachments(1);
    await put(id, 0, upload_token, tinyPNG());
    await put(id, 0, upload_token, tinyPNG());

    const { count } = await env.DB
      .prepare('SELECT COUNT(*) AS count FROM attachments WHERE feedback_id = ?')
      .bind(id).first<{ count: number }>() as { count: number };
    expect(count).toBe(1);
  });
});

describe('POST /v1/feedback/:id/complete', () => {
  it('marks it complete and counts the attachments that actually arrived', async () => {
    const created = await (await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify(validBody({ attachment_count: 2 })),
    })).json<any>();

    // Only one of the two declared screenshots is uploaded.
    await request(`/v1/feedback/${created.id}/attachments/0`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${created.upload_token}`, 'Content-Type': 'image/png' },
      body: tinyPNG(),
    });

    const res = await request(`/v1/feedback/${created.id}/complete`, {
      method: 'POST', headers: clientHeaders,
    });
    const body = await res.json<any>();

    expect(body.attachment_count).toBe(1);
    const row = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?')
      .bind(created.id).first<any>();
    expect(row.status).toBe('open');
    expect(row.completed_at).toBeGreaterThan(0);
  });

  it('returns 404 for an unknown feedback', async () => {
    const res = await request('/v1/feedback/fb_nope/complete', {
      method: 'POST', headers: clientHeaders,
    });
    expect(res.status).toBe(404);
  });

  it('will not let another app complete your feedback', async () => {
    const id = await submitFeedback();
    const otherKey = 'rtr_pub_other000000000000000000000000';
    await seedApp('other-app', otherKey);

    const res = await request(`/v1/feedback/${id}/complete`, {
      method: 'POST', headers: { 'X-Rater-Key': otherKey },
    });
    expect(res.status).toBe(404);
  });

  it('leaves completed_at untouched on a repeat call, so the notification is not pushed twice', async () => {
    const id = await submitFeedback();
    const before = await env.DB.prepare('SELECT completed_at FROM feedback WHERE id = ?')
      .bind(id).first<{ completed_at: number }>();

    await request(`/v1/feedback/${id}/complete`, { method: 'POST', headers: clientHeaders });

    const after = await env.DB.prepare('SELECT completed_at FROM feedback WHERE id = ?')
      .bind(id).first<{ completed_at: number }>();
    expect(after!.completed_at).toBe(before!.completed_at);
  });
});

describe('POST /v1/telemetry', () => {
  it('writes a batch of events', async () => {
    const res = await request('/v1/telemetry', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify({
        events: [
          { kind: 'shown', app_version: '1.0.0' },
          { kind: 'negative', app_version: '1.0.0' },
        ],
      }),
    });

    expect((await res.json<any>()).accepted).toBe(2);
    const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM telemetry')
      .first<{ count: number }>() as { count: number };
    expect(count).toBe(2);
  });

  it('rejects an unknown event kind', async () => {
    const res = await request('/v1/telemetry', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify({ events: [{ kind: 'hacked' }] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty and oversized batches', async () => {
    const empty = await request('/v1/telemetry', {
      method: 'POST', headers: clientHeaders, body: JSON.stringify({ events: [] }),
    });
    expect(empty.status).toBe(400);

    const huge = await request('/v1/telemetry', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify({ events: Array(51).fill({ kind: 'shown' }) }),
    });
    expect(huge.status).toBe(400);
  });
});

describe('admin console', () => {
  it('returns 401 everywhere without a password', async () => {
    for (const path of ['/admin/api/feedback', '/admin/api/apps', '/admin/api/stats']) {
      expect((await request(path)).status).toBe(401);
    }
  });

  it('returns 401 for a wrong password', async () => {
    const res = await request('/admin/api/feedback', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('serves the HTML console at /admin', async () => {
    const res = await request('/admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('Rater');
  });

  it('trades a correct password for a cookie', async () => {
    const res = await request('/admin/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
  });

  it('accepts the cookie as authentication', async () => {
    const res = await request('/admin/api/feedback', {
      headers: { Cookie: `rater_admin=${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('lists only completed feedback — abandoned submissions should not show up', async () => {
    await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders, body: JSON.stringify(validBody()),
    });
    const completed = await submitFeedback();

    const body = await (await request('/admin/api/feedback', { headers: adminHeaders }))
      .json<any>();

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(completed);
  });

  it('filters by status and by keyword', async () => {
    const id = await submitFeedback({ message: 'a distinctive keyword appears here' });
    await submitFeedback({ message: 'just another ordinary piece of feedback' });

    const byQuery = await (await request('/admin/api/feedback?q=distinctive', {
      headers: adminHeaders,
    })).json<any>();
    expect(byQuery.items).toHaveLength(1);
    expect(byQuery.items[0].id).toBe(id);

    await request(`/admin/api/feedback/${id}`, {
      method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'resolved' }),
    });
    const byStatus = await (await request('/admin/api/feedback?status=resolved', {
      headers: adminHeaders,
    })).json<any>();
    expect(byStatus.items).toHaveLength(1);
  });

  it('returns a cursor for pagination', async () => {
    for (let i = 0; i < 3; i++) await submitFeedback({ message: `feedback number ${i}` });

    const page = await (await request('/admin/api/feedback?limit=2', { headers: adminHeaders }))
      .json<any>();
    expect(page.items).toHaveLength(2);
    expect(page.next_before).toBeTruthy();

    const next = await (await request(`/admin/api/feedback?limit=2&before=${page.next_before}`, {
      headers: adminHeaders,
    })).json<any>();
    expect(next.items.length).toBeLessThanOrEqual(1);
  });

  it('includes the attachment list and parsed metadata in the detail view', async () => {
    const created = await (await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify(validBody({ attachment_count: 1, metadata: { plan: 'pro' } })),
    })).json<any>();
    await request(`/v1/feedback/${created.id}/attachments/0`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${created.upload_token}`, 'Content-Type': 'image/png' },
      body: tinyPNG(),
    });
    await request(`/v1/feedback/${created.id}/complete`, { method: 'POST', headers: clientHeaders });

    const body = await (await request(`/admin/api/feedback/${created.id}`, { headers: adminHeaders }))
      .json<any>();

    expect(body.feedback.metadata.plan).toBe('pro');
    expect(body.attachments).toHaveLength(1);
  });

  it('serves screenshots back out of R2', async () => {
    const created = await (await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify(validBody({ attachment_count: 1 })),
    })).json<any>();
    const { key } = await (await request(`/v1/feedback/${created.id}/attachments/0`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${created.upload_token}`, 'Content-Type': 'image/png' },
      body: tinyPNG(),
    })).json<{ key: string }>();

    const res = await request(`/admin/api/attachments/${key}`, { headers: adminHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('updates status and the internal note', async () => {
    const id = await submitFeedback();
    const res = await request(`/admin/api/feedback/${id}`, {
      method: 'PATCH', headers: adminHeaders,
      body: JSON.stringify({ status: 'resolved', admin_note: 'Fixed in 1.0.1' }),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first<any>();
    expect(row.status).toBe('resolved');
    expect(row.admin_note).toBe('Fixed in 1.0.1');
  });

  it('rejects an invalid status value', async () => {
    const id = await submitFeedback();
    const res = await request(`/admin/api/feedback/${id}`, {
      method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'whatever' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns the plaintext key once at registration and stores only its hash', async () => {
    const res = await request('/admin/api/apps', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'Brand New App', app_store_id: '555' }),
    });
    const body = await res.json<any>();

    expect(res.status).toBe(201);
    expect(body.api_key).toMatch(/^rtr_pub_/);
    expect(body.id).toBe('brand-new-app');

    const row = await env.DB.prepare('SELECT api_key_hash FROM apps WHERE id = ?')
      .bind(body.id).first<any>();
    expect(row.api_key_hash).not.toBe(body.api_key);

    // The new key works right away.
    const config = await request('/v1/config', { headers: { 'X-Rater-Key': body.api_key } });
    expect(config.status).toBe(200);
  });

  it('rejects a duplicate app id', async () => {
    const res = await request('/admin/api/apps', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'Dup', id: TEST_APP_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('computes the conversion funnel', async () => {
    await request('/v1/telemetry', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify({
        events: [
          { kind: 'shown' }, { kind: 'shown' }, { kind: 'shown' }, { kind: 'shown' },
          { kind: 'positive' }, { kind: 'negative' }, { kind: 'submitted' },
        ],
      }),
    });
    await submitFeedback();

    const stats = await (await request(`/admin/api/stats?app_id=${TEST_APP_ID}`, {
      headers: adminHeaders,
    })).json<any>();

    expect(stats.funnel.shown).toBe(4);
    expect(stats.funnel.positive).toBe(1);
    expect(stats.funnel.positive_rate).toBeCloseTo(0.25);
    expect(stats.feedback_by_status.open).toBe(1);
    expect(stats.feedback_daily.length).toBeGreaterThan(0);
  });

  it('deletes a copy configuration', async () => {
    await request(`/admin/api/apps/${TEST_APP_ID}/prompts`, {
      method: 'PUT', headers: adminHeaders,
      body: JSON.stringify({
        locale: '*', min_app_version: '0', title: 't', message: 'm',
        positive_label: 'a', negative_label: 'b', later_label: 'c',
      }),
    });
    const { prompts } = await (await request(`/admin/api/apps/${TEST_APP_ID}/prompts`, {
      headers: adminHeaders,
    })).json<any>();

    const res = await request(`/admin/api/prompts/${prompts[0].id}`, {
      method: 'DELETE', headers: adminHeaders,
    });
    expect(res.status).toBe(200);
  });

  it('invalidates an app’s key the moment it is disabled', async () => {
    await request(`/admin/api/apps/${TEST_APP_ID}`, {
      method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ enabled: false }),
    });
    expect((await request('/v1/config', { headers: clientHeaders })).status).toBe(403);
  });
});

describe('deleting feedback', () => {
  /** Runs the full submission with one screenshot and returns the feedback id and its R2 key. */
  async function submitWithScreenshot(): Promise<{ id: string; key: string }> {
    const created = await request('/v1/feedback', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify(validBody({ attachment_count: 1 })),
    });
    const { id, upload_token } = await created.json<{ id: string; upload_token: string }>();

    const uploaded = await request(`/v1/feedback/${id}/attachments/0`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${upload_token}`, 'Content-Type': 'image/png' },
      body: tinyPNG(),
    });
    const { key } = await uploaded.json<{ key: string }>();

    await request(`/v1/feedback/${id}/complete`, { method: 'POST', headers: clientHeaders });
    return { id, key };
  }

  it('takes the screenshot out of R2 along with the rows', async () => {
    const { id, key } = await submitWithScreenshot();
    expect(await env.ATTACHMENTS.get(key)).not.toBeNull();

    const res = await request(`/admin/api/feedback/${id}`, {
      method: 'DELETE', headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    expect(await env.ATTACHMENTS.get(key)).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM feedback WHERE id = ?').bind(id).first()).toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM attachments WHERE feedback_id = ?').bind(id).first(),
    ).toBeNull();
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request('/admin/api/feedback/fb_nope', {
      method: 'DELETE', headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });

  it('deletes several at once and leaves the rest alone', async () => {
    const doomed = [await submitFeedback(), await submitFeedback()];
    const keeper = await submitFeedback();

    const res = await request('/admin/api/feedback/bulk-delete', {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ ids: doomed }),
    });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).deleted).toBe(2);

    const { items } = await (await request('/admin/api/feedback', { headers: adminHeaders }))
      .json<any>();
    expect(items.map((f: any) => f.id)).toEqual([keeper]);
  });

  it('rejects an empty id list', async () => {
    const res = await request('/admin/api/feedback/bulk-delete', {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ ids: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('rotating an app key', () => {
  it('issues a working key and retires the old one', async () => {
    const res = await request(`/admin/api/apps/${TEST_APP_ID}/rotate-key`, {
      method: 'POST', headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const { api_key } = await res.json<any>();
    expect(api_key).toMatch(/^rtr_pub_[0-9a-f]{40}$/);

    const withNew = await request('/v1/telemetry', {
      method: 'POST',
      headers: { 'X-Rater-Key': api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ kind: 'shown' }] }),
    });
    expect(withNew.status).toBe(200);

    const withOld = await request('/v1/telemetry', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify({ events: [{ kind: 'shown' }] }),
    });
    expect(withOld.status).toBe(401);
  });

  it('returns 404 for an unknown app', async () => {
    const res = await request('/admin/api/apps/nope/rotate-key', {
      method: 'POST', headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });

  it('requires the admin token', async () => {
    const res = await request(`/admin/api/apps/${TEST_APP_ID}/rotate-key`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('resetting app stats', () => {
  it('clears telemetry and leaves feedback standing', async () => {
    await request('/v1/telemetry', {
      method: 'POST', headers: clientHeaders,
      body: JSON.stringify({ events: [{ kind: 'shown' }, { kind: 'positive' }] }),
    });
    await submitFeedback();

    const res = await request(`/admin/api/apps/${TEST_APP_ID}/reset-stats`, {
      method: 'POST', headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).deleted).toBe(2);

    const stats = await (await request(`/admin/api/stats?app_id=${TEST_APP_ID}`, {
      headers: adminHeaders,
    })).json<any>();
    expect(stats.funnel.shown).toBe(0);
    expect(stats.feedback_by_status.open).toBe(1);
  });

  it('leaves another app’s telemetry alone', async () => {
    const otherKey = 'rtr_pub_otherkey000000000000000000000';
    await seedApp('other-app', otherKey);
    await request('/v1/telemetry', {
      method: 'POST',
      headers: { 'X-Rater-Key': otherKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ kind: 'shown' }] }),
    });

    await request(`/admin/api/apps/${TEST_APP_ID}/reset-stats`, {
      method: 'POST', headers: adminHeaders,
    });

    const stats = await (await request('/admin/api/stats?app_id=other-app', {
      headers: adminHeaders,
    })).json<any>();
    expect(stats.funnel.shown).toBe(1);
  });

  it('returns 404 for an unknown app', async () => {
    const res = await request('/admin/api/apps/nope/reset-stats', {
      method: 'POST', headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe('translating copy', () => {
  const draft = {
    locale: 'en', min_app_version: '0', title: 'Enjoying this?', message: 'Tell us.',
    positive_label: 'Yes', negative_label: 'Not really', later_label: 'Later',
    // The console sends explicit nulls for "no copy" and "no overrides" — these used to
    // be rejected because the schema was optional rather than nullish.
    feedback_title: null, feedback_message: null, rules: null,
    categories: [{ id: 'bug', label: 'Something is broken' }],
  };

  it('accepts a draft whose optional fields are explicitly null', async () => {
    const res = await request(`/admin/api/apps/${TEST_APP_ID}/prompts`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify(draft),
    });
    expect(res.status).toBe(200);
  });

  it('reports a missing API key rather than failing at the provider', async () => {
    const res = await request(`/admin/api/apps/${TEST_APP_ID}/prompts/translate`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ source: draft, target_locales: ['ja'] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.message).toContain('TRANSLATE_API_KEY');
  });

  it('returns 404 before spending anything on an unknown app', async () => {
    const res = await request('/admin/api/apps/nope/prompts/translate', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ source: draft, target_locales: ['ja'] }),
    });
    expect(res.status).toBe(404);
  });

  it('caps the number of locales in one request', async () => {
    const res = await request(`/admin/api/apps/${TEST_APP_ID}/prompts/translate`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({
        source: draft,
        target_locales: Array.from({ length: 20 }, (_, i) => `l${i}`),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('reports whether translation is configured', async () => {
    const res = await request('/admin/api/settings', { headers: adminHeaders });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).translate_enabled).toBe(false);
  });
});

describe('console messages', () => {
  const RESEND_ENV = {
    RESEND_API_KEY: 're_test_key',
    RESEND_FROM: 'Support <support@mail.example.com>',
    RESEND_REPLY_TO: 'support@support.example.com',
  };
  const emailed = { body: 'Thanks — fixed in 1.0.1.', email: { subject: 'Re: your feedback' } };

  /** Replaces global fetch so nothing leaves the test, and records what Resend was sent. */
  function stubResend(response: Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return response.clone();
    });
    return calls;
  }

  const post = (id: string, body: unknown, envOverride?: Record<string, string>) =>
    request(
      `/admin/api/feedback/${id}/messages`,
      { method: 'POST', headers: adminHeaders, body: JSON.stringify(body) },
      envOverride,
    );

  afterEach(() => vi.unstubAllGlobals());

  it('posts into the in-app conversation without touching email', async () => {
    const id = await submitFeedback({}, newReporter());
    const calls = stubResend(Response.json({ id: 'never' }));

    const res = await post(id, { body: 'Could you send a screen recording?' });
    expect(res.status).toBe(201);
    expect((await res.json<any>()).message).toMatchObject({ author: 'admin', email_to: null });
    expect(calls).toHaveLength(0);

    const detail = await (await request(`/admin/api/feedback/${id}`, { headers: adminHeaders })).json<any>();
    expect(detail.feedback.in_app).toBe(true);
    expect(detail.feedback.reporter_hash).toBeUndefined();
    expect(detail.messages.map((m: any) => m.body)).toEqual(['Could you send a screen recording?']);
  });

  it('refuses an in-app-only message to feedback from a client without conversations', async () => {
    const id = await submitFeedback();
    const res = await post(id, { body: 'Hello?' });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.message).toContain('reply by email');
  });

  it('names the missing secret instead of failing at the provider', async () => {
    const id = await submitFeedback();
    const res = await post(id, emailed);
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.message).toContain('RESEND_API_KEY');
  });

  it('sends through Resend and records what went out', async () => {
    const id = await submitFeedback();
    const calls = stubResend(Response.json({ id: 'resend-msg-1' }));

    const res = await post(id, emailed, RESEND_ENV);
    expect(res.status).toBe(201);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.resend.com/emails');
    const sent = JSON.parse(call.init.body as string);
    expect(sent).toMatchObject({
      from: RESEND_ENV.RESEND_FROM,
      to: ['tester@example.com'],
      subject: emailed.email.subject,
      text: emailed.body,
      reply_to: RESEND_ENV.RESEND_REPLY_TO,
    });

    const detail = await (await request(`/admin/api/feedback/${id}`, { headers: adminHeaders })).json<any>();
    expect(detail.feedback.in_app).toBe(false);
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({
      author: 'admin',
      email_to: 'tester@example.com',
      email_subject: emailed.email.subject,
    });
    expect(
      await env.DB.prepare('SELECT email_provider_id FROM feedback_messages WHERE feedback_id = ?')
        .bind(id)
        .first<{ email_provider_id: string }>(),
    ).toMatchObject({ email_provider_id: 'resend-msg-1' });
  });

  it('records nothing when Resend rejects the message', async () => {
    const id = await submitFeedback({}, newReporter());
    stubResend(Response.json({ message: 'The domain is not verified.' }, { status: 403 }));

    const res = await post(id, emailed, RESEND_ENV);
    expect(res.status).toBe(502);
    expect((await res.json<any>()).error.message).toContain('not verified');
    expect(
      await env.DB.prepare('SELECT seq FROM feedback_messages WHERE feedback_id = ?').bind(id).first(),
    ).toBeNull();
  });

  it('refuses to email a feedback that left no email address', async () => {
    const id = await submitFeedback({ email: '' });
    const calls = stubResend(Response.json({ id: 'never' }));

    const res = await post(id, emailed, RESEND_ENV);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('returns 404 for an unknown feedback', async () => {
    const res = await post('fb_nope', emailed, RESEND_ENV);
    expect(res.status).toBe(404);
  });

  it('takes the conversation with the feedback when it is deleted', async () => {
    const id = await submitFeedback({}, newReporter());
    await post(id, { body: 'On it.' });

    await request(`/admin/api/feedback/${id}`, { method: 'DELETE', headers: adminHeaders });
    expect(
      await env.DB.prepare('SELECT seq FROM feedback_messages WHERE feedback_id = ?').bind(id).first(),
    ).toBeNull();
  });

  it('reports whether emailing is configured', async () => {
    const res = await request('/admin/api/settings', { headers: adminHeaders });
    expect((await res.json<any>()).reply_enabled).toBe(false);
  });
});

describe('in-app conversations', () => {
  const as = (reporter: string, extra: Record<string, string> = {}) => ({
    ...clientHeaders,
    'X-Rater-Reporter': reporter,
    ...extra,
  });

  const say = (id: string, reporter: string, body: string, key = `msg-${crypto.randomUUID()}`) =>
    request(`/v1/threads/${id}/messages`, {
      method: 'POST',
      headers: as(reporter),
      body: JSON.stringify({ idempotency_key: key, body }),
    });

  const answer = (id: string, body: string) =>
    request(`/admin/api/feedback/${id}/messages`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ body }),
    });

  const inbox = async (reporter: string) =>
    (await request('/v1/inbox', { headers: as(reporter) })).json<any>();

  it('requires a well-formed reporter token', async () => {
    expect((await request('/v1/threads', { headers: clientHeaders })).status).toBe(401);
    expect((await request('/v1/threads', { headers: as('short') })).status).toBe(401);
    expect((await request('/v1/inbox', { headers: as('x'.repeat(200)) })).status).toBe(401);
  });

  it('still requires the app key', async () => {
    const res = await request('/v1/threads', { headers: { 'X-Rater-Reporter': newReporter() } });
    expect(res.status).toBe(401);
  });

  it('accepts a submission with a malformed token, just without a thread', async () => {
    const id = await submitFeedback({}, 'not a token');
    const row = await env.DB.prepare('SELECT reporter_hash FROM feedback WHERE id = ?')
      .bind(id)
      .first<{ reporter_hash: string | null }>();
    expect(row?.reporter_hash).toBeNull();
  });

  it('stores only the hash of the token', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({}, reporter);
    const row = await env.DB.prepare('SELECT reporter_hash FROM feedback WHERE id = ?')
      .bind(id)
      .first<{ reporter_hash: string }>();
    expect(row?.reporter_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.reporter_hash).not.toContain(reporter);
  });

  it('lists only the caller’s own completed feedback', async () => {
    const mine = newReporter();
    const theirs = newReporter();
    const a = await submitFeedback({ message: 'First of mine' }, mine);
    const b = await submitFeedback({ message: 'Second of mine' }, mine);
    await submitFeedback({ message: 'Someone else' }, theirs);
    // Created but never completed — the user saw an error, not a sent message.
    await request('/v1/feedback', {
      method: 'POST',
      headers: as(mine),
      body: JSON.stringify(validBody({ message: 'Abandoned midway' })),
    });

    const res = await request('/v1/threads', { headers: as(mine) });
    expect(res.status).toBe(200);
    const { items } = await res.json<any>();
    expect(items.map((t: any) => t.id).sort()).toEqual([a, b].sort());
    expect(items[0]).toMatchObject({ status: 'open', last_author: 'user', unread_count: 0 });
  });

  it('scopes threads per app as well as per reporter', async () => {
    const reporter = newReporter();
    await submitFeedback({}, reporter);
    await seedApp('other-app', 'rtr_pub_otherkey000000000000000000000');

    const res = await request('/v1/threads', {
      headers: { ...as(reporter), 'X-Rater-Key': 'rtr_pub_otherkey000000000000000000000' },
    });
    expect((await res.json<any>()).items).toEqual([]);
  });

  it('hides another reporter’s thread behind a 404', async () => {
    const id = await submitFeedback({}, newReporter());
    const stranger = newReporter();

    expect((await request(`/v1/threads/${id}`, { headers: as(stranger) })).status).toBe(404);
    expect((await say(id, stranger, 'Let me in')).status).toBe(404);
    const read = await request(`/v1/threads/${id}/read`, {
      method: 'POST',
      headers: as(stranger),
      body: JSON.stringify({ seq: 1 }),
    });
    expect(read.status).toBe(404);
  });

  it('carries a conversation both ways, in order', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({ message: 'Export crashes' }, reporter);

    await answer(id, 'Which iOS version?');
    const sent = await say(id, reporter, 'iOS 18.2');
    expect(sent.status).toBe(201);
    expect((await sent.json<any>()).message).toMatchObject({ author: 'user', body: 'iOS 18.2' });

    const res = await request(`/v1/threads/${id}`, { headers: as(reporter) });
    const { thread, messages } = await res.json<any>();
    expect(thread).toMatchObject({ id, message: 'Export crashes', last_author: 'user', preview: 'iOS 18.2' });
    expect(messages.map((m: any) => [m.author, m.body])).toEqual([
      ['admin', 'Which iOS version?'],
      ['user', 'iOS 18.2'],
    ]);
    expect(messages[0].seq).toBeLessThan(messages[1].seq);
    // The console's email bookkeeping is not the user's business.
    expect(messages[0].email_to).toBeUndefined();
  });

  it('returns only what came after the cursor', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({}, reporter);
    await answer(id, 'One');
    const first = await (await request(`/v1/threads/${id}`, { headers: as(reporter) })).json<any>();
    const cursor = first.messages.at(-1).seq;

    await answer(id, 'Two');
    const next = await (await request(`/v1/threads/${id}?after=${cursor}`, { headers: as(reporter) })).json<any>();
    expect(next.messages.map((m: any) => m.body)).toEqual(['Two']);
  });

  it('posts a resent message once', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({}, reporter);

    const first = await say(id, reporter, 'Hello', 'same-key-123');
    const again = await say(id, reporter, 'Hello', 'same-key-123');
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const [a, b] = [await first.json<any>(), await again.json<any>()];
    expect(b.duplicate).toBe(true);
    expect(b.message.id).toBe(a.message.id);

    const { messages } = await (await request(`/v1/threads/${id}`, { headers: as(reporter) })).json<any>();
    expect(messages).toHaveLength(1);
  });

  it('rejects an empty message', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({}, reporter);
    expect((await say(id, reporter, '   ')).status).toBe(400);
  });

  it('counts unread admin messages until the user reads them', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({}, reporter);
    const other = await submitFeedback({}, reporter);
    expect(await inbox(reporter)).toEqual({ unread_count: 0, unread_threads: 0 });

    await answer(id, 'One');
    await answer(id, 'Two');
    await answer(other, 'Three');
    expect(await inbox(reporter)).toEqual({ unread_count: 3, unread_threads: 2 });

    const { messages } = await (await request(`/v1/threads/${id}`, { headers: as(reporter) })).json<any>();
    const read = await request(`/v1/threads/${id}/read`, {
      method: 'POST',
      headers: as(reporter),
      body: JSON.stringify({ seq: messages.at(-1).seq }),
    });
    expect(read.status).toBe(200);
    expect(await inbox(reporter)).toEqual({ unread_count: 1, unread_threads: 1 });

    const { items } = await (await request('/v1/threads', { headers: as(reporter) })).json<any>();
    expect(items.find((t: any) => t.id === id).unread_count).toBe(0);
    expect(items.find((t: any) => t.id === other).unread_count).toBe(1);
  });

  it('never moves the read marker past the newest message', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({}, reporter);
    await request(`/v1/threads/${id}/read`, {
      method: 'POST',
      headers: as(reporter),
      body: JSON.stringify({ seq: 1_000_000 }),
    });

    await answer(id, 'Written after the bogus read');
    expect((await inbox(reporter)).unread_count).toBe(1);
  });

  it('reopens a resolved thread when the user writes back', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({}, reporter);
    await request(`/admin/api/feedback/${id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'resolved' }),
    });

    const before = await (await request(`/v1/threads/${id}`, { headers: as(reporter) })).json<any>();
    expect(before.thread.status).toBe('resolved');

    await say(id, reporter, 'Still broken in 1.0.1');
    const after = await (await request(`/admin/api/feedback/${id}`, { headers: adminHeaders })).json<any>();
    expect(after.feedback.status).toBe('open');
  });

  it('hides spam from the user and refuses replies to it', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({}, reporter);
    await request(`/admin/api/feedback/${id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'spam' }),
    });

    expect((await (await request('/v1/threads', { headers: as(reporter) })).json<any>()).items).toEqual([]);
    expect((await say(id, reporter, 'Hello?')).status).toBe(404);
  });

  it('shows the console which threads are waiting on it', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({}, reporter);
    const quiet = await submitFeedback({}, reporter);
    await say(id, reporter, 'Any news?');

    const list = await (await request('/admin/api/feedback', { headers: adminHeaders })).json<any>();
    expect(list.items.find((f: any) => f.id === id)).toMatchObject({ unread_count: 1, in_app: 1 });
    expect(list.items.find((f: any) => f.id === quiet).unread_count).toBe(0);

    const unread = await (await request('/admin/api/feedback?unread=1', { headers: adminHeaders })).json<any>();
    expect(unread.items.map((f: any) => f.id)).toEqual([id]);

    // Opening the thread in the console reads it.
    await request(`/admin/api/feedback/${id}`, { headers: adminHeaders });
    const after = await (await request('/admin/api/feedback?unread=1', { headers: adminHeaders })).json<any>();
    expect(after.items).toEqual([]);
  });

  it('notifies the console’s push targets when the user writes back', async () => {
    const reporter = newReporter();
    const id = await submitFeedback({}, reporter);

    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), body: JSON.parse(String(init.body ?? '{}')) });
      return Response.json({ code: 200 });
    });
    try {
      await request(
        `/v1/threads/${id}/messages`,
        {
          method: 'POST',
          headers: as(reporter),
          body: JSON.stringify({ idempotency_key: 'notify-key-1', body: 'Any news?' }),
        },
        { BARK_SERVER_URL: 'https://bark.example.com', BARK_DEVICE_KEY: 'devicekey123' },
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.title).toBe(`New reply — Test ${TEST_APP_ID}`);
    expect(calls[0]!.body.body).toContain('Any news?');
  });

  it('erases everything the reporter sent, and nothing else', async () => {
    const reporter = newReporter();
    const mine = await submitFeedback({ attachment_count: 1 }, reporter);
    await answer(mine, 'Thanks!');
    const theirs = await submitFeedback({}, newReporter());

    const res = await request('/v1/threads', { method: 'DELETE', headers: as(reporter) });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).deleted).toBe(1);

    expect(await env.DB.prepare('SELECT id FROM feedback WHERE id = ?').bind(mine).first()).toBeNull();
    expect(
      await env.DB.prepare('SELECT seq FROM feedback_messages WHERE feedback_id = ?').bind(mine).first(),
    ).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM feedback WHERE id = ?').bind(theirs).first()).not.toBeNull();
  });
});

describe('rate limiting', () => {
  it('blocks a burst of submissions from one IP', async () => {
    const ip = '198.51.100.7';
    const statuses: number[] = [];

    for (let i = 0; i < 8; i++) {
      const res = await request('/v1/feedback', {
        method: 'POST',
        headers: { ...clientHeaders, 'CF-Connecting-IP': ip },
        body: JSON.stringify(validBody()),
      });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(5);
    expect(statuses).toContain(429);
  });

  it('isolates the limit per IP so one client cannot block another', async () => {
    const flood = async (ip: string) => {
      const results: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await request('/v1/feedback', {
          method: 'POST',
          headers: { ...clientHeaders, 'CF-Connecting-IP': ip },
          body: JSON.stringify(validBody()),
        });
        results.push(res.status);
      }
      return results;
    };

    await flood('198.51.100.20');
    // A different IP should start with a fresh quota.
    const other = await flood('198.51.100.21');
    expect(other[0]).toBe(201);
  });
});

describe('new-feedback notifications', () => {
  const BARK_ENV = { BARK_SERVER_URL: 'https://bark.example.com/', BARK_DEVICE_KEY: 'devicekey123' };

  /** Records every outbound push instead of letting it leave the test. */
  function stubPushes() {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), body: JSON.parse(String(init.body ?? '{}')) });
      return Response.json({ code: 200 });
    });
    return calls;
  }

  /** `complete` is what fires the push, so that call is the one that needs the env. */
  async function submitWith(envOverride: Record<string, string>): Promise<void> {
    const created = await request('/v1/feedback', {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify(validBody()),
    });
    const { id } = await created.json<{ id: string }>();
    await request(`/v1/feedback/${id}/complete`, { method: 'POST', headers: clientHeaders }, envOverride);
  }

  afterEach(() => vi.unstubAllGlobals());

  it('pushes to a self-hosted Bark server in the shape Bark renders', async () => {
    const calls = stubPushes();
    await submitWith(BARK_ENV);

    expect(calls).toHaveLength(1);
    // No double slash even though BARK_SERVER_URL has a trailing one.
    expect(calls[0]!.url).toBe('https://bark.example.com/devicekey123');
    expect(calls[0]!.body).toMatchObject({ title: `New feedback — Test ${TEST_APP_ID}`, group: 'Feedback' });
    expect(calls[0]!.body.body).toContain('The app crashes when I export photos');
  });

  it('pushes nothing when neither target is configured', async () => {
    const calls = stubPushes();
    await submitWith({});
    expect(calls).toHaveLength(0);
  });

  it('pushes to Bark and the webhook independently', async () => {
    const calls = stubPushes();
    await submitWith({ ...BARK_ENV, NOTIFY_WEBHOOK_URL: 'https://hooks.slack.com/services/xxx' });

    expect(calls.map((c) => c.url).sort()).toEqual([
      'https://bark.example.com/devicekey123',
      'https://hooks.slack.com/services/xxx',
    ]);
    expect(calls.find((c) => c.url.includes('slack'))!.body.text).toContain('📮 New feedback');
  });

  it('survives a Bark server that is down', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection refused');
    });
    // The client's `complete` must still succeed — the push runs in waitUntil.
    await expect(submitWith(BARK_ENV)).resolves.toBeUndefined();
  });
});

describe('misc', () => {
  it('answers the health check', async () => {
    expect((await request('/health')).status).toBe(200);
  });

  it('returns JSON 404 for an unknown path', async () => {
    const res = await request('/nope');
    expect(res.status).toBe(404);
    expect((await res.json<any>()).error.code).toBe('not_found');
  });
});
