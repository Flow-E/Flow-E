import type { Metadata } from 'next';
import { TextPage } from '@/components/text-page';

export const metadata: Metadata = { title: 'Imprint (draft)', robots: { index: false } };

export default function ImprintPage() {
  return (
    <TextPage title="Imprint" draft>
      <p>
        <strong>Operator:</strong> Lorenzo Sivillica, private person (no company yet).
        <br />
        [TO CONFIRM: postal address]
        <br />
        [TO CONFIRM: contact email]
      </p>
      <p>
        Flow-E is open-source software under the MIT licence. It authorizes, matches and records
        purchases for organisations; it does not hold or move money and is not a payment service.
      </p>
      <p>[TO CONFIRM: whether a company register entry or VAT number applies.]</p>
    </TextPage>
  );
}
