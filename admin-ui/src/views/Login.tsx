import { useState, type FormEvent } from 'react';
import { MessageSquareHeart } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Card, Field, Input } from '../components/ui';

/** Trades ADMIN_TOKEN for the HttpOnly session cookie, then hands control back to <App>. */
export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(token);
      setToken('');
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-page px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-ink">
            <MessageSquareHeart className="size-5" />
          </span>
          <div>
            <h1 className="text-sm font-semibold">Rater Console</h1>
            <p className="text-xs text-ink-2">Feedback and prompt copy</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label="Admin password">
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete="current-password"
                autoFocus
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ADMIN_TOKEN"
              />
            )}
          </Field>

          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" busy={busy} className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
