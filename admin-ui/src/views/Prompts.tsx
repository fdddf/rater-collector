import { useCallback, useEffect, useState } from 'react';
import { Check, Minus, Plus, Trash2, Type } from 'lucide-react';
import { api, UnauthorizedError } from '../lib/api';
import type { PromptConfig, PromptDraft } from '../lib/types';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  SectionHeading,
  Spinner,
  Textarea,
  useToast,
} from '../components/ui';

/** What "Add copy" starts from — the same defaults the client falls back to when offline. */
const BLANK: PromptDraft = {
  locale: '*',
  min_app_version: '0',
  enabled: true,
  variant: 'default',
  title: 'Enjoying this app?',
  message: 'Your opinion matters to us — it only takes a few seconds.',
  positive_label: 'I like it',
  negative_label: 'Not quite',
  later_label: 'Maybe later',
  feedback_title: '',
  feedback_message: '',
  email_required: false,
  categories: [
    { id: 'bug', label: "Something's broken" },
    { id: 'feature', label: 'Feature request' },
    { id: 'other', label: 'Something else' },
  ],
  rules: null,
};

export default function Prompts({ appID, onUnauthorized }: { appID: string; onUnauthorized: () => void }) {
  const toast = useToast();
  const [prompts, setPrompts] = useState<PromptConfig[] | null>(null);
  const [draft, setDraft] = useState<PromptDraft | null>(null);

  const load = useCallback(async () => {
    if (!appID) {
      setPrompts([]);
      return;
    }
    setPrompts(null);
    try {
      setPrompts((await api.prompts(appID)).prompts);
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Failed to load copy', 'error');
      setPrompts([]);
    }
  }, [appID, toast, onUnauthorized]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(id: string) {
    if (!confirm('Delete this copy configuration?')) return;
    try {
      await api.deletePrompt(id);
      toast('Deleted');
      load();
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  if (!appID) {
    return (
      <Card>
        <EmptyState
          icon={<Type className="size-8" />}
          title="Pick an app first"
          hint="Prompt copy is per app — choose one from the selector in the header."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <SectionHeading
          title="Prompt copy"
          hint={
            <>
              Edits here reach live clients through <code className="font-mono text-ink">/v1/config</code> — no
              app release needed. Use <code className="font-mono text-ink">*</code> as the locale for the
              catch-all row; <code className="font-mono text-ink">min_app_version</code> is the lowest app
              version the row applies to.
            </>
          }
        />

        {prompts === null ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : prompts.length === 0 ? (
          <EmptyState
            title="No copy configured yet"
            hint="Clients will use their built-in fallback text until you add a row."
            action={
              <Button variant="primary" onClick={() => setDraft(BLANK)}>
                <Plus className="size-4" />
                Add copy
              </Button>
            }
          />
        ) : (
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-2xl text-sm">
              <thead>
                <tr className="border-y border-border text-left text-xs text-ink-2">
                  <th className="px-4 py-2 font-medium">Locale</th>
                  <th className="px-4 py-2 font-medium">Min version</th>
                  <th className="px-4 py-2 font-medium">Variant</th>
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 font-medium">Enabled</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {prompts.map((p) => (
                  <tr key={p.id} className="border-b border-border/70 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs">{p.locale}</td>
                    <td className="px-4 py-2.5 tnum">{p.min_app_version}</td>
                    <td className="px-4 py-2.5 text-ink-2">{p.variant}</td>
                    <td className="max-w-xs truncate px-4 py-2.5">{p.title}</td>
                    <td className="px-4 py-2.5">
                      {p.enabled ? (
                        <Badge tone="resolved">
                          <Check className="size-3" />
                          On
                        </Badge>
                      ) : (
                        <Badge>
                          <Minus className="size-3" />
                          Off
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" onClick={() => setDraft(p)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => remove(p.id)}
                          aria-label={`Delete ${p.locale} copy`}
                          className="px-2 text-critical hover:text-critical"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {prompts !== null && prompts.length > 0 && (
          <div className="mt-4">
            <Button onClick={() => setDraft(BLANK)}>
              <Plus className="size-4" />
              Add copy
            </Button>
          </div>
        )}
      </Card>

      {draft && (
        <PromptEditor
          appID={appID}
          initial={draft}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            load();
          }}
          onUnauthorized={onUnauthorized}
        />
      )}
    </div>
  );
}

// ── Editor ───────────────────────────────────────────────────────────────────

function PromptEditor({
  appID,
  initial,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  appID: string;
  initial: PromptDraft;
  onClose: () => void;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const toast = useToast();
  const [d, setD] = useState<PromptDraft>(initial);
  // Rules are free-form JSON, so they stay raw text until save — an invalid keystroke
  // mid-edit shouldn't wipe what was typed.
  const [rulesText, setRulesText] = useState(initial.rules ? JSON.stringify(initial.rules, null, 2) : '');
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof PromptDraft>(key: K, value: PromptDraft[K]) =>
    setD((prev) => ({ ...prev, [key]: value }));

  async function save() {
    let rules: Record<string, unknown> | null = null;
    if (rulesText.trim()) {
      try {
        rules = JSON.parse(rulesText) as Record<string, unknown>;
      } catch {
        return toast('Trigger rules JSON is malformed', 'error');
      }
    }
    const categories = d.categories.filter((c) => c.id.trim() && c.label.trim());
    if (categories.length === 0) return toast('Add at least one feedback category', 'error');

    setSaving(true);
    try {
      await api.putPrompt(appID, { ...d, categories, rules });
      toast('Saved — live on the client’s next config fetch');
      onSaved();
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={initial.id ? 'Edit copy' : 'Add copy'}
      size="lg"
      footer={
        <>
          <Button variant="primary" onClick={save} busy={saving}>
            Save
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <div className="ml-auto flex gap-3">
            <Checkbox
              label="Enabled"
              checked={d.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            <Checkbox
              label="Email required"
              checked={d.email_required}
              onChange={(e) => set('email_required', e.target.checked)}
            />
          </div>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Locale" hint="* matches every locale">
            {(id) => (
              <Input id={id} value={d.locale} onChange={(e) => set('locale', e.target.value)} />
            )}
          </Field>
          <Field label="Min app version">
            {(id) => (
              <Input
                id={id}
                value={d.min_app_version}
                onChange={(e) => set('min_app_version', e.target.value)}
              />
            )}
          </Field>
          <Field label="Experiment variant">
            {(id) => (
              <Input id={id} value={d.variant} onChange={(e) => set('variant', e.target.value)} />
            )}
          </Field>
        </div>

        <div className="space-y-3">
          <Field label="Prompt title">
            {(id) => <Input id={id} value={d.title} onChange={(e) => set('title', e.target.value)} />}
          </Field>
          <Field label="Prompt message">
            {(id) => (
              <Textarea id={id} value={d.message} onChange={(e) => set('message', e.target.value)} />
            )}
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Positive button">
              {(id) => (
                <Input
                  id={id}
                  value={d.positive_label}
                  onChange={(e) => set('positive_label', e.target.value)}
                />
              )}
            </Field>
            <Field label="Negative button">
              {(id) => (
                <Input
                  id={id}
                  value={d.negative_label}
                  onChange={(e) => set('negative_label', e.target.value)}
                />
              )}
            </Field>
            <Field label="Later button">
              {(id) => (
                <Input
                  id={id}
                  value={d.later_label}
                  onChange={(e) => set('later_label', e.target.value)}
                />
              )}
            </Field>
          </div>
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <Field label="Feedback form title" hint="Optional — falls back to the client default.">
            {(id) => (
              <Input
                id={id}
                value={d.feedback_title ?? ''}
                onChange={(e) => set('feedback_title', e.target.value || null)}
              />
            )}
          </Field>
          <Field label="Feedback form description" hint="Optional.">
            {(id) => (
              <Textarea
                id={id}
                value={d.feedback_message ?? ''}
                onChange={(e) => set('feedback_message', e.target.value || null)}
              />
            )}
          </Field>
        </div>

        <div className="border-t border-border pt-4">
          <SectionHeading title="Feedback categories" hint="Shown as the picker in the feedback form." />
          <div className="space-y-2">
            {d.categories.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={c.id}
                  aria-label={`Category ${i + 1} id`}
                  placeholder="id"
                  className="w-40 font-mono text-xs"
                  onChange={(e) =>
                    set(
                      'categories',
                      d.categories.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  value={c.label}
                  aria-label={`Category ${i + 1} label`}
                  placeholder="Label shown to the user"
                  onChange={(e) =>
                    set(
                      'categories',
                      d.categories.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove category ${i + 1}`}
                  className="px-2 text-critical hover:text-critical"
                  onClick={() =>
                    set(
                      'categories',
                      d.categories.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              onClick={() => set('categories', [...d.categories, { id: '', label: '' }])}
            >
              <Plus className="size-4" />
              Add category
            </Button>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <Field
            label="Trigger rule overrides (JSON)"
            hint="Optional — leave empty to keep the app's built-in trigger rules."
          >
            {(id) => (
              <Textarea
                id={id}
                value={rulesText}
                spellCheck={false}
                onChange={(e) => setRulesText(e.target.value)}
                className="font-mono text-xs"
                placeholder='{ "min_launches": 5 }'
              />
            )}
          </Field>
        </div>
      </div>
    </Modal>
  );
}
