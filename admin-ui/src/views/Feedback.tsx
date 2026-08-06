import { useCallback, useEffect, useRef, useState } from 'react';
import { Inbox, Paperclip, Search } from 'lucide-react';
import { api, UnauthorizedError } from '../lib/api';
import { fmtRelative, fmtTime } from '../lib/format';
import type { FeedbackRow } from '../lib/types';
import { Badge, Button, Card, EmptyState, Input, Select, Spinner, statusTone, useToast } from '../components/ui';
import FeedbackDetail from './FeedbackDetail';

const STATUSES = ['', 'open', 'resolved', 'spam', 'pending'] as const;

export default function Feedback({ appID, onUnauthorized }: { appID: string; onUnauthorized: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [openID, setOpenID] = useState<string | null>(null);

  // The debounce timer is a ref so re-renders don't restart it.
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(
    async (before: number | null) => {
      setLoading(true);
      try {
        const data = await api.feedback({ app_id: appID, status, q: query.trim(), before });
        setRows((prev) => (before === null ? data.items : [...prev, ...data.items]));
        setCursor(data.next_before);
      } catch (err) {
        if (err instanceof UnauthorizedError) return onUnauthorized();
        toast(err instanceof Error ? err.message : 'Failed to load feedback', 'error');
      } finally {
        setLoading(false);
      }
    },
    [appID, status, query, toast, onUnauthorized],
  );

  // Typing in the search box shouldn't fire a request per keystroke.
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(null), query ? 300 : 0);
    return () => clearTimeout(debounce.current);
  }, [load, query]);

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-2.5">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search message or email"
            aria-label="Search message or email"
            className="pl-9"
          />
        </div>
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status"
          className="w-36"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'All statuses' : s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </Select>
        <Button onClick={() => load(null)} busy={loading && rows.length === 0}>
          Refresh
        </Button>
      </Card>

      <Card className="overflow-hidden">
        {rows.length === 0 && loading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-8" />}
            title="No feedback yet"
            hint="Submissions from your apps land here as soon as they arrive."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-3xl text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-ink-2">
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">App</th>
                  <th className="px-4 py-2.5 font-medium">Message</th>
                  <th className="px-4 py-2.5 font-medium">Version / device</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr
                    key={f.id}
                    tabIndex={0}
                    onClick={() => setOpenID(f.id)}
                    onKeyDown={(e) => e.key === 'Enter' && setOpenID(f.id)}
                    className="cursor-pointer border-b border-border/70 transition-colors last:border-0 hover:bg-surface-2 focus-visible:bg-surface-2"
                  >
                    <td className="px-4 py-3 align-top whitespace-nowrap text-ink-2 tnum">
                      <span title={fmtTime(f.created_at)}>{fmtRelative(f.created_at)}</span>
                    </td>
                    <td className="px-4 py-3 align-top whitespace-nowrap">{f.app_name}</td>
                    <td className="max-w-md px-4 py-3 align-top">
                      <p className="line-clamp-2 text-ink">{f.message}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {f.category && <Badge>{f.category}</Badge>}
                        {!!f.attachment_count && (
                          <span className="inline-flex items-center gap-1 text-xs text-ink-3">
                            <Paperclip className="size-3" />
                            {f.attachment_count}
                          </span>
                        )}
                        {f.email && <span className="text-xs text-ink-3">{f.email}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top whitespace-nowrap text-xs text-ink-2">
                      {f.app_version || '?'}
                      <br />
                      {f.device_model || '?'}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <Badge tone={statusTone(f.status)}>{f.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {cursor && (
        <div className="flex justify-center">
          <Button onClick={() => load(cursor)} busy={loading}>
            Load more
          </Button>
        </div>
      )}

      <FeedbackDetail
        id={openID}
        onClose={() => setOpenID(null)}
        onSaved={() => {
          setOpenID(null);
          load(null);
        }}
        onUnauthorized={onUnauthorized}
      />
    </div>
  );
}
