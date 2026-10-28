import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_EXAMPLES, VERIFY_WEBHOOK_SNIPPET } from '@/content/api-examples';
import { newApiLimiter, withApiKey } from '@/server/api-auth';
import { ApiKeyStore } from '@/server/api-keys';
import { getPayment, getReceipt, listOrders, postSignal, type V1Deps } from '@/server/api-v1';
import { ReorderStore } from '@/server/reorder';
import { sign } from '@/server/webhooks';
import { ALICE, ORIGIN, request, world, type World } from './org-helpers';

/**
 * Every example on the "Connect your systems" page runs here, against a test server with the
 * same fictional price list the examples name. If an example stops working, this fails.
 */
describe('the examples on /developers', () => {
  let w: World;
  let deps: V1Deps;
  let keys: Record<string, string>;
  let paymentId: string;

  beforeAll(async () => {
    w = await world();
    const view = await w.store.view(w.orgId, ALICE);
    await w.store.updateConfig(w.orgId, ALICE, {
      ...view.raw,
      reference_prices: [
        { item: 'Pipette tips, 20 racks', price: '120', supplier: 'Example Labware AG' },
        { item: 'Nitrile gloves, 10 boxes', price: '40' },
      ],
    });
    const store = new ApiKeyStore(w.db, w.store, { clock: () => w.clock.now });
    deps = {
      keys: store,
      orgs: w.store,
      reorder: new ReorderStore(w.db, w.store),
      limiter: newApiLimiter(),
    };
    keys = {
      'reorder:write': (
        await store.create(w.orgId, ALICE, { name: 'Inventory', scopes: ['reorder:write'] })
      ).key,
      read: (await store.create(w.orgId, ALICE, { name: 'Accounting', scopes: ['read'] })).key,
    };
    paymentId = (await w.store.requestPayment(w.auth, request('100', 'Example Labware AG'), ORIGIN))
      .payment_id;
    w.clock.now += 11 * 60_000;
    await w.store.agentRecordOrder(w.auth, paymentId, 'PO-1042');
  });
  afterAll(async () => {
    await w.close();
  });

  for (const e of API_EXAMPLES) {
    it(`${e.method} ${e.path}: ${e.title}`, async () => {
      const path = e.path.replace('{payment_id}', paymentId);
      const req = new Request(`http://localhost${path}`, {
        method: e.method,
        headers: {
          authorization: `Bearer ${keys[e.scope] ?? ''}`,
          ...(e.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(e.body ? { body: JSON.stringify(e.body) } : {}),
      });
      const url = new URL(req.url);
      const res =
        e.method === 'POST'
          ? await withApiKey(req, deps, e.scope, (c) => postSignal(req, c, deps))
          : await withApiKey(req, deps, e.scope, async (c) => {
              const data = await deps.orgs.systemView(c.orgId);
              const [, , , kind, id = ''] = url.pathname.split('/');
              if (kind === 'orders') return listOrders(data, url);
              return kind === 'payments' ? getPayment(data, id) : getReceipt(data, id);
            });
      expect(res.status).toBe(e.status);
      const body = (await res.json()) as Record<string, unknown>;
      // The example answer's fields are really there.
      for (const field of [...e.answer.matchAll(/"(\w+)":/g)].map((m) => m[1] ?? '').slice(0, 4)) {
        if (e.id !== 'orders') expect(Object.keys(body)).toContain(field);
      }
      if (e.id === 'signal') expect(body.status).toBe('suggested');
      if (e.id === 'orders') expect((body.data as unknown[]).length).toBe(1);
    });
  }

  it('the signature check works exactly as shown', async () => {
    // Run the snippet exactly as the page shows it, as its own ES module.
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'flowe-')), 'verify.mjs');
    writeFileSync(file, VERIFY_WEBHOOK_SNIPPET);
    const { verifyFloweSignature: verify } = (await import(pathToFileURL(file).href)) as {
      verifyFloweSignature: (secret: string, header: string, body: string, now?: number) => boolean;
    };
    const body = '{"event":"payment.approved"}';
    const header = sign('whsec_test', 1_793_180_000, body);
    expect(verify('whsec_test', header, body, 1_793_180_010)).toBe(true);
    expect(verify('whsec_test', header, `${body} `, 1_793_180_010)).toBe(false);
    expect(verify('whsec_other', header, body, 1_793_180_010)).toBe(false);
    expect(verify('whsec_test', header, body, 1_793_180_400)).toBe(false);
  });
});
