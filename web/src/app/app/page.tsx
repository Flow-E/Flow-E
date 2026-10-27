import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, FlaskConical } from 'lucide-react';
import { Logo, Panel, Pill, buttonClass } from '@/components/ui';
import { ROLE_LABEL } from '@/server/permissions';
import { requireUser } from '@/server/org-view';
import { getOrgStore } from '@/server/runtime';
import { signOut } from '../login/actions';
import { ActionButton } from '../sandbox/client';
import { createDemoLabAction, createOrgAction } from './actions';
import { CreateOrgForm } from './client';

export const metadata: Metadata = { title: 'Organisations' };

export default async function OrgsPage() {
  const user = await requireUser('/app');
  const orgs = await (await getOrgStore()).listOrgs(user);

  return (
    <div className="min-h-dvh">
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-4 py-3 sm:px-6">
          <Link href="/" aria-label="Flow-E home" className="rounded-md">
            <Logo />
          </Link>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="hidden max-w-[16rem] truncate text-ink-3 sm:inline">{user.email}</span>
            <form action={signOut}>
              <button type="submit" className={buttonClass('quiet', 'sm')}>
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your organisations</h1>
          <p className="mt-1 text-ink-2">
            An organisation holds your real agents, their keys, one mandate and one signed ledger.
          </p>
        </div>

        {orgs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-rule-strong px-4 py-6 text-center text-ink-2">
            You are not in any organisation yet. Create one below, or open the invitation link a
            colleague sent you.
          </p>
        ) : (
          <ul className="divide-y divide-rule rounded-xl border border-rule bg-surface">
            {orgs.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/app/${o.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-sunken sm:px-5"
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{o.name}</span>
                  <Pill tone="neutral">{o.baseCurrency}</Pill>
                  <Pill tone={o.role === 'viewer' ? 'neutral' : 'accent'}>
                    {ROLE_LABEL[o.role]}
                  </Pill>
                  <ArrowRight size={16} className="text-ink-3" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}

        <Panel
          title="Create an organisation"
          description="You become its owner. It gets its own issuer key, an empty mandate and an empty ledger."
        >
          <CreateOrgForm action={createOrgAction} timezone="Europe/Zurich" />
        </Panel>

        <Panel
          title="Demo lab"
          description="Creates “Example Labs AG (demo, fictional)” with a lab procurement agent, the sandbox's fictional suppliers and limits, and an empty ledger. Use it to show a real Claude buying through Flow-E."
        >
          <ActionButton
            action={createDemoLabAction}
            fields={{}}
            label="Create the demo lab"
            pendingLabel="Creating…"
          />
        </Panel>

        <Link
          href="/sandbox"
          className="flex items-center gap-3 rounded-xl border border-rule bg-surface px-4 py-3 text-sm hover:bg-sunken sm:px-5"
        >
          <FlaskConical size={18} className="text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="font-medium text-ink">Open the sandbox</span>
            <span className="block text-ink-3">
              A fictional company with demo agents, to try everything first.
            </span>
          </span>
          <ArrowRight size={16} className="text-ink-3" aria-hidden="true" />
        </Link>
      </main>
    </div>
  );
}
