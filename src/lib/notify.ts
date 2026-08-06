import { notifyWebhookURL, type Env } from '../types';

export interface NotifyPayload {
  appName: string;
  appID: string;
  feedbackID: string;
  category: string | null;
  message: string;
  email: string | null;
  appVersion: string | null;
  deviceModel: string | null;
  osVersion: string | null;
  attachmentCount: number;
  country: string | null;
}

/**
 * Pushes a new-feedback notification. The payload shape is picked from the webhook's
 * host; anything unrecognised gets plain JSON — so pointing this at a self-hosted
 * endpoint needs no code change.
 *
 * Callers should wrap this in `ctx.waitUntil()` so the push never delays the client's
 * submit response.
 */
export async function notifyNewFeedback(env: Env, payload: NotifyPayload): Promise<void> {
  const url = notifyWebhookURL(env);
  if (!url) return;

  const detailURL = `${env.PUBLIC_BASE_URL}/admin#/feedback/${payload.feedbackID}`;
  const excerpt = payload.message.length > 300 ? `${payload.message.slice(0, 300)}…` : payload.message;
  const summary = [
    `📮 New feedback for ${payload.appName}`,
    payload.category ? `Category: ${payload.category}` : null,
    `Message: ${excerpt}`,
    payload.email ? `Email: ${payload.email}` : null,
    `Build: ${payload.appVersion ?? 'unknown version'} · ${payload.deviceModel ?? 'unknown device'} · ${payload.osVersion ?? 'unknown OS'}`,
    payload.attachmentCount > 0
      ? `Attachments: ${payload.attachmentCount} screenshot${payload.attachmentCount === 1 ? '' : 's'}`
      : null,
    detailURL,
  ]
    .filter(Boolean)
    .join('\n');

  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return;
  }

  let body: unknown;
  if (host.endsWith('slack.com')) {
    body = { text: summary };
  } else if (host.endsWith('discord.com') || host.endsWith('discordapp.com')) {
    body = { content: summary.slice(0, 1900) };
  } else if (host.includes('bark') || host.includes('day.app')) {
    body = {
      title: `New feedback — ${payload.appName}`,
      body: excerpt,
      url: detailURL,
      group: 'rater',
    };
  } else {
    body = { ...payload, detailURL, summary };
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('notify webhook failed', err);
  }
}
