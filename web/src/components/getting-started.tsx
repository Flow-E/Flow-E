import Link from 'next/link';
import { Circle, CircleCheck } from 'lucide-react';
import { Panel } from '@/components/ui';
import type { Checklist, ChecklistStep } from '@/server/getting-started';

/** The getting-started panel of a new organisation. Hidden once every step is done. */
export function GettingStarted({
  checklist,
  readOnly,
}: {
  checklist: Checklist;
  readOnly: boolean;
}) {
  if (checklist.complete) return null;
  return (
    <Panel
      title="Get started"
      description={`${String(checklist.doneCount)} of ${String(checklist.total)} steps done. Each step ticks itself off from what has happened in this organisation.`}
    >
      <ol className="space-y-3">
        {checklist.steps.map((s, i) => (
          <Step key={s.id} step={s} n={i + 1} readOnly={readOnly} />
        ))}
      </ol>
      <p className="mt-5 border-t border-rule pt-3 text-sm text-ink-2">
        {readOnly ? 'An owner sets this up; you can follow along here. ' : null}
        Just trying it out? The{' '}
        <Link href="/app" className="text-accent underline">
          demo lab
        </Link>{' '}
        creates a fictional company with an agent and suppliers in one click.
      </p>
    </Panel>
  );
}

function Step({ step: s, n, readOnly }: { step: ChecklistStep; n: number; readOnly: boolean }) {
  const title = `${String(n)}. ${s.label}`;
  return (
    <li className="flex items-start gap-2.5 text-sm">
      {s.done ? (
        <CircleCheck size={18} className="mt-px shrink-0 text-approve" aria-label="Done" />
      ) : (
        <Circle size={18} className="mt-px shrink-0 text-ink-3" aria-label="Not done yet" />
      )}
      <div className="min-w-0">
        {s.done || s.href === null || readOnly ? (
          <span className={s.done ? 'text-ink-3 line-through' : 'font-medium text-ink'}>
            {title}
          </span>
        ) : (
          <Link href={s.href} className="font-medium text-accent underline">
            {title}
          </Link>
        )}
        {s.done ? null : (
          <p className="text-ink-3">
            {s.hint} <span className="text-ink-3/80">{s.doneWhen}</span>
          </p>
        )}
      </div>
    </li>
  );
}
