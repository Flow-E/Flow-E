import type { Metadata } from 'next';
import { Panel } from '@/components/ui';
import { mandateFields } from '@/lib/mandate-form-data';
import { sandboxView } from '@/server/view';
import { resetAction, updateMandateAction } from '../actions';
import { ResetForm } from '../client';
import { MandateForm } from './mandate-form';

export const metadata: Metadata = { title: 'Mandate' };

export default async function MandatePage() {
  const { view } = await sandboxView();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mandate</h1>
        <p className="mt-1 max-w-[70ch] text-ink-2">
          The rules your agents spend within: the same settings as{' '}
          <span className="font-mono">mandate.yaml</span>, checked with the same validation. A saved
          change applies to the next request and is recorded in the ledger.
        </p>
      </div>
      <MandateForm data={mandateFields(view.raw, view.baseCurrency)} action={updateMandateAction} />
      <Panel
        title="Start over"
        description="Archive this sandbox and begin again with new keys, an empty ledger and the original fictional mandate."
      >
        <ResetForm action={resetAction} />
      </Panel>
    </div>
  );
}
