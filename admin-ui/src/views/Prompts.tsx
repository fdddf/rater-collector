import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Languages, Minus, Plus, Trash2, Type, X } from 'lucide-react';
import { api, UnauthorizedError } from '../lib/api';
import type { PromptConfig, PromptDraft } from '../lib/types';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  cx,
  EmptyState,
  Field,
  Input,
  Modal,
  SectionHeading,
  Spinner,
  Textarea,
  useToast,
} from '../components/ui';

/**
 * The App Store's mainstream storefront languages, in the tag shape iOS reports.
 * `localeCandidates` on the server walks zh-Hans-CN → zh-Hans → zh → *, so the regional
 * Chinese and Portuguese variants are the ones worth listing.
 */
const LOCALES: { tag: string; name: string }[] = [
  { tag: '*', name: 'Every locale (catch-all)' },
  { tag: 'en', name: 'English' },
  { tag: 'zh-Hans', name: 'Chinese, Simplified' },
  { tag: 'zh-Hant', name: 'Chinese, Traditional' },
  { tag: 'ja', name: 'Japanese' },
  { tag: 'ko', name: 'Korean' },
  { tag: 'es', name: 'Spanish' },
  { tag: 'fr', name: 'French' },
  { tag: 'de', name: 'German' },
  { tag: 'it', name: 'Italian' },
  { tag: 'pt-BR', name: 'Portuguese, Brazil' },
  { tag: 'pt-PT', name: 'Portuguese, Portugal' },
  { tag: 'ru', name: 'Russian' },
  { tag: 'nl', name: 'Dutch' },
  { tag: 'sv', name: 'Swedish' },
  { tag: 'da', name: 'Danish' },
  { tag: 'nb', name: 'Norwegian' },
  { tag: 'fi', name: 'Finnish' },
  { tag: 'pl', name: 'Polish' },
  { tag: 'tr', name: 'Turkish' },
  { tag: 'ar', name: 'Arabic' },
  { tag: 'he', name: 'Hebrew' },
  { tag: 'th', name: 'Thai' },
  { tag: 'vi', name: 'Vietnamese' },
  { tag: 'id', name: 'Indonesian' },
  { tag: 'ms', name: 'Malay' },
  { tag: 'hi', name: 'Hindi' },
  { tag: 'cs', name: 'Czech' },
  { tag: 'sk', name: 'Slovak' },
  { tag: 'hu', name: 'Hungarian' },
  { tag: 'ro', name: 'Romanian' },
  { tag: 'el', name: 'Greek' },
  { tag: 'uk', name: 'Ukrainian' },
  { tag: 'ca', name: 'Catalan' },
  { tag: 'hr', name: 'Croatian' },
];

const localeName = (tag: string) => LOCALES.find((l) => l.tag === tag)?.name;

/**
 * Multi-select over the locale list, with a filter box that doubles as free-text entry —
 * the list is a convenience, not a whitelist, so an unlisted tag has to stay reachable.
 */
