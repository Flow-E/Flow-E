'use client';

import { useActionState, useState } from 'react';
import { FileUp, PenLine } from 'lucide-react';
import { buttonClass } from '@/components/ui';

type Result = { ok?: string; error?: string };
type Act = (prev: Result, form: FormData) => Promise<Result>;

/** The invoice fields as text. */
export interface InvoiceFields {
  supplier: string;
  number: string;
  invoiceDate: string;
  amount: string;
  currency: string;
  reference: string;
}

const input =
  'mt-1 h-10 w-full rounded-lg border border-rule-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3';
const label = 'block text-sm font-medium text-ink-2';

function Status({ state }: { state: Result }) {
  return (
    <p aria-live="polite" className="text-sm empty:hidden">
      {state.error ? (
        <span role="alert" className="whitespace-pre-line text-decline">
          {state.error}
        </span>
      ) : null}
      {state.ok ? <span className="text-approve">{state.ok}</span> : null}
    </p>
  );
}

function Hidden({ fields }: { fields: Record<string, string> }) {
  return (
    <>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

/** The invoice form: typed in, or read from a file and checked here before it is recorded. */
export function InvoiceForm({
  action,
  fields,
  initial,
  source,
  fileId,
  notice,
}: {
  action: Act;
  fields: Record<string, string>;
  initial: InvoiceFields;
  source: 'manual' | 'extracted';
  fileId?: string;
  notice?: string;
}) {
  const [state, run, pending] = useActionState<Result, FormData>(action, {});
  return (
    <form action={run} className="space-y-4">
      <Hidden fields={{ ...fields, source, ...(fileId ? { fileId } : {}) }} />
      {notice ? (
        <p className="rounded-lg bg-sunken px-3 py-2 text-sm text-ink-2">{notice}</p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={`${label} sm:col-span-2`}>
          Supplier
          <input
            name="supplier"
            required
            maxLength={200}
            defaultValue={initial.supplier}
            autoComplete="off"
            className={input}
          />
        </label>
        <label className={label}>
          Invoice number
          <input
            name="number"
            required
            maxLength={80}
            defaultValue={initial.number}
            placeholder="INV-2026-0042"
            autoComplete="off"
            className={`${input} font-mono`}
          />
        </label>
        <label className={label}>
          Invoice date
          <input
            name="invoiceDate"
            type="date"
            required
            defaultValue={initial.invoiceDate}
            className={input}
          />
        </label>
        <label className={label}>
          Total
          <input
            name="amount"
            required
            inputMode="decimal"
            maxLength={20}
            defaultValue={initial.amount}
            placeholder="1250.50"
            autoComplete="off"
            className={`${input} tabular font-mono`}
          />
        </label>
        <label className={label}>
          Currency
          <input
            name="currency"
            required
            maxLength={5}
            defaultValue={initial.currency}
            placeholder="CHF"
            autoComplete="off"
            className={`${input} font-mono uppercase`}
          />
        </label>
        <label className={`${label} sm:col-span-2`}>
          Reference
          <input
            name="reference"
            maxLength={80}
            defaultValue={initial.reference}
            placeholder="pay_…"
            autoComplete="off"
            aria-describedby="reference-help"
            className={`${input} font-mono`}
          />
          <span id="reference-help" className="mt-1 block text-xs font-normal text-ink-3">
            The payment id the agent quoted to the supplier, usually printed on the invoice. Leave
            it empty if there is none; Flow-E then matches by supplier and amount.
          </span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>
          {pending ? 'Saving…' : source === 'extracted' ? 'Confirm invoice' : 'Record invoice'}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

interface UploadAnswer {
  fileId?: string;
  filename?: string;
  reading?: 'off' | 'done' | 'failed';
  fields?: InvoiceFields | null;
  error?: string;
}

const NOTICE: Record<'off' | 'done' | 'failed', string> = {
  off: 'Automatic reading is off. Type the fields from the invoice; the file is kept with it.',
  done: 'Read automatically. Check every field against the invoice before you confirm: nothing is recorded until you do.',
  failed:
    'Could not read this file automatically. Type the fields from the invoice; the file is kept with it.',
};

/**
 * Add an invoice: upload a PDF or image (read automatically when that is on), or type it in.
 * Without `uploadUrl` (the sandbox) only typing is offered.
 */
export function AddInvoice({
  action,
  fields,
  initial,
  uploadUrl,
}: {
  action: Act;
  fields: Record<string, string>;
  initial: InvoiceFields;
  uploadUrl: string | null;
}) {
  const [mode, setMode] = useState<'upload' | 'manual'>(uploadUrl ? 'upload' : 'manual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<UploadAnswer | null>(null);

  async function upload(form: FormData) {
    if (!uploadUrl) return;
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setError('Choose a PDF, PNG or JPEG file.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError('The file is larger than 4 MB.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(uploadUrl, { method: 'POST', body: form });
      const body = (await res.json().catch(() => ({}))) as UploadAnswer;
      if (!res.ok || !body.fileId) {
        setError(body.error ?? 'The upload did not work. Please try again.');
        return;
      }
      setAnswer(body);
    } catch {
      setError('The upload did not work. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (answer?.fileId) {
    const read = answer.reading === 'done' && answer.fields ? answer.fields : null;
    const merged: InvoiceFields = read
      ? {
          supplier: read.supplier || initial.supplier,
          number: read.number || initial.number,
          invoiceDate: read.invoiceDate || initial.invoiceDate,
          amount: read.amount || initial.amount,
          currency: read.currency || initial.currency,
          reference: read.reference || initial.reference,
        }
      : initial;
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-2">
          File: <span className="font-mono">{answer.filename}</span>
        </p>
        <InvoiceForm
          action={action}
          fields={fields}
          initial={merged}
          source={read ? 'extracted' : 'manual'}
          fileId={answer.fileId}
          notice={NOTICE[answer.reading ?? 'off']}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {uploadUrl ? (
        <div role="tablist" aria-label="How to add the invoice" className="flex flex-wrap gap-2">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'upload'}
            onClick={() => {
              setMode('upload');
            }}
            className={buttonClass(mode === 'upload' ? 'secondary' : 'quiet', 'sm')}
          >
            <FileUp size={15} aria-hidden="true" /> Upload a file
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'manual'}
            onClick={() => {
              setMode('manual');
            }}
            className={buttonClass(mode === 'manual' ? 'secondary' : 'quiet', 'sm')}
          >
            <PenLine size={15} aria-hidden="true" /> Type it in
          </button>
        </div>
      ) : null}

      {mode === 'upload' && uploadUrl ? (
        <form action={upload} className="space-y-3">
          <Hidden fields={fields} />
          <label className={label}>
            Invoice file (PDF, PNG or JPEG, up to 4 MB)
            <input
              name="file"
              type="file"
              required
              accept="application/pdf,image/png,image/jpeg"
              className="mt-1 block w-full text-sm text-ink file:mr-3 file:h-9 file:rounded-lg file:border file:border-rule-strong file:bg-surface file:px-3 file:text-sm file:text-ink"
            />
          </label>
          <p className="text-xs text-ink-3">
            The file is kept with the invoice for 10 years. You check the fields before anything is
            recorded.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy} className={buttonClass('primary')}>
              {busy ? 'Reading…' : 'Upload'}
            </button>
            {error ? (
              <p role="alert" className="text-sm text-decline">
                {error}
              </p>
            ) : null}
          </div>
        </form>
      ) : (
        <InvoiceForm action={action} fields={fields} initial={initial} source="manual" />
      )}
    </div>
  );
}

/** Accept or reject an invoice that did not match; rejecting needs a reason. */
export function ResolveInvoiceForm({
  action,
  fields,
}: {
  action: Act;
  fields: Record<string, string>;
}) {
  const [state, run, pending] = useActionState<Result, FormData>(action, {});
  return (
    <form action={run} className="space-y-3">
      <Hidden fields={fields} />
      <label className={label}>
        Reason (needed to reject)
        <textarea
          name="note"
          rows={2}
          maxLength={500}
          placeholder="e.g. Price agreed by phone; or: not ordered by us"
          className="mt-1 w-full rounded-lg border border-rule-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="outcome"
          value="accepted"
          disabled={pending}
          className={buttonClass('primary', 'sm')}
        >
          Accept
        </button>
        <button
          type="submit"
          name="outcome"
          value="rejected"
          disabled={pending}
          className={buttonClass('danger', 'sm')}
        >
          Reject
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}
