import { useEffect, useRef, useState } from 'react';
import { Mail, Send, Trash2 } from 'lucide-react';
import { api, attachmentURL, UnauthorizedError } from '../lib/api';
import { fmtBytes, fmtTime } from '../lib/format';
import type {
  Attachment,
  FeedbackDetail as Detail,
  FeedbackReply,
  FeedbackStatus,
} from '../lib/types';
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  statusTone,
  useToast,
} from '../components/ui';

/** What the composer starts with — the same wording the mailto: fallback uses. */
const replySubject = (f: Detail) => `Re: your feedback · ${f.app_name}`;

const STATUSES: FeedbackStatus[] = ['open', 'resolved', 'spam', 'pending'];

/** The diagnostics the client attaches, laid out as a definition list. */
function diagnostics(f: Detail): [string, string][] {
  const meta = f.metadata ? Object.entries(f.metadata) : [];
  return [
    ['App', f.app_name],
    ['Received', fmtTime(f.created_at)],
    ['Category', f.category || '—'],
    ['Email', f.email || 'not provided'],
    ['App version', `${f.app_version || '?'} (${f.build || '?'})`],
    ['Bundle ID', f.bundle_id || '—'],
    ['OS', f.os_version || '—'],
    ['Device', f.device_model || '—'],
    ['Language / region', `${f.locale || '?'} / ${f.region || '?'}`],
    ['Time zone', f.timezone || '—'],
    ['Days installed', String(f.install_days ?? '—')],
    ['Launches', String(f.launch_count ?? '—')],
    ['Country', f.ip_country || '—'],
    ...meta.map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  ];
}

