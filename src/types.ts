/**
 * Binding types (DB, ATTACHMENTS, the rate limiters, secrets) are generated from
 * wrangler.jsonc into worker-configuration.d.ts by `wrangler types`, so this is only
 * an alias — edit wrangler.jsonc, regenerate, and there is nothing to keep in sync
 * by hand. The exception is the required secrets, which live in no config file and so
 * are declared in src/env.d.ts.
 */
export type Env = Cloudflare.Env;

/**
 * Reads the optional notification webhook URL.
 *
 * It's an optional secret, so `wrangler types` omits the field in environments where
 * it isn't set — hence the explicit assertion. Augmenting `Cloudflare.Env` globally
 * would collide the moment someone does set it in their local .dev.vars: the
 * generated `string` and the augmented `string | undefined` conflict.
 */
export function notifyWebhookURL(env: Env): string | undefined {
  return (env as Env & { NOTIFY_WEBHOOK_URL?: string }).NOTIFY_WEBHOOK_URL || undefined;
}

/** The app record attached to the context after X-Rater-Key authentication. */
export interface AppRecord {
  id: string;
  name: string;
  app_store_id: string | null;
  enabled: number;
}

export type Variables = {
  app: AppRecord;
};

export type HonoEnv = { Bindings: Env; Variables: Variables };

/** Hard caps on request and upload sizes. */
export const LIMITS = {
  /** Maximum bytes for a single attachment. */
  attachmentBytes: 5 * 1024 * 1024,
  /** Maximum screenshots per feedback. */
  maxAttachments: 3,
  /** Maximum bytes for a JSON request body. */
  jsonBodyBytes: 64 * 1024,
  /** Upload token lifetime, in seconds. */
  uploadTokenTTL: 15 * 60,
  /** Accepted attachment MIME types. */
  imageTypes: ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'] as const,
} as const;
