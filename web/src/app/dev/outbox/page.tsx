import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Panel, Pill } from '@/components/ui';
import { outboxVisible, readOutbox } from '@/server/email';
import { getDb } from '@/server/runtime';

export const metadata: Metadata = { title: 'Dev outbox', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * Development only (NODE_ENV not production and FLOWE_DEV_LOGIN=1): the emails Flow-E would
 * have sent, with their links. 404 everywhere else.
 */
export default async function OutboxPage() {
  if (!outboxVisible()) notFound();
  const messages = await readOutbox(await getDb());
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Development outbox</h1>
        <p className="mt-1 text-ink-2">
          Emails are stored here instead of sent while developing. Newest first. Production refuses
          this outbox.
        </p>
      </div>
      {messages.length === 0 ? (
        <p className="text-ink-2">No emails yet.</p>
      ) : (
        messages.map((m) => (
          <Panel
            key={m.id}
            title={m.subject}
            description={`To ${m.to_email} · ${m.created_at}`}
            action={<Pill tone="neutral">{m.kind}</Pill>}
          >
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-ink">
              {m.body_text.split(/(https?:\/\/\S+)/).map((part, i) =>
                i % 2 === 1 ? (
                  <a key={i} href={part} className="text-accent underline">
                    {part}
                  </a>
                ) : (
                  part
                ),
              )}
            </pre>
          </Panel>
        ))
      )}
    </main>
  );
}
