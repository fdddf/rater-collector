/** Shapes returned by `/admin/api/*` — mirrors worker/src/routes/admin.ts. */

export type FeedbackStatus = 'open' | 'resolved' | 'spam' | 'pending';

export interface App {
  id: string;
  name: string;
  app_store_id: string | null;
  enabled: 0 | 1;
  created_at: number;
}

export interface NewAppResult {
  id: string;
  name: string;
  app_store_id: string | null;
  api_key: string;
}

/** A row in the feedback table — the list query selects a subset of the columns. */
export interface FeedbackRow {
  id: string;
  app_id: string;
  app_name: string;
  created_at: number;
  status: FeedbackStatus;
  category: string | null;
  message: string;
  email: string | null;
  app_version: string | null;
  device_model: string | null;
  os_version: string | null;
  ip_country: string | null;
  attachment_count: number | null;
  /** The newest message in either direction — the feedback itself counts. */
  last_message_at: number;
  /** SQLite's boolean: 1 when the feedback came with a reporter token, so in-app messages reach the user. */
  in_app: 0 | 1;
  /** Messages from the user the console hasn't opened yet. */
  unread_count: number;
}

/** `GET /feedback/:id` returns every column, so the row fields plus the diagnostics. */
export interface FeedbackDetail extends Omit<FeedbackRow, 'in_app' | 'unread_count'> {
  /** Whether the user can see in-app messages; without it the only way to answer is email. */
  in_app: boolean;
  build: string | null;
  bundle_id: string | null;
  locale: string | null;
  region: string | null;
  timezone: string | null;
  install_days: number | null;
  launch_count: number | null;
  admin_note: string | null;
  metadata: Record<string, unknown> | null;
}

/** One message after the feedback itself, from either side. */
export interface FeedbackMessage {
  /** Ordering and read-marker cursor. */
  seq: number;
  id: string;
  author: 'user' | 'admin';
  body: string;
  created_at: number;
  /** Set on an admin message that was also emailed. */
  email_to: string | null;
  email_subject: string | null;
}

export interface Attachment {
  idx: number;
  r2_key: string;
  content_type: string;
  bytes: number;
}

export interface PromptCategory {
  id: string;
  label: string;
}

export interface PromptConfig {
  id: string;
  app_id: string;
  locale: string;
  min_app_version: string;
  enabled: boolean;
  variant: string;
  title: string;
  message: string;
  positive_label: string;
  negative_label: string;
  later_label: string;
  feedback_title: string | null;
  feedback_message: string | null;
  email_required: boolean;
  categories: PromptCategory[];
  rules: Record<string, unknown> | null;
  updated_at: number;
}

/** The editor works on a draft that may not have been saved yet, so `id` is optional. */
export type PromptDraft = Omit<PromptConfig, 'id' | 'app_id' | 'updated_at'> &
  Partial<Pick<PromptConfig, 'id'>>;

/** Server capabilities, so the console can hide what isn't wired up. */
export interface Settings {
  translate_enabled: boolean;
  /** Whether Resend is configured; without it the detail view falls back to a mailto: link. */
  reply_enabled: boolean;
}

/** Machine translations awaiting review — `prompts` are unsaved drafts, one per locale that succeeded. */
export interface TranslateResult {
  prompts: PromptDraft[];
  errors: { locale: string; message: string }[];
}

export interface Stats {
  days: number;
  funnel: {
    shown: number;
    positive: number;
    negative: number;
    dismissed: number;
    submitted: number;
    positive_rate: number | null;
    negative_rate: number | null;
  };
  feedback_by_status: Partial<Record<FeedbackStatus, number>>;
  feedback_daily: { day: string; n: number }[];
}
