import type { Metadata } from 'next';
import Link from 'next/link';
import { TextPage } from '@/components/text-page';

export const metadata: Metadata = {
  title: 'Security',
  description: 'What Flow-E stores, where, what is signed, and what is not done yet.',
};

export default function SecurityPage() {
  return (
    <TextPage
      title="Security, in plain words"
      intro="What Flow-E stores, where it is kept, what is signed, and what is not done yet. Flow-E authorizes, matches and records purchases; it never holds or moves money."
    >
      <h2>What is stored</h2>
      <ul>
        <li>
          <strong>People:</strong> the email address you sign in with, your organisations and your
          role in each (owner, approver, viewer).
        </li>
        <li>
          <strong>Your rules:</strong> agents, their mandates (budgets, limits, suppliers,
          categories), your price list and your reorder list.
        </li>
        <li>
          <strong>The ledger:</strong> every payment request (supplier, amount, item, memo), every
          decision with its reasons, every approval with who gave it, orders, invoices and mandate
          changes.
        </li>
        <li>
          <strong>Invoice files</strong> you upload (PDF or image), kept with their fingerprint.
        </li>
        <li>
          <strong>Pilot requests</strong> from the home page: name, company, role, email and your
          message.
        </li>
      </ul>

      <h2>Where</h2>
      <ul>
        <li>
          <strong>Database:</strong> Postgres at Supabase, in its Zurich region (Switzerland).
        </li>
        <li>
          <strong>Website and API:</strong> Vercel, running in Frankfurt (Germany).
        </li>
        <li>
          <strong>Email</strong> (sign-in links, approval requests): sent through Resend once it is
          set up.
        </li>
        <li>
          <strong>Claude (Anthropic)</strong>, only if the organisation&apos;s operator turned it
          on: an uploaded invoice is sent to read its fields, and &ldquo;Run reorder&rdquo; sends
          the reorder and price list. Without it, nothing goes to Anthropic.
        </li>
      </ul>

      <h2>What is signed</h2>
      <ul>
        <li>
          Every organisation has its own signing key (Ed25519). Every ledger entry is signed with it
          and linked to the previous one by a hash, so a changed or removed entry is detected. The
          ledger page checks the whole chain.
        </li>
        <li>
          Each decision comes with a receipt that anyone can check on the{' '}
          <Link href="/verify" className="text-accent underline">
            public receipt check
          </Link>{' '}
          against the organisation&apos;s published public key, or offline with the open-source
          command line.
        </li>
        <li>Each agent carries a signed credential that expires; its API keys can be revoked.</li>
      </ul>

      <h2>How secrets are kept</h2>
      <ul>
        <li>
          Signing keys and second-factor secrets are encrypted (AES-256-GCM) with a key that only
          the server has.
        </li>
        <li>
          Agent API keys, approval links and recovery codes are stored only as hashes: the plain
          value is shown once and cannot be read back.
        </li>
        <li>
          Owners and approvers confirm approvals, mandate changes, keys, members and the kill switch
          with an authenticator app.
        </li>
        <li>Every error declines; nothing is approved by accident (&ldquo;fail closed&rdquo;).</li>
      </ul>

      <h2>What is not done yet</h2>
      <ul>
        <li>
          Signing keys are not in a managed key service (such as a cloud HSM); they are encrypted in
          the database.
        </li>
        <li>Flow-E has not had an external security review or penetration test.</li>
        <li>Rate limits are kept per server instance, so they are approximate under heavy load.</li>
        <li>Uploaded invoice files cannot be deleted yet.</li>
        <li>Flow-E is not certified for any standard and is not a compliance product.</li>
      </ul>

      <h2>Reporting a problem</h2>
      <p>
        Found a security problem? Write to [TO CONFIRM: security contact address]. The code is open
        source:{' '}
        <a href="https://github.com/Flow-E/Flow-E" className="text-accent underline">
          github.com/Flow-E/Flow-E
        </a>
        .
      </p>
    </TextPage>
  );
}
