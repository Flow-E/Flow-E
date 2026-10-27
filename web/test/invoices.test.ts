import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError, needsReview } from '@flow-e/mcp/core';
import { migrate, openPglite, type Db } from '@/server/db';
import { extractInvoice, extractorFromEnv, type Extractor } from '@/server/invoice-extract';
import { MAX_INVOICE_FILE_BYTES, invoiceCsv } from '@/server/invoices';
import { ForbiddenError } from '@/server/permissions';
import { SandboxStore } from '@/server/store';
import {
  ALICE,
  BOB,
  CAROL,
  DAVE,
  MIGRATIONS,
  NOW,
  ORIGIN,
  request,
  world,
  type World,
} from './org-helpers';

const PDF = new Uint8Array(Buffer.from('%PDF-1.4\n% fictional invoice for tests\n%%EOF\n'));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let n = 0;
const num = () => `INV-${String(++n).padStart(4, '0')}`;

/** A fake Messages API answer whose text is `text`. */
function apiAnswer(text: string): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function invoiceEntries(w: World) {
  const v = await w.store.view(w.orgId, ALICE);
  return v.entries.filter((e) => e.type.startsWith('invoice.'));
}

describe('organisation invoices', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.close();
  });

  /** An approved payment of `amount` CHF to a new fictional supplier. */
  async function approved(amount = '100') {
    const req = request(amount);
    const p = await w.store.requestPayment(w.auth, req, ORIGIN);
    expect(p.decision).toBe('approved');
    return { id: p.payment_id, supplier: req.merchant };
  }

  it('matches by reference and shows the invoice on the payment', async () => {
    const p = await approved('100');
    const r = await w.store.addInvoice(w.orgId, BOB, {
      supplier: p.supplier,
      number: num(),
      invoiceDate: '2026-10-20',
      amount: '101.00',
      currency: 'chf',
      reference: p.id,
    });
    expect(r.match).toBe('matched');
    const detail = await w.store.payment(w.orgId, CAROL, p.id);
    expect(detail?.payment.fulfilment?.invoice?.match).toBe('matched');
    expect(detail?.payment.fulfilment?.invoice?.invoiceId).toBe(r.invoiceId);
    const inv = await w.store.invoiceDetail(w.orgId, CAROL, r.invoiceId);
    expect(inv?.invoice.difference).toBe(100);
    expect(inv?.payment?.paymentId).toBe(p.id);
    expect(inv?.seq).toBeGreaterThan(0);
  });

  it('matches by supplier and amount without a reference', async () => {
    const p = await approved('80');
    const r = await w.store.addInvoice(w.orgId, ALICE, {
      supplier: p.supplier,
      number: num(),
      invoiceDate: '2026-10-20',
      amount: '80',
      currency: 'CHF',
    });
    expect(r.match).toBe('matched');
  });

  it('flags a mismatch above the approved amount, then a person accepts it', async () => {
    const p = await approved('100');
    const r = await w.store.addInvoice(w.orgId, ALICE, {
      supplier: p.supplier,
      number: num(),
      invoiceDate: '2026-10-20',
      amount: '150.00',
      currency: 'CHF',
      reference: p.id,
    });
    expect(r.match).toBe('mismatch');
    let inv = await w.store.invoiceDetail(w.orgId, ALICE, r.invoiceId);
    expect(inv?.invoice.difference).toBe(5000);
    expect(inv && needsReview(inv.invoice)).toBe(true);
    await w.store.resolveInvoice(w.orgId, BOB, r.invoiceId, 'accepted', 'Price agreed by phone');
    inv = await w.store.invoiceDetail(w.orgId, ALICE, r.invoiceId);
    expect(inv?.invoice.resolution).toMatchObject({ outcome: 'accepted', by: 'bob@example.com' });
    await expect(
      w.store.resolveInvoice(w.orgId, BOB, r.invoiceId, 'rejected', 'again'),
    ).rejects.toThrow(ActionError);
  });

  it('records an unmatched invoice; rejecting needs a reason', async () => {
    const r = await w.store.addInvoice(w.orgId, ALICE, {
      supplier: 'Nobody We Know GmbH (fictional)',
      number: num(),
      invoiceDate: '2026-10-20',
      amount: '42.00',
      currency: 'CHF',
    });
    expect(r.match).toBe('unmatched');
    await expect(w.store.resolveInvoice(w.orgId, ALICE, r.invoiceId, 'rejected')).rejects.toThrow(
      'reason',
    );
    await w.store.resolveInvoice(w.orgId, ALICE, r.invoiceId, 'rejected', 'Not ordered by us');
    const list = await w.store.invoices(w.orgId, CAROL);
    expect(list.find((i) => i.invoiceId === r.invoiceId)?.resolution?.outcome).toBe('rejected');
  });

  it('spots a duplicate (same supplier and number)', async () => {
    const p = await approved('60');
    const number = num();
    const input = {
      supplier: p.supplier,
      number,
      invoiceDate: '2026-10-20',
      amount: '60',
      currency: 'CHF',
      reference: p.id,
    };
    expect((await w.store.addInvoice(w.orgId, ALICE, input)).match).toBe('matched');
    expect((await w.store.addInvoice(w.orgId, ALICE, input)).match).toBe('duplicate');
  });

  it('a viewer reads but cannot record or decide', async () => {
    const r = await w.store.addInvoice(w.orgId, ALICE, {
      supplier: 'Viewer Test AG (fictional)',
      number: num(),
      invoiceDate: '2026-10-20',
      amount: '5',
      currency: 'CHF',
    });
    await expect(
      w.store.addInvoice(w.orgId, CAROL, {
        supplier: 'Viewer Test AG (fictional)',
        number: num(),
        invoiceDate: '2026-10-20',
        amount: '5',
        currency: 'CHF',
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(w.store.resolveInvoice(w.orgId, CAROL, r.invoiceId, 'accepted')).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      w.store.uploadInvoice(w.orgId, CAROL, { filename: 'a.pdf', bytes: PDF }, null),
    ).rejects.toThrow(ForbiddenError);
    expect((await w.store.invoices(w.orgId, CAROL)).length).toBeGreaterThan(0);
  });

  it('another organisation can neither read, decide nor download', async () => {
    const r = await w.store.addInvoice(w.orgId, ALICE, {
      supplier: 'Private Supplier AG (fictional)',
      number: num(),
      invoiceDate: '2026-10-20',
      amount: '9',
      currency: 'CHF',
    });
    const up = await w.store.uploadInvoice(
      w.orgId,
      ALICE,
      { filename: 'private.pdf', bytes: PDF },
      null,
    );
    const daveOrg = await w.store.createOrg(DAVE, {
      name: 'Other Org AG (fictional)',
      baseCurrency: 'CHF',
      timezone: 'Europe/Zurich',
    });
    await expect(w.store.invoices(w.orgId, DAVE)).rejects.toThrow(ForbiddenError);
    await expect(w.store.invoiceDetail(w.orgId, DAVE, r.invoiceId)).rejects.toThrow(ForbiddenError);
    await expect(w.store.resolveInvoice(w.orgId, DAVE, r.invoiceId, 'accepted')).rejects.toThrow(
      ForbiddenError,
    );
    await expect(w.store.invoiceFile(w.orgId, DAVE, up.fileId)).rejects.toThrow(ForbiddenError);
    await expect(w.store.invoiceCsv(w.orgId, DAVE)).rejects.toThrow(ForbiddenError);
    // Through his own organisation: the file and the invoice are simply not there.
    expect(await w.store.invoiceFile(daveOrg, DAVE, up.fileId)).toBeNull();
    expect(await w.store.invoiceDetail(daveOrg, DAVE, r.invoiceId)).toBeNull();
    await expect(w.store.resolveInvoice(daveOrg, DAVE, r.invoiceId, 'accepted')).rejects.toThrow(
      ActionError,
    );
    await expect(
      w.store.addInvoice(daveOrg, DAVE, {
        supplier: 'Thief AG (fictional)',
        number: num(),
        invoiceDate: '2026-10-20',
        amount: '1',
        currency: 'CHF',
        fileId: up.fileId,
      }),
    ).rejects.toThrow('not in this organisation');
    // A member downloads the very bytes that were uploaded.
    const mine = await w.store.invoiceFile(w.orgId, CAROL, up.fileId);
    expect(mine?.mime).toBe('application/pdf');
    expect(new Uint8Array(mine?.bytes ?? [])).toEqual(PDF);
  });

  it('accepts only PDF, PNG or JPEG up to 4 MB', async () => {
    await expect(
      w.store.uploadInvoice(
        w.orgId,
        ALICE,
        { filename: 'x.pdf', bytes: new Uint8Array(Buffer.from('<html>not a pdf</html>')) },
        null,
      ),
    ).rejects.toThrow('PDF, PNG or JPEG');
    const big = new Uint8Array(MAX_INVOICE_FILE_BYTES + 1);
    big.set(PDF);
    await expect(
      w.store.uploadInvoice(w.orgId, ALICE, { filename: 'big.pdf', bytes: big }, null),
    ).rejects.toThrow('4 MB');
    const png = await w.store.uploadInvoice(
      w.orgId,
      ALICE,
      { filename: '../../evil name.png', bytes: PNG },
      null,
    );
    expect(png.filename).toBe('evil-name.png');
  });

  it('extraction fills the form but records nothing until a person confirms', async () => {
    const p = await approved('100');
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        model: string;
        max_tokens: number;
        messages: { content: { type: string; source?: { media_type: string } }[] }[];
      };
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body.max_tokens).toBeLessThanOrEqual(1000);
      expect(body.messages[0]?.content[0]).toMatchObject({
        type: 'document',
        source: { media_type: 'application/pdf' },
      });
      expect(new Headers(init.headers).get('x-api-key')).toBe('test-key');
      return Promise.resolve(
        apiAnswer(
          JSON.stringify({
            supplier: p.supplier,
            number: 'R-7781',
            date: '2026-10-19',
            total: '100.00',
            currency: 'chf',
            reference: p.id,
          }),
        ),
      );
    });
    const extract: Extractor = (bytes, mime) =>
      extractInvoice(bytes, mime, { apiKey: 'test-key', fetch: fetchMock as typeof fetch });

    const before = (await invoiceEntries(w)).length;
    const up = await w.store.uploadInvoice(
      w.orgId,
      BOB,
      { filename: 'R-7781.pdf', bytes: PDF },
      extract,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(up.reading).toBe('done');
    expect(up.fields).toEqual({
      supplier: p.supplier,
      number: 'R-7781',
      invoiceDate: '2026-10-19',
      amount: '100.00',
      currency: 'CHF',
      reference: p.id,
    });
    // Nothing in the ledger, the file not attached, the payment without an invoice.
    expect((await invoiceEntries(w)).length).toBe(before);
    const row = await w.db.query<{ invoice_id: string | null }>(
      'select invoice_id from org_invoice_files where id = $1',
      [up.fileId],
    );
    expect(row[0]?.invoice_id).toBeNull();
    expect((await w.store.payment(w.orgId, BOB, p.id))?.payment.fulfilment?.invoice).toBeFalsy();

    // The person confirms (here unchanged): now it is a signed entry with the file's hash.
    const r = await w.store.addInvoice(w.orgId, BOB, {
      ...(up.fields ?? {
        supplier: '',
        number: '',
        invoiceDate: '',
        amount: '',
        currency: '',
        reference: '',
      }),
      source: 'extracted',
      fileId: up.fileId,
    });
    expect(r.match).toBe('matched');
    const entries = await invoiceEntries(w);
    expect(entries.length).toBe(before + 1);
    const data = JSON.parse(entries.at(-1)?.data ?? '{}') as Record<string, unknown>;
    expect(data.source).toBe('extracted');
    expect(data.file_id).toBe(up.fileId);
    expect(data.file_sha256).toMatch(/^[0-9a-f]{64}$/);
    const detail = await w.store.invoiceDetail(w.orgId, CAROL, r.invoiceId);
    expect(detail?.file?.id).toBe(up.fileId);
    // A file belongs to one invoice only.
    await expect(
      w.store.addInvoice(w.orgId, BOB, {
        supplier: 'Again AG (fictional)',
        number: num(),
        invoiceDate: '2026-10-20',
        amount: '1',
        currency: 'CHF',
        fileId: up.fileId,
      }),
    ).rejects.toThrow('already has an invoice');
  });

  it('an unusable model answer leaves an empty form', async () => {
    const extract: Extractor = (bytes, mime) =>
      extractInvoice(bytes, mime, {
        apiKey: 'test-key',
        fetch: () => Promise.resolve(apiAnswer('Sorry, I cannot read this.')),
      });
    const up = await w.store.uploadInvoice(
      w.orgId,
      ALICE,
      { filename: 'scan.png', bytes: PNG },
      extract,
    );
    expect(up).toMatchObject({ reading: 'failed', fields: null });
    const failing: Extractor = (bytes, mime) =>
      extractInvoice(bytes, mime, {
        apiKey: 'test-key',
        fetch: () => Promise.resolve(new Response('{}', { status: 500 })),
      });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      (await w.store.uploadInvoice(w.orgId, ALICE, { filename: 'a.pdf', bytes: PDF }, failing))
        .reading,
    ).toBe('failed');
    // Only the status is logged: never the file, the key or the answer.
    expect(JSON.stringify(errSpy.mock.calls)).not.toMatch(/test-key|PDF-1\.4/);
    errSpy.mockRestore();
  });

  it('a bad field from the model is dropped, the others kept', async () => {
    const fields = await extractInvoice(PDF, 'application/pdf', {
      apiKey: 'k',
      fetch: () =>
        Promise.resolve(
          apiAnswer(
            'Here you go: {"supplier":"Fictional AG","number":"A1","date":"19.10.2026","total":"1\'250.00","currency":"CHF","reference":null}',
          ),
        ),
    });
    expect(fields).toEqual({
      supplier: 'Fictional AG',
      number: 'A1',
      invoiceDate: '',
      amount: '',
      currency: 'CHF',
      reference: '',
    });
  });

  it('without ANTHROPIC_API_KEY upload keeps the file and manual entry works', async () => {
    expect(extractorFromEnv({ NODE_ENV: 'test' })).toBeNull();
    expect(extractorFromEnv({ NODE_ENV: 'test', ANTHROPIC_API_KEY: '  ' })).toBeNull();
    const up = await w.store.uploadInvoice(
      w.orgId,
      ALICE,
      { filename: 'paper.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]) },
      extractorFromEnv({ NODE_ENV: 'test' }),
    );
    expect(up).toMatchObject({ reading: 'off', fields: null });
    const r = await w.store.addInvoice(w.orgId, ALICE, {
      supplier: 'Paper Supplier AG (fictional)',
      number: num(),
      invoiceDate: '2026-10-20',
      amount: '12.50',
      currency: 'CHF',
      fileId: up.fileId,
    });
    expect(r.match).toBe('unmatched');
    // "Read from a file" is only possible with a file.
    await expect(
      w.store.addInvoice(w.orgId, ALICE, {
        supplier: 'X AG',
        number: num(),
        invoiceDate: '2026-10-20',
        amount: '1',
        currency: 'CHF',
        source: 'extracted',
      }),
    ).rejects.toThrow(ActionError);
  });

  it('exports matched and accepted invoices as formula-safe CSV', async () => {
    const p = await approved('70');
    await w.store.addInvoice(w.orgId, ALICE, {
      supplier: '=HYPERLINK("http://example.com","x")',
      number: num(),
      invoiceDate: '2026-10-20',
      amount: '70',
      currency: 'CHF',
      reference: p.id,
    });
    const csv = await w.store.invoiceCsv(w.orgId, CAROL);
    const [header, ...rows] = csv.trim().split('\r\n');
    expect(header).toBe(
      '"invoice_id","supplier","number","date","amount","currency","reference","payment_id","status","matched_at","by"',
    );
    expect(csv).toContain(`"'=HYPERLINK(""http://example.com"",""x"")"`);
    expect(csv).not.toMatch(/(^|,)"=/m);
    expect(csv).toContain('"70.00","CHF"');
    expect(rows.some((r) => r.includes('"accepted"'))).toBe(true);
    expect(rows.some((r) => /"(unmatched|rejected|duplicate|mismatch)"/.test(r))).toBe(false);
    // Any other formula start is neutralised too.
    expect(
      invoiceCsv(
        [
          {
            invoiceId: 'inv_1',
            supplier: '+1+1',
            number: '-2',
            invoiceDate: '2026-10-20',
            amount: 100,
            currency: 'CHF',
            reference: '@SUM(A1)',
            paymentId: null,
            match: 'matched',
            difference: 0,
            explanation: '',
            source: 'manual',
            recordedBy: 'a',
            recordedAt: '2026-10-20T00:00:00.000Z',
            resolution: null,
          },
        ],
        undefined,
      ),
    ).toContain(`"'+1+1","'-2"`);
  });

  it('keeps the ledger intact', async () => {
    const v = await w.store.view(w.orgId, ALICE);
    expect(v.audit.ok).toBe(true);
    expect(v.entries.some((e) => e.type === 'invoice.resolved')).toBe(true);
  });
});

