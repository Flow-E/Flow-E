import type { Metadata } from 'next';
import { Download } from 'lucide-react';
import { Panel, buttonClass } from '@/components/ui';
import { can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { siteOrigin } from '@/server/origin';
import { renameAction } from '../../actions';
import { RenameForm } from '../../client';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const { view } = await orgView(org);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Panel title="Organisation">
        {can(view.role, 'org.settings') ? (
          <RenameForm action={renameAction} org={view.id} name={view.name} />
        ) : (
          <p className="text-ink">{view.name}</p>
        )}
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-3">Base currency</dt>
          <dd className="text-ink">{view.baseCurrency} (fixed)</dd>
          <dt className="text-ink-3">Time zone</dt>
          <dd className="text-ink">{view.timezone} (change it on the Mandate page)</dd>
        </dl>
      </Panel>

      <Panel
        title="Issuer"
        description="This organisation's signing identity. It signs agent credentials and every ledger entry. The private key is stored encrypted and never leaves the server."
        action={
          <a href={`/app/${view.id}/issuer.pub`} className={buttonClass('secondary', 'sm')}>
            <Download size={15} aria-hidden="true" /> Public key
          </a>
        }
      >
        <p className="font-mono text-sm text-ink">{view.issuer}</p>
        <pre className="tabular mt-3 overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-xs text-ink-2">
          {view.publicKeyPem}
        </pre>
      </Panel>

      <Panel title="MCP endpoint">
        <p className="font-mono text-sm text-ink">{await siteOrigin()}/api/mcp</p>
        <p className="mt-2 text-sm text-ink-2">
          Agents authenticate with their own API key. Connection instructions are on each agent’s
          page.
        </p>
      </Panel>
    </div>
  );
}