function LocalePicker({
  value,
  onChange,
  exclude = [],
}: {
  value: string[];
  onChange: (next: string[]) => void;
  exclude?: string[];
}) {
  const [filter, setFilter] = useState('');
  const term = filter.trim();
  const lowered = term.toLowerCase();

  const taken = new Set([...value, ...exclude]);
  const options = LOCALES.filter(
    (l) =>
      !taken.has(l.tag) &&
      (!lowered || l.tag.toLowerCase().includes(lowered) || l.name.toLowerCase().includes(lowered)),
  );
  // Offer the raw text as a tag when it isn't already an exact match in the list.
  const custom = term && !LOCALES.some((l) => l.tag.toLowerCase() === lowered) && !taken.has(term);

  const add = (tag: string) => {
    onChange([...value, tag]);
    setFilter('');
  };

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-accent/10 py-0.5 pr-1 pl-2.5 text-xs font-medium text-ink ring-1 ring-accent/30 ring-inset"
            >
              <span className="font-mono">{tag}</span>
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                onClick={() => onChange(value.filter((t) => t !== tag))}
                className="rounded-full p-0.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const pick = options[0]?.tag ?? (custom ? term : null);
          if (pick) add(pick);
        }}
        placeholder="Filter languages, or type any locale tag"
        aria-label="Filter languages"
      />

      <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
        {custom && (
          <Button size="sm" variant="secondary" onClick={() => add(term)}>
            <Plus className="size-3.5" />
            <span className="font-mono">{term}</span>
          </Button>
        )}
        {options.map((l) => (
          <Button key={l.tag} size="sm" variant="ghost" onClick={() => add(l.tag)}>
            <span className="font-mono text-ink-2">{l.tag}</span>
            <span className="text-ink-3">{l.name}</span>
          </Button>
        ))}
        {options.length === 0 && !custom && (
          <p className="px-1 py-2 text-xs text-ink-3">Every matching language is already picked.</p>
        )}
      </div>
    </div>
  );
}

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
  const [translating, setTranslating] = useState<PromptConfig | null>(null);
  const [canTranslate, setCanTranslate] = useState(false);

  // Whether the server has a translation API key. Failing quietly just hides the button.
  useEffect(() => {
    api
      .settings()
      .then((s) => setCanTranslate(s.translate_enabled))
      .catch(() => setCanTranslate(false));
  }, []);

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
                        {/* Clearing the locale drops the editor into multi-select, so a
                            duplicate can't silently overwrite the row it came from. */}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDraft({ ...p, id: undefined, locale: '' })}
                          aria-label={`Duplicate ${p.locale} copy`}
                          title="Copy these fields into a new row for other locales"
                          className="px-2"
                        >
                          <Copy className="size-4" />
                        </Button>
                        {canTranslate && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setTranslating(p)}
                            aria-label={`Translate ${p.locale} copy`}
                            title="Machine-translate this row into other languages"
                            className="px-2"
                          >
                            <Languages className="size-4" />
                          </Button>
                        )}
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

      {translating && (
        <TranslateDialog
          appID={appID}
          source={translating}
          existing={(prompts ?? []).map((p) => p.locale)}
          onClose={() => setTranslating(null)}
          onSaved={() => {
            setTranslating(null);
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

  // Editing targets exactly the row that was opened. Creating writes the same copy to
  // every picked locale, which is what makes "add ten languages" one dialog instead of ten.
  const creating = !initial.id;
  const [locales, setLocales] = useState<string[]>(initial.locale ? [initial.locale] : []);

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

    const targets = creating ? locales : [d.locale];
    if (targets.length === 0) return toast('Pick at least one language', 'error');

    setSaving(true);
    try {
      // Sequential: each locale is its own upsert, and reporting "3 of 5 saved" beats
      // a Promise.all that leaves the console unsure which rows landed.
      for (const locale of targets) {
        await api.putPrompt(appID, { ...d, locale, categories, rules });
      }
      toast(
        targets.length === 1
          ? 'Saved — live on the client’s next config fetch'
          : `Saved ${targets.length} languages — live on the client’s next config fetch`,
      );
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
        {creating ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-2">Languages</p>
            <LocalePicker value={locales} onChange={setLocales} />
            <p className="mt-1 text-xs text-ink-3">
              One row is written per language, all with the copy below — pick several, then edit
              or translate each afterwards.
            </p>
          </div>
        ) : (
          <Field label="Locale" hint="* matches every locale">
            {(id) => (
              <Input id={id} value={d.locale} onChange={(e) => set('locale', e.target.value)} />
            )}
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
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

// ── Batch translation ────────────────────────────────────────────────────────

/**
 * Machine-translates one row into several languages.
 *
 * Deliberately two-step: the server only returns drafts, and nothing reaches
 * `prompt_configs` until someone has read the copy and pressed Save. Machine translation
 * is a first draft of the first thing a user reads, not a deploy.
 */
function TranslateDialog({
  appID,
  source,
  existing,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  appID: string;
  source: PromptConfig;
  existing: string[];
  onClose: () => void;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const toast = useToast();
  const [targets, setTargets] = useState<string[]>([]);
  const [results, setResults] = useState<PromptDraft[] | null>(null);
  const [errors, setErrors] = useState<{ locale: string; message: string }[]>([]);
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  async function translate() {
    if (targets.length === 0) return toast('Pick at least one language', 'error');
    setBusy(true);
    try {
      const data = await api.translatePrompts(appID, { source, target_locales: targets });
      setResults(data.prompts);
      setErrors(data.errors);
      setInclude(new Set(data.prompts.map((p) => p.locale)));
      if (data.prompts.length === 0) toast('No language could be translated', 'error');
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Translation failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const chosen = (results ?? []).filter((p) => include.has(p.locale));
    if (chosen.length === 0) return toast('Nothing selected to save', 'error');
    setBusy(true);
    try {
      for (const prompt of chosen) {
        await api.putPrompt(appID, prompt);
      }
      toast(`Saved ${chosen.length} translated ${chosen.length === 1 ? 'language' : 'languages'}`);
      onSaved();
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Translate ${source.locale} copy`}
      size="lg"
      footer={
        <>
          {results === null ? (
            <Button variant="primary" onClick={translate} busy={busy}>
              <Languages className="size-4" />
              Translate {targets.length > 0 && `(${targets.length})`}
            </Button>
          ) : (
            <>
              <Button variant="primary" onClick={save} busy={busy}>
                Save {include.size} {include.size === 1 ? 'language' : 'languages'}
              </Button>
              <Button variant="ghost" onClick={() => setResults(null)}>
                Back
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      {results === null ? (
        <div className="space-y-4">
          <SectionHeading
            title="Translate into"
            hint="Category ids, trigger rules, variant and minimum version are carried over untouched — only the wording is translated."
          />
          <LocalePicker value={targets} onChange={setTargets} exclude={[source.locale]} />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-2">
            Nothing is saved yet. Read the copy, untick anything that reads badly, then save.
          </p>

          {errors.map((e) => (
            <div
              key={e.locale}
              className="rounded-xl bg-critical/10 p-3 text-xs text-critical ring-1 ring-critical/30 ring-inset"
            >
              <span className="font-mono font-medium">{e.locale}</span> failed: {e.message}
            </div>
          ))}

          {results.map((p) => {
            const on = include.has(p.locale);
            return (
              <div
                key={p.locale}
                className={cx(
                  'rounded-xl p-3 ring-1 ring-inset transition-colors',
                  on ? 'bg-surface-2 ring-border' : 'bg-transparent ring-border/50 opacity-60',
                )}
              >
                <div className="mb-2 flex items-center gap-2">
                  <Checkbox
                    label={`${p.locale}${localeName(p.locale) ? ` · ${localeName(p.locale)}` : ''}`}
                    checked={on}
                    onChange={() =>
                      setInclude((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(p.locale)) next.add(p.locale);
                        return next;
                      })
                    }
                  />
                  {existing.includes(p.locale) && (
                    <Badge tone="pending">Replaces existing row</Badge>
                  )}
                </div>
                <p className="text-sm font-medium text-ink">{p.title}</p>
                <p className="mt-0.5 text-sm text-ink-2">{p.message}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge>{p.positive_label}</Badge>
                  <Badge>{p.negative_label}</Badge>
                  <Badge>{p.later_label}</Badge>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-3">
                  {p.categories.map((c) => (
                    <span key={c.id}>
                      <span className="font-mono">{c.id}</span> → {c.label}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
