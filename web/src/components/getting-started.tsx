import Link from 'next/link';
import { Circle, CircleCheck } from 'lucide-react';
import { Panel } from '@/components/ui';
import type { Checklist, ChecklistStep } from '@/server/getting-started';

/** The getting-started panel of a new organisation. Hidden once the first request arrived. */
export function GettingStarted({ checklist }: { checklist: Checklist }) {
  if (checklist.complete) return null;
  const required = checklist.steps.filter((s) => !s.optional);
  const optional = checklist.steps.filter((s) => s.optional);
  const readOnly = checklist.steps.every((s) => s.href === null);
  return (
    <Panel
      title="Get started"
      description={`${String(checklist.doneCount)} of ${String(checklist.required)} steps done. From an empty organisation to an agent that pays within its mandate.`}
    >
      <ol className="space-y-3">
        {required.map((s) => (
          <Step key={s.id} step={s} />
        ))}
      </ol>
      <h3 className="mt-5 text-xs font-medium uppercase tracking-wide text-ink-3">Optional</h3>
      <ul className="mt-2 space-y-3">
        {optional.map((s) => (
          <Step key={s.id} step={s} />
        ))}
      </ul>
      <p className="mt-5 border-t border-rule pt-3 text-sm text-ink-2">
        {readOnly ? 'An owner sets this up. ' : null}
        Just trying it out? The{' '}
        <Link href="/app" className="text-accent underline">
          demo lab
        </Link>{' '}
        creates a fictional company with an agent and suppliers in one click.
      </p>
    </Panel>
  );
}

function Step({ step: s }: { step: ChecklistStep }) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      {s.done ? (
        <CircleCheck size={18} className="mt-px shrink-0 text-approve" aria-label="Done" />
      ) : (
        <Circle size={18} className="mt-px shrink-0 text-ink-3" aria-label="Not done yet" />
      )}
      <div className="min-w-0">
        {s.done || s.href === null ? (
          <span className={s.done ? 'text-ink-3 line-through' : 'font-medium text-ink'}>
            {s.label}
          </span>
        ) : (
          <Link href={s.href} className="font-medium text-accent underline">
            {s.label}
          </Link>
        )}
        {s.done ? null : <p className="text-ink-3">{s.hint}</p>}
      </div>
    </li>
  );
}
