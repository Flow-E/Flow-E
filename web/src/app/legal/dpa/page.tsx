import type { Metadata } from 'next';
import { TextPage } from '@/components/text-page';

export const metadata: Metadata = {
  title: 'Data processing agreement (draft)',
  robots: { index: false },
};

export default function DpaPage() {
  return (
    <TextPage
      title="Data processing agreement"
      draft
      intro="For organisations: how Flow-E processes personal data on your behalf (Art. 9 FADP, Art. 28 GDPR). [TO CONFIRM: legal review and signature process]"
    >
      <h2>Parties and roles</h2>
      <p>
        The organisation is the controller. Lorenzo Sivillica, [TO CONFIRM: postal address],
        operates Flow-E and is the processor.
      </p>

      <h2>Subject and duration</h2>
      <p>
        Providing Flow-E: deciding agent purchases under the organisation&apos;s mandate, approvals,
        invoice matching, reports and the signed ledger, for as long as the organisation uses
        Flow-E. [TO CONFIRM]
      </p>

      <h2>Data and people concerned</h2>
      <ul>
        <li>Members: email, role, approvals and notes they write.</li>
        <li>Supplier contacts that appear in invoices or memos.</li>
        <li>People named as responsible for an agent.</li>
      </ul>

      <h2>Sub-processors</h2>
      <ul>
        <li>Supabase: database, Zurich (Switzerland).</li>
        <li>Vercel: hosting, Frankfurt (Germany).</li>
        <li>Resend: email delivery. [TO CONFIRM: region]</li>
        <li>Anthropic: only if invoice reading or &ldquo;Run reorder&rdquo; is turned on (USA).</li>
      </ul>

      <h2>Security measures</h2>
      <p>
        As described on the Security page: encryption of signing keys and second-factor secrets,
        hashes for keys and links, a signed hash-chained ledger, second factor for owners and
        approvers, organisation-scoped access in the server. [TO CONFIRM: incident notification
        period, audits, deletion or return of data at the end]
      </p>
    </TextPage>
  );
}
