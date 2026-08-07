import { useState } from 'react';
import { Check, Copy, KeyRound, Plus, RotateCcw } from 'lucide-react';
import { api, UnauthorizedError } from '../lib/api';
import { fmtTime } from '../lib/format';
import type { App, NewAppResult } from '../lib/types';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  SectionHeading,
  useToast,
} from '../components/ui';

export default function Apps({
  apps,
  onChanged,
  onUnauthorized,
}: {
  apps: App[];
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [storeID, setStoreID] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [created, setCreated] = useState<NewAppResult | null>(null);

  async function create() {
    if (!name.trim()) return toast('Name is required', 'error');
    setBusy(true);
    try {
      const result = await api.createApp({
        name: name.trim(),
        id: id.trim() || undefined,
        app_store_id: storeID.trim() || undefined,
      });
      setCreated(result);
      setName('');
      setId('');
      setStoreID('');
      onChanged();
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Registration failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(app: App) {
    try {
      await api.patchApp(app.id, { enabled: !app.enabled });
      onChanged();
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Update failed', 'error');
    }
  }

  async function resetStats(app: App) {
    if (
      !confirm(
        `Reset the prompt funnel for "${app.name}"?\n\n` +
          'Every shown / positive / negative / dismissed / submitted event recorded for this ' +
          'app is deleted and the funnel starts from zero. Feedback and its screenshots are ' +
          'left untouched.',
      )
    ) {
      return;
    }
    setResetting(app.id);
    try {
      const { deleted } = await api.resetStats(app.id);
      toast(`Funnel reset — ${deleted.toLocaleString()} events cleared`);
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Reset failed', 'error');
    } finally {
      setResetting(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-2xl text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-ink-2">
                <th className="px-4 py-2.5 font-medium">ID</th>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">App Store ID</th>
                <th className="px-4 py-2.5 font-medium">Registered</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id} className="border-b border-border/70 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{a.id}</td>
                  <td className="px-4 py-3 font-medium">{a.name}</td>
                  <td className="px-4 py-3 text-ink-2 tnum">{a.app_store_id || '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink-2 tnum">{fmtTime(a.created_at)}</td>
                  <td className="px-4 py-3">
                    {a.enabled ? <Badge tone="resolved">Enabled</Badge> : <Badge tone="spam">Disabled</Badge>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={resetting === a.id}
                        onClick={() => resetStats(a)}
                        title="Delete this app's prompt funnel events and start counting from zero"
                      >
                        <RotateCcw className="size-4" />
                        Reset stats
                      </Button>
                      <Button size="sm" onClick={() => toggle(a)}>
                        {a.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Register a new app"
          hint="The API key is shown only once, at registration — the database keeps only its hash."
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            {(fid) => (
              <Input id={fid} value={name} onChange={(e) => setName(e.target.value)} placeholder="My App" />
            )}
          </Field>
          <Field label="ID" hint="Generated from the name if left blank.">
            {(fid) => (
              <Input id={fid} value={id} onChange={(e) => setId(e.target.value)} placeholder="my-app" />
            )}
          </Field>
          <Field label="App Store ID">
            {(fid) => (
              <Input
                id={fid}
                value={storeID}
                onChange={(e) => setStoreID(e.target.value)}
                placeholder="123456789"
              />
            )}
          </Field>
        </div>
        <div className="mt-4">
          <Button variant="primary" onClick={create} busy={busy}>
            <Plus className="size-4" />
            Register
          </Button>
        </div>
      </Card>

      <ApiKeyModal app={created} onClose={() => setCreated(null)} />
    </div>
  );
}

/** The one and only chance to copy the plaintext key, so it gets a deliberate dialog. */
function ApiKeyModal({ app, onClose }: { app: NewAppResult | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!app) return;
    await navigator.clipboard.writeText(app.api_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Modal
      open={app !== null}
      onClose={onClose}
      title="Save this API key now"
      footer={
        <Button variant="primary" onClick={onClose} className="ml-auto">
          I&rsquo;ve saved it
        </Button>
      }
    >
      {app && (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">
            <strong className="font-medium text-ink">{app.name}</strong> is registered. This key is shown
            only once — the server stores just its SHA-256, so it cannot be recovered.
          </p>
          <div className="flex items-center gap-2 rounded-xl bg-surface-2 p-3">
            <KeyRound className="size-4 shrink-0 text-ink-3" />
            <code className="min-w-0 flex-1 font-mono text-xs break-all text-ink select-all">
              {app.api_key}
            </code>
            <Button size="sm" onClick={copy}>
              {copied ? <Check className="size-4 text-good" /> : <Copy className="size-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
