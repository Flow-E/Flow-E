import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import { DEMO_DAYS, DEMO_ORG_NAME } from '@/server/demo-org';
import { getOrgStore } from '@/server/runtime';
import { isPilotAdmin } from '@/server/pilot';
import { getSession } from '@/server/session';
import { seedDemoAction } from './actions';

export const metadata: Metadata = { title: 'Demo organisation', robots: { index: false } };
export const dynamic = 'force-dynamic';
/** Building 60 days of history takes a few hundred store calls. */
export const maxDuration = 300;

/** Admins only (FLOWE_ADMIN_EMAILS); everyone else, signed in or not, gets the same 404. */
export default async function DemoAdminPage() {
  const session = await getSession();
  if (!session || !isPilotAdmin(session)) notFound();
  const orgs = await (
    await getOrgStore()
  ).listOrgs({
    userId: session.userId,
    email: session.email,
  });
  const existing = orgs.filter((o) => o.name === DEMO_ORG_NAME);

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-10 sm:px-6">
      <Link href="/app" className="text-sm text-ink-2 hover:text-ink">
        Flow-E
      </Link>
      <h1 className="font-serif text-3xl tracking-[-0.015em] sm:text-4xl">Demo organisation</h1>
      <p className="text-ink-2">
        Builds <strong className="text-ink">{DEMO_ORG_NAME}</strong>: two agents, a price list from
        two fictional suppliers, a project budget, {DEMO_DAYS} days of signed history (approvals,
        declines, orders, invoices with a few mismatches) and two requests waiting for a person.
        Every page of it shows a banner saying the data is fictional, and its first ledger entry
        says so too. Nobody is emailed while it is built. It takes up to a minute.
      </p>
      {existing.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {existing.map((o) => (
            <li key={o.id}>
              <Link href={`/app/${o.id}`} className="text-accent underline">
                Open {o.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <form action={seedDemoAction}>
          <input type="hidden" name="reset" value={existing.length > 0 ? 'true' : 'false'} />
          <button type="submit" className={buttonClass('primary')}>
            {existing.length > 0 ? 'Reset: build a fresh one' : 'Build the demo organisation'}
          </button>
        </form>
      </div>
      {existing.length > 0 ? (
        <p className="text-xs text-ink-3">
          Reset removes you from the current {DEMO_ORG_NAME}; its signed ledger is kept, as every
          ledger is, but nobody can open it any more. The fresh one has history up to today.
        </p>
      ) : null}
    </main>
  );
}
