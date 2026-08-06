# rater-collector

[中文](README_CN.md)

The server behind in-app rating prompts and user feedback: a Cloudflare Worker with D1 (sqlite) and R2, including an admin console.

The client is a separate repository: **[RaterKit](https://github.com/fdddf/RaterKit)** (iOS 17+ Swift Package). The usual order is to deploy this first, register an app to get an API key, then wire up the client.

```
   Your app ──▶ pre-prompt ──"Not quite"──▶ feedback form
                    ▲                            │
        copy and trigger thresholds              │ message + screenshots + device info
                    │                            ▼
                    └────────── rater-collector (this repo)
                                  D1 + R2 + webhook + /admin
```

## Deploy

```bash
npm install
```

Create the D1 database and put the returned `database_id` into `wrangler.jsonc`:
```bash
npx wrangler d1 create rater
```

Create the R2 bucket:
```bash
npx wrangler r2 bucket create rater-attachments
```

Create the tables:
```bash
npx wrangler d1 migrations apply rater --remote
```

Set the secrets (`NOTIFY_WEBHOOK_URL` is optional):
```bash
npx wrangler secret put ADMIN_TOKEN && npx wrangler secret put UPLOAD_HMAC_SECRET
```

Point `PUBLIC_BASE_URL` in `wrangler.jsonc` at your deployed address, then:
```bash
npx wrangler deploy
```

Register an app to get the API key the client needs:
```bash
npm run register-app -- --url https://rater-collector.<your-cf-subdomain>.workers.dev --name "My App" --app-store-id 123456789
```
The Apps tab in `/admin` does the same thing. **The API key is shown once** — the database stores only its SHA-256.

## Local development

```bash
cp .dev.vars.example .dev.vars && npx wrangler d1 migrations apply rater --local && npx wrangler dev
```
```bash
npm run register-app -- --name "Demo App" --id demo-app
```

The console is at http://localhost:8787/admin; the password is `ADMIN_TOKEN` from `.dev.vars`.

Unit tests, which run inside real workerd against real D1 and R2 rather than mocks:
```bash
npm test
```

End-to-end, with `npx wrangler dev` running in another terminal:
```bash
npm run e2e
```
`scripts/e2e.sh` drives real HTTP. Its 29 assertions cover the fallback copy, ETag 304s, a console copy edit reaching the client, the three-step submission with a screenshot landing in R2, an idempotent retry not duplicating, funnel counts, and the auth and kill switches. Each run registers a fresh timestamped app (`e2e-<epoch>`), so it never disturbs existing data.

## Client API

Every endpoint requires an `X-Rater-Key: <API key>` header.

### `GET /v1/config?version=&locale=`

Returns the pre-prompt copy, the feedback categories, and optional trigger-rule overrides. Carries an `ETag` and `Cache-Control: max-age=900`; clients should cache it and send `If-None-Match` next time.

```json
{
  "enabled": true,
  "variant": "default",
  "app_store_id": "123456789",
  "prompt": { "title": "…", "message": "…", "positive_label": "…", "negative_label": "…", "later_label": "…" },
  "feedback": { "title": null, "message": null, "categories": [{"id":"bug","label":"Something's broken"}], "email_required": false },
  "rules": { "min_launch_count": 3 }
}
```

Matching goes by locale specificity first (`zh-Hans-CN` → `zh-Hans` → `zh` → `*`), then, among equally specific rows, the highest `min_app_version` not above the client's version. **With no copy configured at all**, the built-in fallback is served, so a newly onboarded app works immediately. **With rows configured but none matching** this version or locale, the response is `enabled: false` — that combination is read as a deliberate opt-out.

### `POST /v1/feedback`

Step one of three. The written content is stored first, then a 15-minute upload token is issued. If the user loses connectivity while uploading screenshots, their message is already safe.

```json
{
  "idempotency_key": "a client-generated UUID",
  "message": "the message, 4–4000 characters",
  "category": "bug",
  "email": "user@example.com",
  "attachment_count": 2,
  "device": { "app_version": "1.0.0", "build": "42", "os_version": "18.2", "device_model": "iPhone 16 Pro", "…": "…" },
  "metadata": { "plan": "pro" }
}
```
→ `201 { "id": "fb_…", "upload_token": "…", "expires_at": 1735689600, "max_attachment_bytes": 5242880, "duplicate": false }`

Resubmitting the same `(app_id, idempotency_key)` returns `200` with the same record and `duplicate: true`. Together with the client's offline retry queue, a flaky network can't produce duplicate feedback.

### `PUT /v1/feedback/:id/attachments/:idx`

Step two. `Authorization: Bearer <upload_token>`, with the raw image bytes as the body.

This proxies through the Worker instead of using a presigned R2 URL: screenshots are already under 2MB, and proxying avoids maintaining S3 credentials on the client while giving size and type validation a single choke point. Re-uploading the same `idx` overwrites, which is what resumable retry needs.

### `POST /v1/feedback/:id/complete`

Step three. Marks the feedback complete, counts the attachments that actually arrived, and pushes the webhook notification asynchronously. Calling it again won't push twice.

### `POST /v1/telemetry`

Batched `shown` / `positive` / `negative` / `dismissed` / `submitted` events, used to compute the conversion funnel. Carries no user identifiers.

## Admin console

`GET /admin` is a single-file HTML console — no build step, so deploying the Worker deploys the console. It covers feedback browsing and filtering, detail with screenshot previews, status and internal notes, conversion funnel stats, **live copy editing**, and app registration and deactivation.

Signing in with `ADMIN_TOKEN` yields a 7-day HttpOnly cookie. In production, consider putting [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of `/admin*` as a second layer.

The matching REST API lives under `/admin/api/*` and takes `Authorization: Bearer <ADMIN_TOKEN>`, so you can drive it from your own tooling.

## Notifications

With `NOTIFY_WEBHOOK_URL` set, every new feedback triggers one push. The payload shape is picked from the host:

| Host | Shape |
|---|---|
| `*.slack.com` | `{ text }` |
| `*.discord.com` | `{ content }` |
| contains `bark` / `day.app` | `{ title, body, url, group }` |
| anything else | generic JSON (all fields plus `detailURL` and `summary`) |

## Abuse protection

The client API key ships inside the app binary, so it isn't a secret. Its job is to attribute traffic to an app and to let an abused key be revoked. The actual protection is layered:

1. The key must exist in the `apps` table with `enabled = 1`.
2. `SUBMIT_LIMIT` rate limits on `IP + app_id` at 5 submissions/minute; `READ_LIMIT` allows 60 reads/minute.
3. Size caps: 64KB JSON body, 5MB per screenshot, at most 3 screenshots per feedback.
4. Strict Zod validation: message 4–4000 characters, at most 20 metadata keys.
5. A unique index on `(app_id, idempotency_key)` blocks replays.
6. `cf.country` is recorded, so the console can spot spam by origin.

## ⚠️ Contract with the client

The `FALLBACK` copy in `src/routes/config.ts` must stay **word-for-word identical** to `RaterCopy.default` in the RaterKit repo's `Sources/RaterKit/Configuration/RaterConfiguration.swift`. One is what the server sends when no copy is configured; the other is what the client shows when it's offline. The same user can hit both across two launches, and any difference reads as a bug.

What both sides currently say:

| Field | Copy |
|---|---|
| title | `Enjoying this app?` |
| message | `Your opinion matters to us — it only takes a few seconds.` |
| positive | `I like it` |
| negative | `Not quite` |
| later | `Maybe later` |
| categories | `Something's broken` / `Feature request` / `Something else` |

Change one side, change the other. It's the one invariant that splitting into two repositories left for a human to watch.

## Data and privacy

Feedback contains an email the user chose to give and device information collected automatically. Say so in your app's privacy policy before shipping, and consider an R2 lifecycle rule to age out old screenshots:

```bash
npx wrangler r2 bucket lifecycle add rater-attachments --name expire-old --expire-days 365
```
