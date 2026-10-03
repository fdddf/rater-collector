import { useEffect, useRef, useState } from 'react';
import { CheckCheck, Mail, MessagesSquare, Send, Trash2 } from 'lucide-react';
import { api, attachmentURL, UnauthorizedError } from '../lib/api';
import { fmtBytes, fmtTime } from '../lib/format';
import type {
  Attachment,
  FeedbackDetail as Detail,
  FeedbackMessage,
  FeedbackStatus,
} from '../lib/types';
import {
  Badge,
  Button,
  Checkbox,
  cx,
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

/** How often an open dialog picks up new messages — the same cadence the SDK polls at. */
const POLL_MS = 5000;

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
  const [messages, setMessages] = useState<FeedbackMessage[]>([]);
  const [userReadSeq, setUserReadSeq] = useState(0);
  const [status, setStatus] = useState<string>('open');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [subject, setSubject] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [alsoEmail, setAlsoEmail] = useState(false);
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
        setMessages(data.messages);
        setUserReadSeq(data.user_read_seq);
        setStatus(data.feedback.status);
        setNote(data.feedback.admin_note ?? '');
        setSubject(replySubject(data.feedback));
        setReplyBody('');
        setAlsoEmail(false);
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

  // While the dialog is open, pick up what the user writes in the meantime. Only the
  // conversation is refreshed — status and note may be mid-edit and must not be reset
  // under the cursor. A hidden tab skips its turn rather than polling nobody.
  useEffect(() => {
    if (!id) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api
        .feedbackDetail(id)
        .then((data) => {
          setMessages((prev) =>
            data.messages.length === prev.length && data.messages.at(-1)?.id === prev.at(-1)?.id
              ? prev
              : data.messages,
          );
          setUserReadSeq(data.user_read_seq);
        })
        .catch((err) => {
          if (err instanceof UnauthorizedError) handlers.current.onUnauthorized();
          // Anything else is one missed beat; the next one tries again.
        });
    }, POLL_MS);
    return () => clearInterval(timer);
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
    if (!id || !detail) return;
    // Without a reporter token the user can't see an in-app message, so email is the only way.
    const email = alsoEmail || !detail.in_app ? { subject } : undefined;
    setSending(true);
    try {
      const { message } = await api.sendMessage(id, { body: replyBody, email });
      setMessages((prev) => [...prev, message]);
      setReplyBody('');
      toast(email ? 'Sent and emailed' : 'Sent');
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

          <Conversation
            detail={detail}
            messages={messages}
            userReadSeq={userReadSeq}
            canEmail={canReply && !!detail.email}
            alsoEmail={alsoEmail}
            setAlsoEmail={setAlsoEmail}
            subject={subject}
            setSubject={setSubject}
            body={replyBody}
            setBody={setReplyBody}
            sending={sending}
            onSend={sendReply}
          />

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

/**
 * The thread after the feedback itself, and the composer.
 *
 * A message goes into the app by default. Email is an extra the admin opts into per
 * message — or the only route, for feedback from a client that predates conversations.
 */
function Conversation({
  detail,
  messages,
  userReadSeq,
  canEmail,
  alsoEmail,
  setAlsoEmail,
  subject,
  setSubject,
  body,
  setBody,
  sending,
  onSend,
}: {
  detail: Detail;
  messages: FeedbackMessage[];
  userReadSeq: number;
  canEmail: boolean;
  alsoEmail: boolean;
  setAlsoEmail: (v: boolean) => void;
  subject: string;
  setSubject: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
  sending: boolean;
  onSend: () => void;
}) {
  const emailOnly = !detail.in_app;
  const emailing = emailOnly || alsoEmail;
  const canCompose = detail.in_app || canEmail;

  // Nothing to show and no way to say anything: leave the footer's mailto: to it.
  if (messages.length === 0 && !canCompose) return null;

  return (
    <section className="space-y-3 rounded-xl ring-1 ring-border ring-inset p-4">
      <header className="flex flex-wrap items-center gap-2 text-xs font-medium text-ink-2">
        <MessagesSquare className="size-4 text-ink-3" />
        Conversation
        <span className="font-normal text-ink-3">
          {emailOnly
            ? 'This app version predates in-app conversations — replies go by email.'
            : 'Replies show up in the app.'}
        </span>
      </header>

      {messages.length > 0 && (
        <ol className="space-y-2">
          {messages.map((m) => {
            const mine = m.author === 'admin';
            return (
              <li key={m.id} className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
                <div
                  className={cx(
                    'max-w-[85%] rounded-xl p-3 text-[13px]',
                    mine ? 'bg-accent-wash ring-1 ring-accent/30 ring-inset' : 'bg-surface-2',
                  )}
                >
                  <p className="whitespace-pre-wrap text-ink">{m.body}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-3">
                    <span>{mine ? 'You' : 'User'} · {fmtTime(m.created_at)}</span>
                    {m.email_to && (
                      <span className="inline-flex items-center gap-1" title={m.email_subject ?? ''}>
                        <Mail className="size-3" />
                        emailed to {m.email_to}
                      </span>
                    )}
                    {mine && detail.in_app && m.seq <= userReadSeq && (
                      <span className="inline-flex items-center gap-1">
                        <CheckCheck className="size-3" />
                        Seen
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {canCompose ? (
        <>
          <Field label="Message">
            {(fid) => (
              <Textarea
                id={fid}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder={
                  emailOnly
                    ? 'Sent to the user as plain text. Their reply goes to your support inbox, not back into this console.'
                    : 'Plain text. The user sees it next time they open the conversation in the app.'
                }
              />
            )}
          </Field>
          {!emailOnly && canEmail && (
            <Checkbox
              label={`Also email it to ${detail.email}`}
              checked={alsoEmail}
              onChange={(e) => setAlsoEmail(e.target.checked)}
            />
          )}
          {emailing && (
            <Field label="Email subject">
              {(fid) => (
                <Input id={fid} value={subject} onChange={(e) => setSubject(e.target.value)} />
              )}
            </Field>
          )}
          <Button
            variant="primary"
            busy={sending}
            disabled={!body.trim() || (emailing && !subject.trim())}
            onClick={onSend}
          >
            <Send className="size-4" />
            {emailOnly ? 'Send email' : 'Send'}
          </Button>
        </>
      ) : detail.email ? (
        <p className="text-xs text-ink-3">
          Sending from the console needs the RESEND_API_KEY and RESEND_FROM secrets. Until
          they're set, use the “Reply by email” button below to open your mail client.
        </p>
      ) : (
        <p className="text-xs text-ink-3">
          No email address was left, and this app version can't receive in-app replies.
        </p>
      )}
    </section>
  );
}
