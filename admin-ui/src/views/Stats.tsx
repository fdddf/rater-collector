import { useCallback, useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { api, UnauthorizedError } from '../lib/api';
import { fmtCompact, fmtPercent } from '../lib/format';
import type { Stats as StatsData } from '../lib/types';
import DailyChart from '../components/DailyChart';
import { Card, EmptyState, SectionHeading, Select, Spinner, useToast } from '../components/ui';

const RANGES = [7, 30, 90];

/** Label · value stat tile. Proportional figures — these are display numbers, not a column. */
function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-surface-2 px-4 py-3">
      <p className="text-xs text-ink-2">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

/**
 * The prompt funnel as proportional bars. One measure (event count) across ordered stages,
 * so it's one hue throughout — the length carries the drop-off, and each value is labelled.
 */
function Funnel({ stages }: { stages: { label: string; n: number }[] }) {
  const top = Math.max(...stages.map((s) => s.n), 1);
  return (
    <ul className="space-y-2.5">
      {stages.map((s) => (
        <li key={s.label} className="grid grid-cols-[8rem_1fr_3.5rem] items-center gap-3">
          <span className="truncate text-xs text-ink-2">{s.label}</span>
          <span className="h-5 rounded-r-[4px] bg-surface-2">
            <span
              className="block h-5 rounded-r-[4px] bg-series"
              style={{ width: `${Math.max((s.n / top) * 100, s.n > 0 ? 1.5 : 0)}%` }}
            />
          </span>
          <span className="text-right text-sm text-ink tnum">{fmtCompact(s.n)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Stats({ appID, onUnauthorized }: { appID: string; onUnauthorized: () => void }) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<StatsData | null>(null);

  const load = useCallback(async () => {
    setStats(null);
    try {
      setStats(await api.stats({ days, app_id: appID }));
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Failed to load stats', 'error');
    }
  }, [days, appID, toast, onUnauthorized]);

  useEffect(() => {
    load();
  }, [load]);

  const f = stats?.funnel;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Time range"
          className="w-40"
        >
          {RANGES.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </Select>
      </div>

      {!stats || !f ? (
        <Card className="flex justify-center py-20">
          <Spinner />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Prompts shown" value={fmtCompact(f.shown)} />
            <Tile
              label="Positive rate"
              value={fmtPercent(f.positive_rate)}
              hint={`${fmtCompact(f.positive)} of ${fmtCompact(f.shown)} shown`}
            />
            <Tile label="Feedback submitted" value={fmtCompact(f.submitted)} />
            <Tile
              label="Open"
              value={fmtCompact(stats.feedback_by_status.open ?? 0)}
              hint={`${fmtCompact(stats.feedback_by_status.resolved ?? 0)} resolved`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <SectionHeading
                title="Prompt funnel"
                hint="Where people drop off between seeing the prompt and sending feedback."
              />
              <Funnel
                stages={[
                  { label: 'Shown', n: f.shown },
                  { label: 'Tapped positive', n: f.positive },
                  { label: 'Tapped negative', n: f.negative },
                  { label: 'Dismissed', n: f.dismissed },
                  { label: 'Feedback sent', n: f.submitted },
                ]}
              />
            </Card>

            <Card className="p-4">
              <SectionHeading title="Feedback per day" hint={`Submissions over the last ${stats.days} days.`} />
              {stats.feedback_daily.length > 0 ? (
                <DailyChart data={stats.feedback_daily} />
              ) : (
                <EmptyState icon={<BarChart3 className="size-8" />} title="No feedback in this period" />
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
