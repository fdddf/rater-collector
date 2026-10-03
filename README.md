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

Set `PUBLIC_BASE_URL` to your deployed address — it prefixes the "view detail" links in notifications, so it has to be the public one, with no trailing slash:

```bash
npx wrangler secret put PUBLIC_BASE_URL   # https://rater-collector.<you>.workers.dev
```

Then:
```bash
npx wrangler deploy
```

### Automatic deploys from GitHub

Instead of running `wrangler deploy` by hand, connect the repository under
**Workers & Pages → your Worker → Settings → Builds** and every push to `main` builds and
deploys. Three things matter:

- The Worker's name in the dashboard must equal `name` in `wrangler.jsonc` (`rater-collector`),
  or the build fails.
- Leave **Root directory** empty — the Worker lives at the repository root.
- Set **Deploy command** to `npm run deploy`. That runs the D1 migrations before deploying,
  so a schema change ships with the code that needs it. Migrations are tracked in D1 and
  skipped if already applied.

Non-production branches default to `npx wrangler versions upload`, which builds a preview
version without promoting it — and deliberately without running migrations, so a feature
branch can never migrate the production database.

Secrets set with `wrangler secret put` live on the Worker and survive deploys; they don't
need to be added to the build. Build variables are a separate, build-time-only thing.

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

An optional `X-Rater-Reporter` header makes the feedback one of that device's [conversations](#conversations). A malformed one is ignored rather than refused — losing the message would be worse than losing the follow-up.

### `PUT /v1/feedback/:id/attachments/:idx`

Step two. `Authorization: Bearer <upload_token>`, with the raw image bytes as the body.

This proxies through the Worker instead of using a presigned R2 URL: screenshots are already under 2MB, and proxying avoids maintaining S3 credentials on the client while giving size and type validation a single choke point. Re-uploading the same `idx` overwrites, which is what resumable retry needs.

### `POST /v1/feedback/:id/complete`

Step three. Marks the feedback complete, counts the attachments that actually arrived, and pushes the webhook notification asynchronously. Calling it again won't push twice.

### `POST /v1/telemetry`

Batched `shown` / `positive` / `negative` / `dismissed` / `submitted` events, used to compute the conversion funnel. Carries no user identifiers.

### Conversations

Every feedback a device sends becomes a thread it can follow from inside the app, and that the console answers into. These endpoints need `X-Rater-Reporter: <token>` as well as the app key.

The app key is public, so it can't say *who* is asking. The reporter token can: 32 random bytes the SDK generates once per install and keeps in the Keychain, sent with every feedback. D1 stores only its SHA-256. A thread belongs to the token it was sent with, and anything outside the caller's own threads is a plain `404`. Spam is hidden, and feedback that never completed isn't a thread.

| Endpoint | |
|---|---|
| `GET /v1/threads?before=` | The caller's threads, most recent activity first: `{ id, status, category, preview, last_author, last_message_at, unread_count }`. `status` is only `open` or `resolved`. |
| `GET /v1/threads/:id?after=<seq>` | The thread header plus its messages, or only those past `after` — what a client polls while the conversation is on screen. |
| `POST /v1/threads/:id/messages` | `{ idempotency_key, body }` → `201 { message }`. Idempotent like submissions; writing back reopens a resolved thread and pushes a "New reply" notification. |
| `POST /v1/threads/:id/read` | `{ seq }` moves the read marker. Forward only, and never past the newest message. |
| `GET /v1/inbox` | `{ unread_count, unread_threads }` for the app's badge. |
| `DELETE /v1/threads` | Erases everything this token ever sent — feedback, messages, screenshots. |

Transport is polling. RaterKit asks every 5 seconds while a conversation is open, every 15 while the list is, and for `/v1/inbox` when the app comes to the foreground. Timestamps are Unix milliseconds; `seq` only ever grows, so `after=` never skips a message.

## Admin console

`GET /admin` serves a React + TypeScript + Tailwind console. It covers feedback browsing and filtering (including threads awaiting a reply), detail with screenshot previews, status and internal notes, answering the user in an in-app conversation or by email, single and bulk deletion (screenshots included, straight out of R2), conversion funnel stats with a per-app reset, **live copy editing** and batch translation, and app registration and deactivation. Light and dark themes follow the OS and can be overridden.

