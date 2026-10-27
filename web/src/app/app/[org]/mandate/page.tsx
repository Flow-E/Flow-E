import type { Metadata } from 'next';
import Link from 'next/link';
import { mandateFields } from '@/lib/mandate-form-data';
import { priceSuggestions } from '@/server/price-suggestions';
import { can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { MandateForm } from '../../../sandbox/mandate/mandate-form';
import { previewMandateAction, updateMandateAction } from '../../actions';

export const metadata: Metadata = { title: 'Mandate' };

export default async function MandatePage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const { view } = await orgView(org);
  const edit = can(view.role, 'mandate.update');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mandate</h1>
        <p className="mt-1 max-w-[70ch] text-ink-2">
          The rules your agents spend within: the same settings as{' '}
          <span className="font-mono">mandate.yaml</span>, checked with the same validation. A saved
          change applies to the next request and is recorded in the ledger with who changed what.
          {edit ? '' : ' Only owners can change it.'}
        </p>
      </div>
      {view.agents.length === 0 ? (
        <p className="rounded-xl border border-dashed border-rule-strong px-4 py-4 text-sm text-ink-2">
          No agents yet, so only the organisation-wide settings show here.{' '}
          {edit ? (
            <Link href={`/app/${view.id}/agents`} className="text-accent underline">
              Create an agent
            </Link>
          ) : null}
        </p>
      ) : null}
      <MandateForm
        data={mandateFields(view.raw, view.baseCurrency)}
        suggestions={priceSuggestions(view)}
        preview={previewMandateAction.bind(null, view.id)}
        action={updateMandateAction.bind(null, view.id)}
        readOnly={!edit}
        fxAsText
        baseHint="Fixed for an organisation. Every limit is counted in it."
      />
    </div>
  );
}
