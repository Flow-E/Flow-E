import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

/** Small shared building blocks. Server-safe: no hooks. */

export type Tone = 'approved' | 'review' | 'declined' | 'cancelled' | 'neutral' | 'accent';

const TONE: Record<Tone, string> = {
  approved: 'bg-approve-soft text-approve',
  review: 'bg-review-soft text-review',
  declined: 'bg-decline-soft text-decline',
  cancelled: 'bg-muted-soft text-ink-2',
  neutral: 'bg-muted-soft text-ink-2',
  accent: 'bg-accent-soft text-accent',
};

export function toneOf(status: string): Tone {
  if (status === 'approved' || status === 'active' || status === 'pass') return 'approved';
  if (status === 'review' || status === 'paused' || status === 'note') return 'review';
  if (
    status === 'declined' ||
    status === 'frozen' ||
    status === 'decline' ||
    status === 'stopped'
  ) {
    return 'declined';
  }
  return 'neutral';
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <Pill tone={toneOf(status)}>{status}</Pill>;
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';

const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 border-transparent',
  secondary: 'bg-surface text-ink border-rule-strong hover:bg-sunken',
  danger: 'bg-decline text-paper hover:brightness-110 border-transparent',
  quiet: 'bg-transparent text-ink-2 border-transparent hover:bg-sunken hover:text-ink',
};

export function buttonClass(variant: ButtonVariant = 'primary', size: 'sm' | 'md' = 'md'): string {
  return [
    'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-[filter,background-color,color] duration-150',
    'disabled:cursor-not-allowed disabled:opacity-50',
    size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-sm',
    BUTTON[variant],
  ].join(' ');
}

export function ButtonLink({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  return <Link {...props} className={`${buttonClass(variant, size)} ${className}`} />;
}

export function Panel({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 rounded-xl border border-rule bg-surface ${className}`}>
      {title ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rule px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-sm text-ink-3">{description}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

export function FictionalNote({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-ink-3 ${className}`}>
      Sandbox: the company, people, suppliers and money are fictional. Flow-E never moves money.
    </p>
  );
}

/** The Flow-E mark: two linked ledger entries, drawn as geometry. */
export function Logo({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 font-semibold tracking-tight text-ink ${className}`}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <rect
          x="1.5"
          y="1.5"
          width="11"
          height="11"
          rx="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <rect x="9.5" y="9.5" width="11" height="11" rx="3" fill="var(--accent)" />
      </svg>
      <span>Flow-E</span>
    </span>
  );
}
