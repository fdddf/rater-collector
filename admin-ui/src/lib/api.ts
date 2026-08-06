import type {
  App,
  Attachment,
  FeedbackDetail,
  FeedbackRow,
  NewAppResult,
  PromptConfig,
  PromptDraft,
  Stats,
} from './types';

/** Thrown on a 401 so callers can bounce back to the sign-in screen instead of showing a toast. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Session expired — please sign in again.');
    this.name = 'UnauthorizedError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch('/admin/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export interface FeedbackQuery {
  app_id?: string;
  status?: string;
  q?: string;
  before?: number | null;
}

export const api = {
  login: (token: string) => send<{ ok: true }>('POST', '/login', { token }),
  logout: () => send<{ ok: true }>('POST', '/logout'),

  apps: () => request<{ apps: App[] }>('/apps'),
  createApp: (body: { name: string; id?: string; app_store_id?: string }) =>
    send<NewAppResult>('POST', '/apps', body),
  patchApp: (id: string, body: { enabled?: boolean; name?: string; app_store_id?: string | null }) =>
    send<{ ok: true }>('PATCH', `/apps/${encodeURIComponent(id)}`, body),

  prompts: (appID: string) =>
    request<{ prompts: PromptConfig[] }>(`/apps/${encodeURIComponent(appID)}/prompts`),
  putPrompt: (appID: string, body: PromptDraft) =>
    send<{ ok: true }>('PUT', `/apps/${encodeURIComponent(appID)}/prompts`, body),
  deletePrompt: (id: string) => send<{ ok: true }>('DELETE', `/prompts/${encodeURIComponent(id)}`),

  feedback: (query: FeedbackQuery) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) p.set(k, String(v));
    return request<{ items: FeedbackRow[]; next_before: number | null }>(`/feedback?${p}`);
  },
  feedbackDetail: (id: string) =>
    request<{ feedback: FeedbackDetail; attachments: Attachment[] }>(
      `/feedback/${encodeURIComponent(id)}`,
    ),
  patchFeedback: (id: string, body: { status?: string; admin_note?: string }) =>
    send<{ ok: true }>('PATCH', `/feedback/${encodeURIComponent(id)}`, body),

  stats: (query: { days: number; app_id?: string }) => {
    const p = new URLSearchParams({ days: String(query.days) });
    if (query.app_id) p.set('app_id', query.app_id);
    return request<Stats>(`/stats?${p}`);
  },
};

/** R2 keys contain slashes, which have to survive into the path rather than being escaped away. */
export const attachmentURL = (r2Key: string) =>
  '/admin/api/attachments/' + r2Key.split('/').map(encodeURIComponent).join('/');
