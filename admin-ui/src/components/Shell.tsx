import { useState, type ReactNode } from 'react';
import {
  BarChart3,
  Boxes,
  Inbox,
  LogOut,
  Menu,
  MessageSquareHeart,
  Moon,
  Sun,
  Type,
  X,
} from 'lucide-react';
import type { App } from '../lib/types';
import { Button, Select, cx } from './ui';

export type TabKey = 'feedback' | 'stats' | 'prompts' | 'apps';

export const TABS: { key: TabKey; label: string; icon: typeof Inbox }[] = [
  { key: 'feedback', label: 'Feedback', icon: Inbox },
  { key: 'stats', label: 'Stats', icon: BarChart3 },
  { key: 'prompts', label: 'Copy', icon: Type },
  { key: 'apps', label: 'Apps', icon: Boxes },
];

/** Persists the choice so it survives a reload; see the boot-time seeding in main.tsx. */
function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('rater.theme', next ? 'dark' : 'light');
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      className="px-2"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

/**
 * Sidebar + header frame. The app selector lives in the header rather than per-view because
 * every tab except Apps is scoped by it, and keeping the selection across tabs is the point.
 */
export default function Shell({
  tab,
  onTab,
  apps,
  appID,
  onAppID,
  onSignOut,
  children,
}: {
  tab: TabKey;
  onTab: (tab: TabKey) => void;
  apps: App[];
  appID: string;
  onAppID: (id: string) => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {TABS.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          onClick={() => {
            onTab(key);
            setNavOpen(false);
          }}
          aria-current={tab === key ? 'page' : undefined}
          className={cx(
            'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            tab === key
              ? 'bg-accent-wash text-accent'
              : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
          )}
        >
          <Icon className="size-4 shrink-0" />
          {label}
        </button>
      ))}
    </nav>
  );

  return (
    <div className="min-h-dvh bg-page">
      {/* Sidebar — fixed on desktop, a slide-over below `lg`. */}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border bg-surface px-3 py-4',
          'transition-transform lg:translate-x-0',
          navOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
        )}
      >
        <div className="mb-6 flex items-center gap-2.5 px-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <MessageSquareHeart className="size-4.5" />
          </span>
          <span className="mr-auto text-sm font-semibold">Rater</span>
          <Button
            variant="ghost"
            size="sm"
            className="px-2 lg:hidden"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </Button>
        </div>

        {nav}

        <div className="mt-auto flex items-center gap-1 px-1 pt-4">
          <Button variant="ghost" size="sm" onClick={onSignOut} className="mr-auto">
            <LogOut className="size-4" />
            Sign out
          </Button>
          <ThemeToggle />
        </div>
      </aside>

      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-surface/85 px-4 py-2.5 backdrop-blur-md sm:px-6">
          <Button
            variant="ghost"
            size="sm"
            className="px-2 lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="size-4" />
          </Button>

          <h1 className="mr-auto text-sm font-semibold">
            {TABS.find((t) => t.key === tab)?.label}
          </h1>

          <Select
            value={appID}
            onChange={(e) => onAppID(e.target.value)}
            aria-label="Filter by app"
            className="max-w-52"
          >
            <option value="">All apps</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