export default function FeedbackDetail({
  id,
  onClose,
  onChanged,
  onUnauthorized,
}: {
  id: string | null;
  onClose: () => void;
  /** Fired after a save or a delete — the list behind the dialog has to reload either way. */
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [replies, setReplies] = useState<FeedbackReply[]>([]);
  const [status, setStatus] = useState<string>('open');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [subject, setSubject] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  // Whether the server has Resend credentials. Failing quietly leaves the mailto: fallback.
  const [canReply, setCanReply] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((s) => setCanReply(s.reply_enabled))
      .catch(() => setCanReply(false));
  }, []);

  // The parent passes these as inline arrows, so their identity changes on every one of its
  // renders — including the ones the list itself triggers. Reading them through a ref keeps
  // the fetch below keyed on `id` alone; listing them as deps would refetch (and blank the
  // dialog) each time the list behind it re-rendered.
  const handlers = useRef({ toast, onClose, onUnauthorized });
  handlers.current = { toast, onClose, onUnauthorized };

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    api
      .feedbackDetail(id)
      .then((data) => {
        if (cancelled) return;
        setDetail(data.feedback);
        setAttachments(data.attachments);
        setReplies(data.replies);
        setStatus(data.feedback.status);
        setNote(data.feedback.admin_note ?? '');
        setSubject(replySubject(data.feedback));
        setReplyBody('');
      })
      .catch((err) => {
        if (cancelled) return;
        const { toast: t, onClose: close, onUnauthorized: expired } = handlers.current;
        if (err instanceof UnauthorizedError) return expired();
        t(err instanceof Error ? err.message : 'Failed to load feedback', 'error');
        close();
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function save() {
    if (!id) return;
    setSaving(true);
    try {
      await api.patchFeedback(id, { status, admin_note: note });
      toast('Saved');
      onChanged();
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function sendReply() {
    if (!id) return;
    setSending(true);
    try {
      const { reply } = await api.replyToFeedback(id, { subject, body: replyBody });
      setReplies((prev) => [...prev, reply]);
      setReplyBody('');
      toast('Reply sent');
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    if (!id) return;
    const shots = attachments.length;
    if (
      !confirm(
        'Delete this feedback permanently?' +
          (shots > 0 ? `\n\nIts ${shots} screenshot${shots > 1 ? 's' : ''} will be deleted too.` : ''),
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await api.deleteFeedback(id);
      toast('Deleted');
      onChanged();
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      open={id !== null}
      onClose={onClose}
      title="Feedback detail"
      size="lg"
      footer={
        detail ? (
          <>
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Status"
              className="w-36"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={save} busy={saving}>
              Save
            </Button>
            {detail.email && !canReply && (
              <a
                href={`mailto:${detail.email}?subject=${encodeURIComponent(replySubject(detail))}`}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium text-ink-2 ring-1 ring-border ring-inset transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Mail className="size-4" />
                Reply by email
              </a>
            )}
            <Button
              variant="ghost"
              busy={deleting}
              onClick={remove}
              className="ml-auto text-critical hover:text-critical"
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </>
        ) : undefined
      }
    >
      {!detail ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(detail.status)}>{detail.status}</Badge>
            {detail.category && <Badge>{detail.category}</Badge>}
            <span className="text-xs text-ink-3">{fmtTime(detail.created_at)}</span>
          </div>

          <blockquote className="rounded-xl bg-surface-2 p-4 text-sm leading-relaxed whitespace-pre-wrap">
            {detail.message}
          </blockquote>

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {attachments.map((a) => (
                <a
                  key={a.idx}
                  href={attachmentURL(a.r2_key)}
                  target="_blank"
                  rel="noreferrer"
                  title={`Screenshot ${a.idx + 1} · ${fmtBytes(a.bytes)}`}
                  className="block overflow-hidden rounded-xl ring-1 ring-border transition-shadow hover:ring-accent"
                >
                  <img
                    src={attachmentURL(a.r2_key)}
                    alt={`Screenshot ${a.idx + 1}`}
                    loading="lazy"
                    className="max-h-64 w-auto"
                  />
                </a>
              ))}
            </div>
          )}

          <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1.5 rounded-xl bg-surface-2 p-4 text-[13px]">
            {diagnostics(detail).map(([k, v]) => (
              <div key={k} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-ink-3">{k}</dt>
                <dd className="break-words text-ink-2">{v}</dd>
              </div>
            ))}
          </dl>

          {detail.email && (
            <section className="space-y-3 rounded-xl ring-1 ring-border ring-inset p-4">
              <header className="flex items-center gap-2 text-xs font-medium text-ink-2">
                <Mail className="size-4 text-ink-3" />
                Email reply
                <span className="text-ink-3">to {detail.email}</span>
              </header>

              {replies.length > 0 && (
                <ol className="space-y-2">
                  {replies.map((r) => (
                    <li key={r.id} className="rounded-lg bg-surface-2 p-3 text-[13px]">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-medium">{r.subject}</span>
                        <span className="text-xs text-ink-3">{fmtTime(r.sent_at)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-ink-2">{r.body}</p>
                    </li>
                  ))}
                </ol>
              )}

              {canReply ? (
                <>
                  <Field label="Subject">
                    {(fid) => (
                      <Input
                        id={fid}
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Message">
                    {(fid) => (
                      <Textarea
                        id={fid}
                        value={replyBody}
                        onChange={(e) => setReplyBody(e.target.value)}
                        rows={6}
                        placeholder="Sent to the user as plain text. Their reply goes to your support inbox, not back into this console."
                      />
                    )}
                  </Field>
                  <Button
                    variant="primary"
                    busy={sending}
                    disabled={!subject.trim() || !replyBody.trim()}
                    onClick={sendReply}
                  >
                    <Send className="size-4" />
                    Send reply
                  </Button>
                </>
              ) : (
                <p className="text-xs text-ink-3">
                  Sending from the console needs the RESEND_API_KEY and RESEND_FROM secrets. Until
                  they're set, use the “Reply by email” button below to open your mail client.
                </p>
              )}
            </section>
          )}

          <Field label="Internal note">
            {(fid) => (
              <Textarea
                id={fid}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Only visible here — never sent to the user."
              />
            )}
          </Field>
        </div>
      )}
    </Modal>
  );
}
