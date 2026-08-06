import { useCallback, useEffect, useState } from 'react';
import { api, UnauthorizedError } from './lib/api';
import type { App as AppRecord } from './lib/types';
import Shell, { type TabKey } from './components/Shell';
import { Spinner, ToastProvider } from './components/ui';
import Login from './views/Login';
import Feedback from './views/Feedback';
import Stats from './views/Stats';
import Prompts from './views/Prompts';
import Apps from './views/Apps';

type Session = 'checking' | 'out' | 'in';

function Console() {
  const [session, setSession] = useState<Session>('checking');
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [appID, setAppID] = useState('');
  const [tab, setTab] = useState<TabKey>('feedback');

  /** Doubles as the session probe: the cookie may still be valid from a previous visit. */
  const loadApps = useCallback(async () => {
    try {
      setApps((await api.apps()).apps);
      setSession('in');
    } catch (err) {
      if (err instanceof UnauthorizedError) setSession('out');
      else setSession('in'); // a transient failure shouldn't log a signed-in admin out
    }
  }, []);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  const signOut = async () => {
    await api.logout().catch(() => {});
    setSession('out');
    setApps([]);
  };

  const onUnauthorized = useCallback(() => setSession('out'), []);

  if (session === 'checking') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-page">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (session === 'out') return <Login onSignedIn={loadApps} />;

  return (
    <Shell
      tab={tab}
      onTab={setTab}
      apps={apps}
      appID={appID}
      onAppID={setAppID}
      onSignOut={signOut}
    >
      {tab === 'feedback' && <Feedback appID={appID} onUnauthorized={onUnauthorized} />}
      {tab === 'stats' && <Stats appID={appID} onUnauthorized={onUnauthorized} />}
      {tab === 'prompts' && <Prompts appID={appID} onUnauthorized={onUnauthorized} />}
      {tab === 'apps' && (
        <Apps apps={apps} onChanged={loadApps} onUnauthorized={onUnauthorized} />
      )}
    </Shell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Console />
    </ToastProvider>
  );
}
