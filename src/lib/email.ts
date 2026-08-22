import { Errors } from './errors';
import type { Env } from '../types';

/** Resolved sender identity for the reply-by-email feature. */
export interface EmailConfig {
  apiKey: string;
  /** RFC 5322 From — either "user@domain" or "Name <user@domain>". The domain must be verified in Resend. */
  from: string;
  /** Where the user's own reply lands. Resend only sends, so without this a reply goes to a mailbox nobody reads. */
  replyTo?: string;
}

/**
 * Optional secrets are invisible to `wrangler types` in environments where they aren't
 * set, so they're read off a widened Env — same reason as `notifyWebhookURL`.
 */
type EmailEnv = Env & {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RESEND_REPLY_TO?: string;
};

/**
 * Reads the sender configuration, or throws a message naming the missing variable — a
 * half-configured console should say which secret it wants rather than failing at Resend
 * with a 422 nobody can act on.
 */
export function emailConfig(env: Env): EmailConfig {
  const e = env as EmailEnv;

  const apiKey = e.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw Errors.badRequest(
      'Email replies are not configured — set the RESEND_API_KEY secret to enable them.',
    );
  }

  const from = e.RESEND_FROM?.trim();
  if (!from) {
    throw Errors.badRequest(
      'RESEND_FROM is required — set it to a sender on a domain verified in Resend.',
    );
  }

  return { apiKey, from, replyTo: e.RESEND_REPLY_TO?.trim() || undefined };
}

/** True when replies are wired up, used to hide the composer rather than to guard the route. */
export function emailConfigured(env: Env): boolean {
  const e = env as EmailEnv;
  return Boolean(e.RESEND_API_KEY?.trim() && e.RESEND_FROM?.trim());
}

export interface ReplyMessage {
  to: string;
  subject: string;
  body: string;
}

/**
 * Sends one reply through Resend and returns the provider's message id.
 *
 * Plain text only. The body is whatever the admin typed, and text/plain is the one format
 * that can carry it verbatim — an HTML part would mean escaping user-authored prose on
 * every send, for no gain in a support reply.
 */
export async function sendReplyEmail(config: EmailConfig, message: ReplyMessage): Promise<string> {
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: message.body,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
      }),
    });
  } catch (err) {
    throw Errors.badGateway(
      `Could not reach Resend: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    // Resend answers with { name, message, statusCode }; anything else falls back to the
    // raw text so a proxy's HTML error page still reaches the console readable.
    const raw = await response.text().catch(() => '');
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      // keep the raw text
    }
    throw Errors.badGateway(`Resend rejected the message (${response.status}): ${detail}`);
  }

  const data = (await response.json().catch(() => null)) as { id?: string } | null;
  if (!data?.id) throw Errors.badGateway('Resend accepted the message but returned no id.');
  return data.id;
}
