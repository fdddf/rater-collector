import { Errors } from './errors';
import type { Env } from '../types';

/** Resolved sender identity for the reply-by-email feature. */
export interface EmailConfig {
  /** The `send_email` binding declared in wrangler.jsonc — Cloudflare Email Sending. */
  binding: SendEmail;
  /** Sender address, on a domain onboarded to Email Sending. */
  from: string | EmailAddress;
  /** Where the user's own reply lands. Email Sending only sends, so without this a reply goes to a mailbox nobody reads. */
  replyTo?: string | EmailAddress;
}

/**
 * Optional secrets are invisible to `wrangler types` in environments where they aren't
 * set, so they're read off a widened Env — same reason as `notifyWebhookURL`.
 *
 * `EMAIL` comes from wrangler.jsonc and so is always on the generated type, but it is
 * widened to optional here as well: the tests inject their own binding, and a Worker
 * deployed before the binding existed would otherwise crash instead of reporting it.
 */
type EmailEnv = Env & {
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
};

/**
 * Splits an RFC 5322 `Name <user@host>` into the two fields the binding takes, and passes
 * a bare address through untouched. The binding validates `from` as an address, so a
 * display name has to travel beside it rather than inline in the string.
 */
function address(value: string): string | EmailAddress {
  const match = /^(.*?)<\s*([^<>\s]+)\s*>$/.exec(value.trim());
  if (!match) return value.trim();
  const name = (match[1] ?? '').trim().replace(/^"(.*)"$/, '$1');
  const email = match[2] ?? '';
  return name ? { name, email } : email;
}

/**
 * Reads the sender configuration, or throws a message naming what is missing — a
 * half-configured console should say which secret it wants rather than failing at the
 * send with a code nobody can act on.
 */
export function emailConfig(env: Env): EmailConfig {
  const e = env as EmailEnv;

  if (!e.EMAIL) {
    throw Errors.badRequest(
      'Email replies are not configured — this Worker has no EMAIL binding (`send_email` in wrangler.jsonc).',
    );
  }

  const from = e.EMAIL_FROM?.trim();
  if (!from) {
    throw Errors.badRequest(
      'EMAIL_FROM is required — set it to a sender on a domain onboarded to Cloudflare Email Sending.',
    );
  }

  const replyTo = e.EMAIL_REPLY_TO?.trim();
  return {
    binding: e.EMAIL,
    from: address(from),
    replyTo: replyTo ? address(replyTo) : undefined,
  };
}

/** True when replies are wired up, used to hide the composer rather than to guard the route. */
export function emailConfigured(env: Env): boolean {
  const e = env as EmailEnv;
  return Boolean(e.EMAIL && e.EMAIL_FROM?.trim());
}

export interface ReplyMessage {
  to: string;
  subject: string;
  body: string;
}

/**
 * Sends one reply through the Email Sending binding and returns the message id.
 *
 * Plain text only. The body is whatever the admin typed, and text/plain is the one format
 * that can carry it verbatim — an HTML part would mean escaping user-authored prose on
 * every send, for no gain in a support reply.
 */
export async function sendReplyEmail(config: EmailConfig, message: ReplyMessage): Promise<string> {
  let result: EmailSendResult;
  try {
    result = await config.binding.send({
      to: message.to,
      from: config.from,
      subject: message.subject,
      text: message.body,
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
    });
  } catch (err) {
    // The binding throws an Error carrying a `code` — E_SENDER_DOMAIN_NOT_AVAILABLE,
    // E_RATE_LIMIT_EXCEEDED, E_RECIPIENT_SUPPRESSED and so on. The code is the part that
    // says what to fix, so it goes into the message the console shows.
    const code = (err as { code?: unknown }).code;
    const detail = err instanceof Error ? err.message : String(err);
    throw Errors.badGateway(
      `Email Sending rejected the message${typeof code === 'string' ? ` (${code})` : ''}: ${detail}`,
    );
  }

  if (!result?.messageId) {
    throw Errors.badGateway('Email Sending accepted the message but returned no id.');
  }
  return result.messageId;
}