Signing in with `ADMIN_TOKEN` yields a 7-day HttpOnly cookie. In production, consider putting [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of `/admin*` as a second layer.

The matching REST API lives under `/admin/api/*` and takes `Authorization: Bearer <ADMIN_TOKEN>`, so you can drive it from your own tooling.

### Localising the copy

Adding copy lets you pick **several languages at once** — one row is written per language with the copy you typed, ready to be edited or translated. Any row can also be duplicated into new locales, so a second language never means retyping a dozen fields.

With a translation key configured, the **Translate** action on a row machine-translates it into as many as 12 languages in one go. Category *ids* are the client's lookup keys and are never touched — only the labels are translated — and the results are shown for review, not saved: nothing reaches the database until you have read the copy and pressed Save.

Two providers are supported, configured with secrets. Anthropic:

```bash
npx wrangler secret put TRANSLATE_API_KEY     # sk-ant-...
# optional: TRANSLATE_MODEL (defaults to claude-opus-5)
```

Or anything speaking the OpenAI chat-completions dialect — DeepSeek, Moonshot, Qwen, OpenRouter, a local server:

```bash
npx wrangler secret put TRANSLATE_PROVIDER    # openai
npx wrangler secret put TRANSLATE_API_KEY
npx wrangler secret put TRANSLATE_MODEL       # required — every vendor names its models differently
npx wrangler secret put TRANSLATE_BASE_URL    # e.g. https://api.deepseek.com/v1
```

Leave `TRANSLATE_API_KEY` unset and the Translate button simply doesn't appear; everything else in the console works as before.

### Answering the user

The feedback detail view shows the conversation and a composer. A message goes into the app by default — the user sees it the next time they open the conversation — and the dialog refreshes every 5 seconds while it's open, marking whatever the user wrote as read. A "Seen" mark appears once the user has opened your message.

Feedback from an app version without conversations (no reporter token) can only be answered by email. With [Resend](https://resend.com) configured, any message can also be emailed, via an **Also email it** checkbox. The address comes from the feedback itself — never from the request — and a failed send stores nothing, so a message marked as emailed was accepted by the provider.

```bash
npx wrangler secret put RESEND_API_KEY        # re_...
npx wrangler secret put RESEND_FROM           # "Support <support@your-domain.com>" — domain verified in Resend
npx wrangler secret put RESEND_REPLY_TO       # optional; where the user's reply lands
```

Two things worth knowing. The `RESEND_FROM` domain has to be verified in Resend (SPF/DKIM), or the send comes back as a 502 quoting the provider's complaint. And Resend only sends: the user's reply goes to `RESEND_REPLY_TO`, not back into the console — point it at a mailbox you actually read, e.g. an address that [Email Routing](https://developers.cloudflare.com/email-routing/) forwards to you.

Leave `RESEND_API_KEY` unset and in-app messages work as before; email-only feedback gets the old `mailto:` button.

### Working on the console

The source lives in [`admin-ui/`](admin-ui). Vite collapses it into one self-contained HTML file, which `scripts/build-admin.mjs` inlines into `src/admin/dashboard.ts` — so deploying the Worker still deploys the console, with no second pipeline and no static-asset binding. That generated file is committed, which means a plain `wrangler deploy` never needs the UI toolchain.

```bash
npm run admin:install            # once
npm run admin:dev                # Vite on :5173, proxying /admin/api to wrangler dev on :8787
npm run admin:build              # rebuild and re-inline — run this before committing UI changes
```

## Notifications

Every new feedback — and every reply a user writes in a conversation, titled "New reply" — pushes once to each configured target. The two are independent — set both and both fire.

### Bark

```bash
npx wrangler secret put BARK_SERVER_URL    # https://api.day.app, or your own server
npx wrangler secret put BARK_DEVICE_KEY
```

Posts `{ title, body, url, group, isArchive }` to `<BARK_SERVER_URL>/<BARK_DEVICE_KEY>`. Bark gets its own pair of variables rather than riding on `NOTIFY_WEBHOOK_URL` because a self-hosted server has no recognisable host: `m.example.com` looks like any other endpoint, so the host sniffing below would send it generic JSON and the push would render as nothing.

### Webhook

With `NOTIFY_WEBHOOK_URL` set, the payload shape is picked from the host:

| Host | Shape |
|---|---|
| `*.slack.com` | `{ text }` |
| `*.discord.com` | `{ content }` |
| contains `bark` / `day.app` | `{ title, body, url, group }` |
| anything else | generic JSON (all fields plus `kind` — `feedback` or `reply` — `detailURL` and `summary`) |

A push that fails is logged and dropped — it never fails the client's submit.

## Abuse protection

The client API key ships inside the app binary, so it isn't a secret. Its job is to attribute traffic to an app and to let an abused key be revoked. The actual protection is layered:

1. The key must exist in the `apps` table with `enabled = 1`.
2. `SUBMIT_LIMIT` rate limits on `IP + app_id` at 5 submissions/minute; `READ_LIMIT` allows 60 reads/minute; `MESSAGE_LIMIT` allows 20 conversation messages/minute. Conversation routes add the reporter to the key, so people behind one carrier NAT don't share a quota.
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

Feedback contains an email the user chose to give and device information collected automatically, and is linked to a random per-install identifier (the reporter token) so the user can read the conversation back. Say so in your app's privacy policy before shipping — the token counts as an identifier on App Store privacy labels — and offer `DELETE /v1/threads` (RaterKit's `deleteConversationHistory()`) as the way to erase it all, and consider an R2 lifecycle rule to age out old screenshots:

```bash
npx wrangler r2 bucket lifecycle add rater-attachments --name expire-old --expire-days 365
```
