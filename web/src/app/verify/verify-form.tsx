'use client';

import { useId, useState, type ReactNode } from 'react';
import { CircleCheck, CircleHelp, CircleX } from 'lucide-react';
import { buttonClass } from '@/components/ui';
import { money } from '@/lib/format';
import type { PublicVerifyResult, VerifiedPayment } from '@/server/public-verify';

/** Must match MAX_RECEIPT_BYTES in src/server/public-verify.ts (the server checks again). */
const MAX_BYTES = 32 * 1024;

const DECISION: Record<VerifiedPayment['decision'], { label: string; note: string }> = {
  approved: {
    label: 'Approved by the buyer’s rules',
    note: 'Flow-E authorized this payment when it signed the receipt.',
  },
  review: {
    label: 'Sent to a person for approval',
    note: 'When signed, the payment waited for a person to approve it. Ask the buyer whether it was approved.',
  },
  declined: {
    label: 'Declined',
    note: 'Flow-E did not authorize this payment.',
  },
};

function utc(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return `${new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(t))} UTC`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </>
  );
}

export function OfflineSteps() {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-2">
      <li>
        Ask the organisation that gave you the receipt for its issuer public key (the file{' '}
        <span className="font-mono">issuer.pub</span>).
      </li>
      <li>
        Install the Flow-E command line from the{' '}
        <a href="https://github.com/Flow-E/Flow-E" className="text-accent underline">
          open-source repository
        </a>
        .
      </li>
      <li>
        Run{' '}
        <code className="break-all rounded bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink">
          flow-e verify receipt.json --pubkey issuer.pub --offline
        </code>
      </li>
    </ol>
  );
}

function Result({ r }: { r: PublicVerifyResult }) {
  if (r.outcome === 'error') {
    return (
      <p role="alert" className="rounded-lg bg-decline-soft px-4 py-3 text-sm text-decline">
        {r.error}
      </p>
    );
  }
  if (r.outcome === 'unknown-issuer') {
    return (
      <div className="space-y-3 rounded-xl border border-review/30 bg-review-soft px-4 py-4">
        <p className="flex items-start gap-2 font-semibold text-review">
          <CircleHelp size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
          Unknown issuer: this site cannot check it
        </p>
        <p className="text-sm text-ink-2">
          No Flow-E organisation on this site has the issuer id{' '}
          <span className="break-all font-mono text-xs">{r.issuer}</span>. That does not make the
          receipt false: it may come from a Flow-E installation elsewhere. Check it offline:
        </p>
        <OfflineSteps />
      </div>
    );
  }
  if (r.outcome === 'invalid') {
    return (
      <div className="space-y-2 rounded-xl border border-decline/30 bg-decline-soft px-4 py-4">
        <p className="flex items-start gap-2 font-semibold text-decline">
          <CircleX size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
          Not valid: do not rely on this receipt
        </p>
        <p className="text-sm text-ink-2">
          It names a Flow-E {r.issuerKind === 'sandbox' ? 'sandbox' : 'organisation'} on this site,
          but it was changed after signing or was not signed by it.
        </p>
        <ul className="space-y-0.5 text-sm text-ink-2">
          {(r.checks ?? []).map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    );
  }
  const p = r.payment;
  return (
    <div className="space-y-4 rounded-xl border border-approve/30 bg-approve-soft px-4 py-4">
      <p className="flex items-start gap-2 font-semibold text-approve">
        <CircleCheck size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
        Valid: Flow-E signed this receipt and it is unchanged
      </p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr] [&_dd]:mb-2 sm:[&_dd]:mb-0">
        <Row label="Issued by">
          {r.issuerKind === 'sandbox'
            ? 'A Flow-E sandbox: the company, suppliers and money are fictional'
            : `${r.issuerName ?? 'A Flow-E organisation'} (a Flow-E organisation on this site)`}
        </Row>
        <Row label="Issuer id">
          <span className="break-all font-mono text-xs">{r.issuer}</span>
        </Row>
        {p ? (
          <>
            <Row label="Agent">
              <span className="font-mono">{p.agentId}</span>
            </Row>
            <Row label="Amount">
              <span className="tabular font-mono">{money(p.amount, p.currency)}</span>
              {p.currency !== p.baseCurrency && p.amountBase !== null ? (
                <span className="text-ink-2">
                  {' '}
                  ({money(p.amountBase, p.baseCurrency)} in the buyer’s currency)
                </span>
              ) : null}
            </Row>
            <Row label="Supplier">{p.merchant}</Row>
            {p.memo ? <Row label="Memo">{p.memo}</Row> : null}
            <Row label="Decision when signed">
              <span className="font-medium">{DECISION[p.decision].label}</span>
              <span className="block text-ink-2">{DECISION[p.decision].note}</span>
            </Row>
            <Row label="Reason">{p.reason}</Row>
            <Row label="Date">{utc(p.createdAt)}</Row>
            <Row label="Payment id">
              <span className="break-all font-mono text-xs">{p.paymentId}</span>
            </Row>
          </>
        ) : (
          <>
            <Row label="Entry">
              <span className="font-mono">{r.entryType}</span> (a ledger entry, not a payment
              decision)
            </Row>
            {r.createdAt ? <Row label="Date">{utc(r.createdAt)}</Row> : null}
          </>
        )}
      </dl>
      <p className="text-xs text-ink-3">
        This is the status when the receipt was signed. A later approval, decline or cancellation is
        a separate signed entry in the buyer’s ledger and is not part of this receipt.
      </p>
    </div>
  );
}

