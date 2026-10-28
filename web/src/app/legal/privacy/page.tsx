import type { Metadata } from 'next';
import Link from 'next/link';
import { TextPage } from '@/components/text-page';

export const metadata: Metadata = { title: 'Privacy (draft)', robots: { index: false } };

export default function PrivacyPage() {
  return (
    <TextPage
      title="Privacy notice"
      draft
      intro="What personal data Flow-E processes, why, where, and your rights. Swiss Data Protection Act (FADP) and, where it applies, the EU GDPR. [TO CONFIRM: legal review]"
    >
      <h2>Who is responsible</h2>
      <p>
        Lorenzo Sivillica, [TO CONFIRM: postal address], [TO CONFIRM: contact email]. For data an
        organisation puts into Flow-E (its members, suppliers, invoices), the organisation is
        responsible and Flow-E processes it on its behalf (see the{' '}
        <Link href="/legal/dpa" className="text-accent underline">
          data processing agreement
        </Link>
        ).
      </p>

      <h2>What we process and why</h2>
      <ul>
        <li>
          <strong>Sign-in:</strong> your email address, to send sign-in links and keep you signed in
          (a signed session cookie).
        </li>
        <li>
          <strong>Organisations:</strong> member emails and roles, names of people in the ledger
          (who approved what), supplier names and invoice data, to provide the service the
          organisation asked for.
        </li>
        <li>
          <strong>Pilot requests:</strong> name, company, role, email, country and message, to
          answer the request. [TO CONFIRM: how long they are kept]
        </li>
        <li>
          <strong>Security:</strong> the address a request comes from is used briefly in memory to
          limit abuse; it is not stored.
        </li>
      </ul>

      <h2>Where it is processed</h2>
      <ul>
        <li>Supabase (database), Zurich region, Switzerland.</li>
        <li>Vercel (hosting), Frankfurt region, Germany. [TO CONFIRM: transfer safeguards]</li>
        <li>Resend (email delivery), once set up. [TO CONFIRM: region and safeguards]</li>
        <li>
          Anthropic (Claude), only when an organisation&apos;s operator turned on invoice reading or
          &ldquo;Run reorder&rdquo;; USA. [TO CONFIRM: transfer safeguards]
        </li>
      </ul>

      <h2>How long</h2>
      <p>
        The ledger is append-only by design: entries are kept as long as the organisation exists.
        Invoice files are kept 10 years (Swiss bookkeeping rules). [TO CONFIRM: retention periods
        and deletion on request]
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask what data we hold about you, have it corrected or deleted where the law allows,
        and complain to the Swiss Federal Data Protection and Information Commissioner (FDPIC) or
        your EU supervisory authority. Write to [TO CONFIRM: contact email].
      </p>

      <h2>Cookies</h2>
      <p>
        Only what the site needs to work: the sign-in session and, during the private preview, the
        preview-password cookie. No advertising or tracking cookies.
      </p>
    </TextPage>
  );
}
