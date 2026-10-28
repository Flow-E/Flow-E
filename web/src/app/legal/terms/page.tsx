import type { Metadata } from 'next';
import { TextPage } from '@/components/text-page';

export const metadata: Metadata = { title: 'Terms (draft)', robots: { index: false } };

export default function TermsPage() {
  return (
    <TextPage title="Terms of use" draft>
      <h2>What Flow-E is</h2>
      <p>
        Flow-E lets an organisation give AI agents a mandate: rules for what they may buy, a person
        for larger decisions, and a signed record of every decision. It authorizes, matches and
        records purchases. It does not move money, pay suppliers or hold funds; the organisation
        pays through its own process.
      </p>

      <h2>Pilot status</h2>
      <p>
        Flow-E is early software (version 0.1), offered for pilots without charge [TO CONFIRM]. It
        has not had an external security review. Use it with limits you are comfortable with, and
        keep your own approval process for anything critical.
      </p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>The mandates, price lists and approvals you set are your decisions.</li>
        <li>Keep agent keys and your authenticator app safe; revoke a key you no longer trust.</li>
        <li>Only enter data you are allowed to process.</li>
      </ul>

      <h2>Liability</h2>
      <p>[TO CONFIRM: limitation of liability, warranty exclusions, applicable law and court.]</p>

      <h2>Changes and ending</h2>
      <p>[TO CONFIRM: notice period for changes, how a pilot ends, export of your ledger.]</p>
    </TextPage>
  );
}
