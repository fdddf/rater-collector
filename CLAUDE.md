# rater-collector

Cloudflare Worker (D1 + R2) behind in-app rating prompts and feedback, plus a React admin
console. The iOS client lives in a separate repo, [RaterKit](https://github.com/fdddf/RaterKit).

## The admin console is a committed build artifact

`src/admin/dashboard.ts` holds the entire console as one inlined HTML string, and it is
**committed**. That file — not `admin-ui/` — is what the Worker serves, so editing
`admin-ui/` alone changes nothing that anyone can see.

After any change under `admin-ui/`, run:

```bash
npm run admin:build   # vite build → admin-ui/dist/index.html → src/admin/dashboard.ts
```

and commit the regenerated `src/admin/dashboard.ts` alongside the source change.

`npm --prefix admin-ui run build` is **not** enough: it stops at `admin-ui/dist/` (which is
gitignored) and never runs `scripts/build-admin.mjs`, the step that regenerates
`dashboard.ts`. Deploys go out from git automatically, so a commit missing the regenerated
file ships a console that silently lags the source.

## Commands

```bash
npm run dev          # wrangler dev
npm test             # vitest, against a local D1
npm run typecheck    # worker + test tsconfigs
npm run admin:dev    # console with hot reload, proxying to wrangler dev
npm run deploy       # migrations then wrangler deploy — normally unnecessary, see below
```

## Deploys

Pushing to `main` deploys through Cloudflare's git integration. `npm run deploy` is the
manual path and is not the usual one. The build command that Cloudflare runs is configured
in the Cloudflare dashboard, not in this repo — check there before assuming a step (a
migration, the console build) happens automatically.

GitHub Actions (`.github/workflows/ci.yml`) runs `npm run typecheck` and `vitest` on every
push to `main` and every PR. Neither catches a stale `src/admin/dashboard.ts` — that one is
on you.

New migrations under `migrations/` need `npm run migrate:remote` against the production D1,
and have to be applied before the code that depends on them goes live.

## Conventions

- App API keys (`rtr_pub_…`) ship inside app binaries and are **not** secrets — see the
  comment on `requireAppKey` in `src/middleware/auth.ts`. D1 stores only their SHA-256, so a
  lost key is unrecoverable; the recovery path is `POST /admin/api/apps/:id/rotate-key`
  ("New key" in the Apps table), which retires the old key immediately.
- No `vars` block in `wrangler.jsonc` on purpose — this repo is public, so every
  environment value is a secret (`wrangler secret put`) and is declared in `src/env.d.ts`
  so CI type-checks catch a missing one.
- Never add `"remote": true` to the D1 binding: `vitest.config.ts` reads the same
  `wrangler.jsonc`, and the tests `DELETE FROM` every table before each run.
