#!/usr/bin/env node
/**
 * Registers a new app and prints its API key.
 *
 * Usage:
 *   npm run register-app -- --name "My App" --app-store-id 123456789
 *   npm run register-app -- --url https://rater-collector.you.workers.dev --name "My App"
 *
 * The admin password comes from --token or the RATER_ADMIN_TOKEN environment variable;
 * locally it falls back to ADMIN_TOKEN in .dev.vars.
 */
import { readFileSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (key) args.set(key, process.argv[i + 1] ?? '');
}

const url = (args.get('url') ?? 'http://localhost:8787').replace(/\/$/, '');
const name = args.get('name');
if (!name) {
  console.error('Missing --name. Example: npm run register-app -- --name "My App" --app-store-id 123456789');
  process.exit(1);
}

let token = args.get('token') ?? process.env.RATER_ADMIN_TOKEN;
if (!token) {
  try {
    const devVars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    token = devVars.match(/^ADMIN_TOKEN\s*=\s*"?([^"\n]+)"?/m)?.[1];
  } catch {
    /* No .dev.vars — fall through and let the message below report it */
  }
}
if (!token) {
  console.error('Missing admin password. Pass --token, set RATER_ADMIN_TOKEN, or put ADMIN_TOKEN in worker/.dev.vars.');
  process.exit(1);
}

const res = await fetch(`${url}/admin/api/apps`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    name,
    id: args.get('id') || undefined,
    app_store_id: args.get('app-store-id') || undefined,
  }),
});

const body = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`Registration failed (HTTP ${res.status}): ${body?.error?.message ?? 'unknown error'}`);
  process.exit(1);
}

console.log(`
✅ Registered

  app id        ${body.id}
  Name          ${body.name}
  App Store ID  ${body.app_store_id ?? '(not set)'}

  API Key       ${body.api_key}

This key is shown only once — put it in the client's RaterConfiguration.
`);
