import { barkPushURL, notifyWebhookURL, type Env } from '../types';

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

/** What every target renders, in the two lengths the shapes need. */
interface Rendered {
  title: string;
  excerpt: string;
  summary: string;
  detailURL: string;
}

function render(env: Env, payload: NotifyPayload): Rendered {
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

  return { title: `New feedback — ${payload.appName}`, excerpt, summary, detailURL };
}

async function post(url: string, body: unknown, label: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`${label} push returned ${res.status}`);
  } catch (err) {
    console.error(`${label} push failed`, err);
  }
}

/**
 * Pushes a new-feedback notification to every configured target.
 *
 * For `NOTIFY_WEBHOOK_URL` the payload shape is picked from the webhook's host, so
 * anything unrecognised gets plain JSON — pointing it at a self-hosted endpoint needs
 * no code change. `BARK_SERVER_URL` + `BARK_DEVICE_KEY` is a separate target with a
 * fixed shape, since a self-hosted Bark server isn't recognisable by host.
 *
 * Callers should wrap this in `ctx.waitUntil()` so the push never delays the client's
 * submit response.
 */
export async function notifyNewFeedback(env: Env, payload: NotifyPayload): Promise<void> {
  const webhook = notifyWebhookURL(env);
  const bark = barkPushURL(env);
  if (!webhook && !bark) return;

  const { title, excerpt, summary, detailURL } = render(env, payload);
  const pushes: Promise<void>[] = [];

  if (bark) {
    pushes.push(
      post(
        bark,
        { title, body: summary, url: detailURL, group: 'Feedback', isArchive: 1 },
        'bark',
      ),
    );
  }

  if (webhook) {
    let host = '';
    try {
      host = new URL(webhook).host;
    } catch {
      host = '';
    }

    if (host) {
      let body: unknown;
      if (host.endsWith('slack.com')) {
        body = { text: summary };
      } else if (host.endsWith('discord.com') || host.endsWith('discordapp.com')) {
        body = { content: summary.slice(0, 1900) };
      } else if (host.includes('bark') || host.includes('day.app')) {
        body = { title, body: excerpt, url: detailURL, group: 'rater' };
      } else {
        body = { ...payload, detailURL, summary };
      }
      pushes.push(post(webhook, body, 'notify webhook'));
    }
  }

  await Promise.all(pushes);
}