describe('sandbox invoices', () => {
  let db: Db;
  let store: SandboxStore;
  const OWNER = 'dev:alice@example.com';
  const by = { by: 'alice@example.com (sandbox)' };
  const gloves = {
    agentId: 'lab-procurement',
    merchant: 'Example Labware AG',
    amount: '240.00',
    currency: 'CHF',
    category: '5047',
    country: 'CH',
  };

  beforeEach(async () => {
    db = await openPglite();
    await migrate(db, MIGRATIONS);
    store = new SandboxStore(db, randomBytes(32), { clock: () => NOW });
    await store.ensureSandbox(OWNER);
  });
  afterEach(async () => {
    await db.close();
  });

  it('matches, flags, decides and exports; the ledger stays intact', async () => {
    const p = await store.requestPayment(OWNER, gloves);
    expect(p.result.decision).toBe('approved');
    const ok = await store.addInvoice(
      OWNER,
      {
        supplier: gloves.merchant,
        number: 'EL-1',
        invoiceDate: '2026-10-20',
        amount: '240.00',
        currency: 'CHF',
        reference: p.paymentId,
      },
      by,
    );
    expect(ok.match).toBe('matched');
    const p2 = await store.requestPayment(OWNER, gloves);
    const over = await store.addInvoice(
      OWNER,
      {
        supplier: gloves.merchant,
        number: 'EL-2',
        invoiceDate: '2026-10-20',
        amount: '300.00',
        currency: 'CHF',
        reference: p2.paymentId,
      },
      by,
    );
    expect(over.match).toBe('mismatch');
    expect((await store.invoiceDetail(OWNER, over.invoiceId))?.invoice.difference).toBe(6000);
    const lost = await store.addInvoice(
      OWNER,
      {
        supplier: 'Unknown Supplier AG',
        number: 'U-1',
        invoiceDate: '2026-10-20',
        amount: '10',
        currency: 'CHF',
      },
      by,
    );
    expect(lost.match).toBe('unmatched');
    const dup = await store.addInvoice(
      OWNER,
      {
        supplier: gloves.merchant,
        number: 'EL-1',
        invoiceDate: '2026-10-20',
        amount: '240.00',
        currency: 'CHF',
      },
      by,
    );
    expect(dup.match).toBe('duplicate');

    await store.resolveInvoice(OWNER, over.invoiceId, 'accepted', by);
    await expect(store.resolveInvoice(OWNER, lost.invoiceId, 'rejected', by)).rejects.toThrow(
      'reason',
    );
    await store.resolveInvoice(OWNER, lost.invoiceId, 'rejected', { ...by, note: 'Not ours' });

    const list = await store.invoices(OWNER);
    expect(list.map((i) => i.resolution?.outcome ?? i.match)).toEqual([
      'duplicate',
      'rejected',
      'accepted',
      'matched',
    ]);
    const csv = await store.invoiceCsv(OWNER);
    expect(csv.trim().split('\r\n')).toHaveLength(3);

    // Another sandbox owner sees none of it.
    await store.ensureSandbox('dev:bob@example.com');
    expect(await store.invoices('dev:bob@example.com')).toEqual([]);
    expect(await store.invoiceDetail('dev:bob@example.com', ok.invoiceId)).toBeNull();
    await expect(
      store.resolveInvoice('dev:bob@example.com', over.invoiceId, 'accepted', by),
    ).rejects.toThrow(ActionError);

    expect((await store.view(OWNER)).audit.ok).toBe(true);
  });

  it('ignores a file or "extracted" claim: the sandbox takes typed-in invoices only', async () => {
    const r = await store.addInvoice(
      OWNER,
      {
        supplier: 'Typed AG',
        number: 'T-1',
        invoiceDate: '2026-10-20',
        amount: '1',
        currency: 'CHF',
        source: 'extracted',
        fileId: '00000000-0000-4000-8000-000000000000',
      },
      by,
    );
    expect((await store.invoiceDetail(OWNER, r.invoiceId))?.invoice.source).toBe('manual');
  });
});
