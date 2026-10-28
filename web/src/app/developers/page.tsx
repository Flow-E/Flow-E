import type { Metadata } from 'next';
import Link from 'next/link';
import { TextPage } from '@/components/text-page';
import {
  API_EXAMPLES,
  VERIFY_WEBHOOK_SNIPPET,
  WEBHOOK_PAYLOAD_EXAMPLE,
  type ApiExample,
} from '@/content/api-examples';
import { API_SCOPES, SCOPE_LABEL } from '@/server/api-keys';
import { siteOrigin } from '@/server/origin';
import { EVENT_LABEL, RETRY_DELAYS_MS, WEBHOOK_EVENTS } from '@/server/webhooks';

export const metadata: Metadata = {
  title: 'Connect your systems',
  description: 'Organisation API keys, reorder signals, webhooks and receipts: how to connect.',
};

function curl(e: ApiExample, origin: string): string {
  const lines = [
    `curl${e.method === 'GET' ? '' : ` -X ${e.method}`} ${origin}${e.path.replace('{payment_id}', 'pay_…')}`,
    `  -H "Authorization: Bearer $FLOWE_KEY"`,
  ];
  if (e.body) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${JSON.stringify(e.body)}'`);
  }
  return lines.join(' \\\n');
}

function Code({ children }: { children: string }) {
  return (
    <pre className="tabular overflow-x-auto rounded-lg border border-rule bg-sunken p-3 font-mono text-xs leading-relaxed text-ink">
      {children}
    </pre>
  );
}

const minutes = (ms: number) =>
  ms < 3_600_000 ? `${String(ms / 60_000)} min` : `${String(ms / 3_600_000)} h`;

export default async function DevelopersPage() {
  const origin = await siteOrigin();
  return (
    <TextPage
      title="Connect your systems"
      intro="An inventory system can tell Flow-E what to reorder. Accounting, a supplier or another system can be told when an order is approved, and can check it. Nothing from outside can approve a purchase."
    >
      <h2>Keys</h2>
      <p>
        An owner creates an organisation API key under <strong>Integrations</strong>. It belongs to
        one organisation, is shown once, and is stored only as a hash. Revoking it takes effect at
        once. It is separate from agent keys: it cannot ask for payments. Send it as{' '}
        <code className="font-mono text-sm">Authorization: Bearer flowe_ok_…</code>.
      </p>
      <ul>
        {API_SCOPES.map((s) => (
          <li key={s}>
            <code className="font-mono text-sm">{s}</code>: {SCOPE_LABEL[s]}.
          </li>
        ))}
      </ul>
      <p>
        At most 60 calls per minute per key. Every call is logged (method, path, status; never the
        key or the content) and kept 90 days. Answers are JSON; errors have an{' '}
        <code className="font-mono text-sm">error</code> text and, for invalid input, a list of{' '}
        <code className="font-mono text-sm">problems</code>.
      </p>

      <h2>Reorder signals</h2>
      <p>
        A signal only adds a suggestion to the reorder list, &ldquo;suggested by&rdquo; your
        key&apos;s name. A person adds it to the list or dismisses it, or, if the organisation
        turned it on, it joins the next Run reorder once. Every purchase still goes through the
        agent, Flow-E&apos;s rules and, where required, a person.
      </p>
      <ul>
        <li>
          <code className="font-mono text-sm">item_id</code> (an id from the price list) or{' '}
          <code className="font-mono text-sm">item</code> (its exact name), optional{' '}
          <code className="font-mono text-sm">supplier</code>. An item that matches neither is kept
          as &ldquo;needs matching&rdquo; for a person; it is never guessed.
        </li>
        <li>
          <code className="font-mono text-sm">quantity</code> (whole number),{' '}
          <code className="font-mono text-sm">unit</code>,{' '}
          <code className="font-mono text-sm">reason</code>,{' '}
          <code className="font-mono text-sm">needed_by</code> (YYYY-MM-DD).
        </li>
        <li>
          <code className="font-mono text-sm">idempotency_key</code> (or the{' '}
          <code className="font-mono text-sm">Idempotency-Key</code> header): the same key gives the
          same answer and adds nothing; the same key with a different signal is refused (409).
        </li>
      </ul>

      {API_EXAMPLES.map((e) => (
        <section key={e.id} className="space-y-2">
          <h3 className="font-semibold text-ink">
            {e.title}{' '}
            <span className="font-mono text-xs font-normal text-ink-3">
              {e.method} {e.path} · {e.scope}
            </span>
          </h3>
          <Code>{curl(e, origin)}</Code>
          <p className="text-sm">Answer ({e.status}):</p>
          <Code>{e.answer}</Code>
        </section>
      ))}
      <p>
        <code className="font-mono text-sm">GET /api/v1/orders</code> takes{' '}
        <code className="font-mono text-sm">limit</code> (1 to 100) and{' '}
        <code className="font-mono text-sm">cursor</code>; pass the{' '}
        <code className="font-mono text-sm">next_cursor</code> of one page to get the next.
      </p>

      <h2>Webhooks</h2>
      <p>
        An owner adds an https address under <strong>Integrations</strong> and picks events. Flow-E
        sends each event as a signed JSON POST, about a minute after it happens. Sending never
        changes or slows a decision. Answer with any 2xx status; anything else is retried after{' '}
        {RETRY_DELAYS_MS.map(minutes).join(', ')}, then marked failed (you can resend it). Only
        public https addresses are called, without following redirects.
      </p>
      <ul>
        {WEBHOOK_EVENTS.map((e) => (
          <li key={e}>
            <code className="font-mono text-sm">{e}</code>: {EVENT_LABEL[e]}.
          </li>
        ))}
      </ul>
      <p>
        The body holds the ledger entry exactly as recorded and, for approvals and orders, its
        signed receipt. No keys, and no data from other organisations.
      </p>
      <Code>{WEBHOOK_PAYLOAD_EXAMPLE}</Code>

      <h3 className="font-semibold text-ink">Check the signature</h3>
      <p>
        <code className="font-mono text-sm">
          Flow-E-Signature: t=&lt;seconds&gt;,v1=&lt;hex&gt;
        </code>{' '}
        is an HMAC-SHA256 of <code className="font-mono text-sm">t + &quot;.&quot; + body</code>{' '}
        with your webhook&apos;s secret. Refuse anything older than 5 minutes, so a recorded message
        cannot be replayed.
      </p>
      <Code>{VERIFY_WEBHOOK_SNIPPET}</Code>

      <h2>Check a receipt</h2>
      <p>
        Every organisation publishes its public key at{' '}
        <code className="font-mono text-sm">{origin}/keys/&lt;issuer&gt;.pub</code> (the issuer is
        in every receipt). Paste a receipt on the{' '}
        <Link href="/verify" className="text-accent underline">
          public receipt check
        </Link>
        , post it there (<code className="font-mono text-sm">POST /api/verify</code> with the
        receipt as the body), or check it offline with the open-source command line:
      </p>
      <Code>{`curl -o issuer.pub ${origin}/keys/<issuer>.pub
flow-e verify receipt.json --pubkey issuer.pub --offline`}</Code>
      <p>
        A valid receipt proves that Flow-E, under the organisation&apos;s key, recorded that
        decision unchanged. It is not a payment and not a guarantee.
      </p>
    </TextPage>
  );
}
