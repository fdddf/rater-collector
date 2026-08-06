import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';

/** Tiny classnames joiner — the whole kit needs conditional classes and nothing more. */
export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(' ');

// ── Buttons ──────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 shadow-xs',
  secondary: 'bg-surface text-ink ring-1 ring-border ring-inset hover:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  danger: 'bg-critical text-white hover:brightness-110 shadow-xs',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ComponentPropsWithoutRef<'button'> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  busy?: boolean;
}) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium',
        'transition-[background-color,color,filter] disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

// ── Form controls ────────────────────────────────────────────────────────────

const FIELD_BASE =
  'w-full rounded-lg bg-surface-2 px-3 text-sm text-ink ring-1 ring-border ring-inset ' +
  'placeholder:text-ink-3 focus:ring-accent focus:outline-none transition-shadow';

export const Input = ({ className, ...rest }: ComponentPropsWithoutRef<'input'>) => (
  <input {...rest} className={cx(FIELD_BASE, 'h-9', className)} />
);

export const Textarea = ({ className, ...rest }: ComponentPropsWithoutRef<'textarea'>) => (
  <textarea {...rest} className={cx(FIELD_BASE, 'min-h-20 py-2 leading-relaxed', className)} />
);

export const Select = ({ className, children, ...rest }: ComponentPropsWithoutRef<'select'>) => (
  <select {...rest} className={cx(FIELD_BASE, 'h-9 appearance-none pr-8', className)}>
    {children}
  </select>
);

/** Label + control + optional hint, wired together by a generated id. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export function Checkbox({
  label,
  className,
  ...rest
}: ComponentPropsWithoutRef<'input'> & { label: string }) {
  return (
    <label
      className={cx(
        'inline-flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-sm text-ink select-none',
        className,
      )}
    >
      <input
        {...rest}
        type="checkbox"
        className="size-4 accent-[var(--accent)] rounded-sm border-border"
      />
      {label}
    </label>
  );
}

// ── Surfaces ─────────────────────────────────────────────────────────────────

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <section
    className={cx('rounded-xl bg-surface ring-1 ring-border shadow-xs ring-inset', className)}
  >
    {children}
  </section>
);

export function SectionHeading({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {hint && <p className="mt-1 text-xs leading-relaxed text-ink-2">{hint}</p>}
    </div>
  );
}

// ── Status badges ────────────────────────────────────────────────────────────

/**
 * Feedback status is a state, so it uses the reserved status palette — and always pairs
 * the color with the word, never color alone.
 */
const BADGE_TONES = {
  open: 'text-warning ring-warning/40 bg-warning/10',
  resolved: 'text-good ring-good/40 bg-good/10',
  spam: 'text-critical ring-critical/40 bg-critical/10',
  pending: 'text-serious ring-serious/40 bg-serious/10',
  neutral: 'text-ink-2 ring-border bg-surface-2',
} as const;

export const Badge = ({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  className?: string;
  children: ReactNode;
}) => (
  <span
    className={cx(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
      BADGE_TONES[tone],
      className,
    )}
  >
    {children}
  </span>
);

export const statusTone = (status: string): keyof typeof BADGE_TONES =>
  status in BADGE_TONES ? (status as keyof typeof BADGE_TONES) : 'neutral';

// ── Feedback states ──────────────────────────────────────────────────────────

export const Spinner = ({ className }: { className?: string }) => (
  <Loader2 className={cx('size-5 animate-spin text-ink-3', className)} />
);

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon && <div className="text-ink-3">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="max-w-sm text-sm text-ink-2">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

/**
 * Built on <dialog> so focus trapping, Esc and inertness come from the platform —
 * `showModal()` has to be called imperatively, hence the effect.
 */
export function Modal({
  open,
  onClose,
  title,
  footer,
  size = 'md',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  footer?: ReactNode;
  size?: 'md' | 'lg';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      // A <dialog> fills its own box, so the backdrop click has to be detected by
      // hit-testing the click against the dialog's rectangle.
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const outside =
          e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (outside) onClose();
      }}
      className={cx(
        'm-auto w-[calc(100vw-2rem)] rounded-2xl bg-surface p-0 text-ink shadow-2xl',
        'ring-1 ring-border backdrop:bg-black/50 backdrop:backdrop-blur-[2px]',
        size === 'lg' ? 'max-w-3xl' : 'max-w-xl',
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
            <h2 className="mr-auto text-sm font-semibold">{title}</h2>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close" className="px-2">
              <X className="size-4" />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <footer className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}

// ── Toasts ───────────────────────────────────────────────────────────────────

type Toast = { id: number; message: string; tone: 'info' | 'error' };
const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);

  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = next.current++;
    setToasts((list) => [...list, { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3200);
  }, []);

  // `push` is stable, so this only ever produces one context value.
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className={cx(
                'pointer-events-auto max-w-[90vw] rounded-full px-4 py-2 text-sm font-medium shadow-lg ring-1',
                'animate-toast-in',
                t.tone === 'error'
                  ? 'bg-critical text-white ring-black/10'
                  : 'bg-ink text-page ring-black/10',
              )}
            >
              {t.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
