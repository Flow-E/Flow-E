import type { Metadata } from 'next';
import { Panel } from '@/components/ui';
import { sandboxView } from '@/server/view';
import { resetAction, updateMandateAction } from '../actions';
import { ResetForm } from '../client';
import { MandateForm, type MandateFields } from './mandate-form';

export const metadata: Metadata = { title: 'Mandate' };

type Raw = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const arr = (v: unknown) => (Array.isArray(v) ? v.map(str) : []);

/** The stored mandate.yaml (as JSON) shaped into form values. */
function fields(raw: Raw, baseCurrency: string): MandateFields {
  const hours = (raw.business_hours ?? {}) as Raw;
  const agents = (raw.agents ?? {}) as Record<string, Raw>;
  return {
    baseCurrency,
    timezone: str(raw.timezone ?? 'UTC'),
    fx: Object.entries((raw.fx ?? {}) as Raw).map(([k, v]) => [k, str(v)]),
    blocked_countries: arr(raw.blocked_countries).join(', '),
    blocked_suppliers: arr(raw.blocked_suppliers).join('\n'),
    days: Array.isArray(hours.days) ? hours.days.map(Number) : [1, 2, 3, 4, 5],
    start: str(hours.start ?? '08:00'),
    end: str(hours.end ?? '18:00'),
    agents: Object.entries(agents).map(([id, a]) => {
      const suppliers = (a.suppliers ?? {}) as Raw;
      return {
        id,
        owner: str(a.owner),
        status: str(a.status ?? 'active'),
        daily_budget: str(a.daily_budget),
        per_payment_limit: str(a.per_payment_limit),
        approval_above: str(a.approval_above),
        currencies: arr(a.currencies).join(', '),
        categories: arr(a.categories).join(', '),
        supplier_mode: str(suppliers.mode ?? 'any'),
        allow: arr(suppliers.allow).join('\n'),
        block: arr(suppliers.block).join('\n'),
        blocked_countries: arr(a.blocked_countries).join(', '),
        velocity_per_minute: str(a.velocity_per_minute ?? 10),
        business_hours_only: a.business_hours_only === true,
      };
    }),
  };
}

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
      <MandateForm data={fields(view.raw, view.baseCurrency)} action={updateMandateAction} />
      <Panel
        title="Start over"
        description="Archive this sandbox and begin again with new keys, an empty ledger and the original fictional mandate."
      >
        <ResetForm action={resetAction} />
      </Panel>
    </div>
  );
}