export function PublicVerifyForm() {
  const [receipt, setReceipt] = useState('');
  const [result, setResult] = useState<PublicVerifyResult | null>(null);
  const [pending, setPending] = useState(false);
  const id = useId();
  const fileId = useId();

  async function check() {
    setPending(true);
    setResult(null);
    try {
      if (new TextEncoder().encode(receipt).byteLength > MAX_BYTES) {
        setResult({
          outcome: 'error',
          error: 'That is too long to be a Flow-E receipt (32 KB at most).',
        });
        return;
      }
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: receipt,
        cache: 'no-store',
      });
      const body = (await res.json().catch(() => null)) as PublicVerifyResult | null;
      setResult(
        body && typeof body.outcome === 'string'
          ? body
          : { outcome: 'error', error: 'The check did not answer. Please try again.' },
      );
    } catch {
      setResult({ outcome: 'error', error: 'The check did not answer. Please try again.' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
        className="space-y-3"
      >
        <label htmlFor={id} className="block text-sm font-medium text-ink">
          Receipt
        </label>
        <textarea
          id={id}
          name="receipt"
          rows={9}
          value={receipt}
          onChange={(e) => {
            setReceipt(e.target.value);
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder='{ "format": "flow-e-receipt/v1", … }'
          className="tabular w-full rounded-lg border border-rule-strong bg-surface p-3 font-mono text-xs text-ink placeholder:text-ink-3"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending || receipt.trim() === ''}
            className={`${buttonClass('primary')} w-full sm:w-auto`}
          >
            {pending ? 'Checking…' : 'Check receipt'}
          </button>
          <label
            htmlFor={fileId}
            className={`${buttonClass('secondary')} w-full cursor-pointer sm:w-auto`}
          >
            Open a receipt file
          </label>
          <input
            id={fileId}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (file.size > MAX_BYTES) {
                setResult({
                  outcome: 'error',
                  error: 'That file is too large to be a Flow-E receipt (32 KB at most).',
                });
                return;
              }
              void file.text().then((t) => {
                setReceipt(t);
                setResult(null);
              });
            }}
          />
        </div>
      </form>
      <div aria-live="polite">{result ? <Result r={result} /> : null}</div>
    </div>
  );
}
