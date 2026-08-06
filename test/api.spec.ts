import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
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
async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('CF-Connecting-IP')) {
    headers.set('CF-Connecting-IP', `203.0.113.${Math.floor(Math.random() * 254) + 1}-${crypto.randomUUID()}`);
  }

  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(BASE + path, { ...init, headers }), env, ctx);
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

/** Runs the full three-step submission and returns the feedback id. */
async function submitFeedback(overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await request('/v1/feedback', {
    method: 'POST',
    headers: clientHeaders,
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
