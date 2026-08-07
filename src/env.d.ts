// Secrets live outside wrangler.jsonc, so `wrangler types` only writes them into
// worker-configuration.d.ts when a local .dev.vars happens to exist. CI has none, and
// `npm run typecheck` failed there on ADMIN_TOKEN / UPLOAD_HMAC_SECRET. Declaring the
// required ones here merges into the generated `Cloudflare.Env` (see src/types.ts) so the
// type is the same with or without .dev.vars — both declare them `string`, so they agree.
//
// Only secrets the Worker requires belong here. The optional ones (NOTIFY_WEBHOOK_URL,
// TRANSLATE_*) must stay off the list: declaring them `string | undefined` would conflict
// with the generated `string` whenever someone does set them locally. Their readers narrow
// Env themselves (src/types.ts, src/lib/translate.ts) so "not configured" stays a typed case.
declare namespace Cloudflare {
  interface Env {
    /** Password for the admin console. */
    ADMIN_TOKEN: string;
    /** Key used to sign attachment upload tokens. */
    UPLOAD_HMAC_SECRET: string;
  }
}
