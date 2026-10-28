import { createPublicKey, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyReceipt, type Receipt } from '@flow-e/mcp/core';
import { newApiLimiter, withApiKey } from '@/server/api-auth';
import { ApiKeyStore, type ApiScope } from '@/server/api-keys';
import { getPayment, getReceipt, listOrders, postSignal, type V1Deps } from '@/server/api-v1';
import { gateExempt } from '@/server/gate';
import { ForbiddenError } from '@/server/permissions';
import { ReorderStore } from '@/server/reorder';
import { isBlockedAddress, safeLookup, webhookUrlProblem } from '@/server/safe-url';
import {
  RETRY_DELAYS_MS,
  WebhookStore,
  eventsFor,
  sign,
  verifySignature,
  type Sender,
} from '@/server/webhooks';
import { ALICE, BOB, CAROL, DAVE, ORIGIN, request, world, type World } from './org-helpers';

const MINUTE = 60_000;
const BASE = 'http://localhost:3150';

/** The same dispatch as the /api/v1 route files, without the Next.js runtime. */
function api(deps: V1Deps) {
  return async (
    method: 'GET' | 'POST',
    path: string,
    key: string | null,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const req = new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const url = new URL(req.url);
    let res: Response;
    if (path === '/api/v1/reorder-signals') {
      res = await withApiKey(req, deps, 'reorder:write', (c) => postSignal(req, c, deps));
    } else if (url.pathname === '/api/v1/orders') {
      res = await withApiKey(req, deps, 'read', async (c) =>
        listOrders(await deps.orgs.systemView(c.orgId), url),
      );
    } else {
      const [, , , kind, id = ''] = url.pathname.split('/');
      res = await withApiKey(req, deps, 'read', async (c) => {
        const data = await deps.orgs.systemView(c.orgId);
        return kind === 'payments' ? getPayment(data, id) : getReceipt(data, id);
      });
    }
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
}

/** A fictional price list: the agent "buyer" may buy pipette tips from Example Labware AG. */
async function priceList(w: World) {
  const view = await w.store.view(w.orgId, ALICE);
  await w.store.updateConfig(w.orgId, ALICE, {
    ...view.raw,
    reference_prices: [
      {
        item: 'Pipette tips, 20 racks',
        match: ['pipette tips'],
        price: '120',
        supplier: 'Example Labware AG',
      },
      { item: 'Nitrile gloves, 10 boxes', match: ['nitrile gloves'], price: '40' },
    ],
  });
}

describe('organisation API keys (D1)', () => {
  let w: World;
  let keys: ApiKeyStore;
  let call: ReturnType<typeof api>;
  beforeEach(async () => {
    w = await world();
    keys = new ApiKeyStore(w.db, w.store, { clock: () => w.clock.now });
    call = api({
      keys,
      orgs: w.store,
      reorder: new ReorderStore(w.db, w.store),
      limiter: newApiLimiter(),
    });
  });
  afterEach(async () => {
    await w.close();
  });

  const make = (scopes: ApiScope[], name = 'Inventory system') =>
    keys.create(w.orgId, ALICE, { name, scopes });

  it('shows the key once, stores only its hash, and logs calls without the key', async () => {
    const { key, id } = await make(['read']);
    expect(key).toMatch(/^flowe_ok_[A-Za-z0-9_-]{43}$/);
    expect((await call('GET', '/api/v1/orders', key)).status).toBe(200);
    const dump = JSON.stringify([
      await w.db.query('select * from org_api_keys'),
      await w.db.query('select * from org_api_access_log'),
    ]);
    expect(dump).not.toContain(key);
    expect(dump).not.toContain(key.slice(15));
    const [listed] = await keys.list(w.orgId, CAROL);
    expect(listed).toMatchObject({ id, name: 'Inventory system', scopes: ['read'] });
    expect(listed?.lastUsedAt).not.toBeNull();
    expect(await keys.accessLog(w.orgId, ALICE)).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/orders',
        status: 200,
        key_name: 'Inventory system',
      }),
    ]);
  });

  it('refuses a missing, malformed, revoked or out-of-scope key', async () => {
    const { key, id } = await make(['reorder:write']);
    expect((await call('GET', '/api/v1/orders', null)).status).toBe(401);
    expect((await call('GET', '/api/v1/orders', 'flowe_ok_nope')).status).toBe(401);
    expect((await call('GET', '/api/v1/orders', w.agentKey)).status).toBe(401); // agent keys are not API keys
    expect((await call('GET', '/api/v1/orders', key)).status).toBe(403);
    await keys.revoke(w.orgId, ALICE, id);
    expect(
      (
        await call('POST', '/api/v1/reorder-signals', key, {
          item: 'X',
          quantity: 1,
          idempotency_key: 'a',
        })
      ).status,
    ).toBe(401);
  });

  it('only owners create and revoke keys', async () => {
    for (const user of [BOB, CAROL, DAVE]) {
      await expect(keys.create(w.orgId, user, { name: 'x', scopes: ['read'] })).rejects.toThrow(
        ForbiddenError,
      );
    }
    await expect(keys.create(w.orgId, ALICE, { name: 'x', scopes: [] })).rejects.toThrow(
      /at least one/,
    );
    const { id } = await make(['read']);
    await expect(keys.revoke(w.orgId, BOB, id)).rejects.toThrow(ForbiddenError);
  });

  it('limits calls per key', async () => {
    const { key } = await make(['read']);
    let t = 0;
    const limited = api({
      keys,
      orgs: w.store,
      reorder: new ReorderStore(w.db, w.store),
      limiter: newApiLimiter(() => t),
    });
    for (let i = 0; i < 60; i++)
      expect((await limited('GET', '/api/v1/orders', key)).status).toBe(200);
    expect((await limited('GET', '/api/v1/orders', key)).status).toBe(429);
    t += 61_000;
    expect((await limited('GET', '/api/v1/orders', key)).status).toBe(200);
  });

  it('needs no site password, but only for /api/v1 and the cron path', () => {
    expect(gateExempt('/api/v1/orders', 'GET', false)).toBe(true);
    expect(gateExempt('/api/v1/reorder-signals', 'POST', false)).toBe(true);
    expect(gateExempt('/api/v1/orders', 'POST', true)).toBe(false);
    expect(gateExempt('/api/cron/webhooks', 'GET', false)).toBe(true);
    expect(gateExempt('/api/cron/webhooks', 'POST', false)).toBe(false);
    expect(gateExempt('/api/v1x', 'GET', false)).toBe(false);
  });
});

describe('reorder signals (D2)', () => {
  let w: World;
  let keys: ApiKeyStore;
  let reorder: ReorderStore;
  let call: ReturnType<typeof api>;
  let key: string;
  beforeEach(async () => {
    w = await world();
    await priceList(w);
    keys = new ApiKeyStore(w.db, w.store, { clock: () => w.clock.now });
    reorder = new ReorderStore(w.db, w.store, { clock: () => w.clock.now });
    call = api({ keys, orgs: w.store, reorder, limiter: newApiLimiter() });
    key = (
      await keys.create(w.orgId, ALICE, { name: 'Inventory system', scopes: ['reorder:write'] })
    ).key;
  });
  afterEach(async () => {
    await w.close();
  });

  const signal = {
    item_id: 'pipette-tips-20-racks--example-labware-ag',
    quantity: 3,
    unit: 'pack',
    reason: 'stock below minimum: 2 left',
    needed_by: '2026-11-15',
    idempotency_key: 'inv-4711',
  };

  it('adds a suggestion "suggested by" the key, matched by price-list id; nothing is bought', async () => {
    const r = await call('POST', '/api/v1/reorder-signals', key, signal);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'suggested',
      item: 'Pipette tips, 20 racks',
      supplier: 'Example Labware AG',
      price_item: 'pipette-tips-20-racks--example-labware-ag',
    });
    expect(await reorder.suggestions(w.orgId, CAROL)).toEqual([
      expect.objectContaining({
        source: 'Inventory system',
        status: 'suggested',
        quantity: 3,
        reason: 'stock below minimum: 2 left',
        neededBy: '2026-11-15',
      }),
    ]);
    expect(await reorder.items(w.orgId, ALICE)).toEqual([]);
    expect((await w.store.view(w.orgId, ALICE)).payments).toHaveLength(0);
  });

  it('the same idempotency key gives the same answer and adds nothing; a different body is refused', async () => {
    const first = await call('POST', '/api/v1/reorder-signals', key, signal);
    const again = await call('POST', '/api/v1/reorder-signals', key, signal);
    expect(again).toEqual({ status: 200, body: first.body });
    expect(await reorder.suggestions(w.orgId, ALICE)).toHaveLength(1);
    expect(
      (await call('POST', '/api/v1/reorder-signals', key, { ...signal, quantity: 9 })).status,
    ).toBe(409);
    // The header works as the key too.
    const noKey = Object.fromEntries(
      Object.entries(signal).filter(([k]) => k !== 'idempotency_key'),
    );
    const viaHeader = await call('POST', '/api/v1/reorder-signals', key, noKey, {
      'idempotency-key': 'inv-4711',
    });
    expect(viaHeader).toEqual({ status: 200, body: first.body });
  });

  it('keeps an unknown item as "needs matching", never guessed; a person links it', async () => {
    const r = await call('POST', '/api/v1/reorder-signals', key, {
      item: 'Pipette tips', // not the exact name in the price list
      quantity: 1,
      idempotency_key: 'x-1',
    });
    expect(r.body).toMatchObject({ status: 'needs_matching', price_item: null });
    const [s] = await reorder.suggestions(w.orgId, ALICE);
    if (!s) throw new Error('no suggestion');
    await expect(reorder.decideSuggestion(w.orgId, ALICE, s.id, 'accept')).rejects.toThrow(
      /Link it/,
    );
    await reorder.linkSuggestion(w.orgId, BOB, s.id, 'nitrile-gloves-10-boxes');
    await reorder.decideSuggestion(w.orgId, BOB, s.id, 'accept');
    expect((await reorder.items(w.orgId, ALICE)).map((i) => i.item)).toEqual([
      'Nitrile gloves, 10 boxes',
    ]);
    // Matched by exact name and supplier.
    const named = await call('POST', '/api/v1/reorder-signals', key, {
      item: 'pipette tips, 20 racks',
      supplier: 'Example Labware AG',
      quantity: 1,
      idempotency_key: 'x-2',
    });
    expect(named.body).toMatchObject({ status: 'suggested' });
  });

  it('turns away invalid signals with the problems listed', async () => {
    for (const bad of [
      { quantity: 1, idempotency_key: 'a' }, // no item
      { item: 'X', quantity: 0, idempotency_key: 'a' },
      { item: 'X', quantity: 1.5, idempotency_key: 'a' },
      { item: 'X', quantity: 1 }, // no idempotency key
      { item: 'X', quantity: 1, idempotency_key: 'a', needed_by: '15.11.2026' },
      { item: 'X', quantity: 1, idempotency_key: 'a', approve: true }, // unknown field
    ]) {
      const r = await call('POST', '/api/v1/reorder-signals', key, bad);
      expect(r.status).toBe(400);
      expect(r.body.problems).toBeDefined();
    }
    expect((await call('POST', '/api/v1/reorder-signals', key, 'not json')).status).toBe(400);
    expect(
      (await call('POST', '/api/v1/reorder-signals', key, { pad: 'x'.repeat(20_000) })).status,
    ).toBe(413);
    expect(await reorder.suggestions(w.orgId, ALICE)).toHaveLength(0);
  });

  it('a person can dismiss a suggestion; viewers cannot', async () => {
    await call('POST', '/api/v1/reorder-signals', key, signal);
    const [s] = await reorder.suggestions(w.orgId, ALICE);
    if (!s) throw new Error('no suggestion');
    await expect(reorder.decideSuggestion(w.orgId, CAROL, s.id, 'dismiss')).rejects.toThrow(
      ForbiddenError,
    );
    await reorder.decideSuggestion(w.orgId, BOB, s.id, 'dismiss');
    expect(await reorder.suggestions(w.orgId, ALICE)).toHaveLength(0);
  });

  it('end to end: signal → Run reorder (simulated, auto-include on) → engine decision → order', async () => {
    // An earlier payment to the supplier, so the new one is not in its cooling-off period.
    await w.store.requestPayment(w.auth, request('100', 'Example Labware AG'), ORIGIN);
    w.clock.now += 11 * MINUTE;
    await call('POST', '/api/v1/reorder-signals', key, signal);
    await expect(
      reorder.run(w.orgId, ALICE, { agentId: 'buyer', origin: ORIGIN, callModel: null }),
    ).rejects.toThrow(/reorder list first/); // off by default: suggestions are not run
    await reorder.setAutoInclude(w.orgId, ALICE, true);
    const run = await reorder.run(w.orgId, ALICE, {
      agentId: 'buyer',
      origin: ORIGIN,
      callModel: null,
    });
    expect(run.log.map((l) => l.text).join('\n')).toMatch(
      /Pipette tips, 20 racks from Example Labware AG for CHF 360.00: approved/,
    );
    const view = await w.store.view(w.orgId, ALICE);
    const paid = view.payments.find((p) => p.request.item === 'Pipette tips, 20 racks');
    expect(paid?.status).toBe('approved');
    expect(paid?.fulfilment?.ordered).not.toBeNull();
    // Used once: it is no longer a suggestion and does not run again.
    expect(await reorder.suggestions(w.orgId, ALICE)).toHaveLength(0);
  });
});

describe('webhooks (D3)', () => {
  let w: World;
  let hooks: WebhookStore;
  let sent: { url: string; body: string; headers: Record<string, string> }[];
  let answer: number | Error;
  const sender: Sender = (url, body, headers) => {
    sent.push({ url, body, headers });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ status: answer });
  };
  beforeEach(async () => {
    w = await world();
    sent = [];
    answer = 200;
    hooks = new WebhookStore(w.db, w.store, randomBytes(32), { clock: () => w.clock.now, sender });
  });
  afterEach(async () => {
    await w.close();
  });

  it('signs each delivery so the receiver can verify it, and refuses old or altered ones', async () => {
    const { secret } = await hooks.create(w.orgId, ALICE, {
      url: 'https://erp.example.com/flow-e',
      events: ['payment.approved'],
    });
    const p = await w.store.requestPayment(w.auth, request('100'), ORIGIN);
    expect(await hooks.enqueue()).toBe(1);
    await hooks.deliverDue();
    const [d] = sent;
    if (!d) throw new Error('nothing sent');
    const nowS = Math.floor(w.clock.now / 1000);
    expect(verifySignature(secret, d.headers['flow-e-signature'] ?? '', d.body, nowS)).toBe(true);
    expect(
      verifySignature(
        secret,
        d.headers['flow-e-signature'] ?? '',
        d.body.replace('100', '900'),
        nowS,
      ),
    ).toBe(false);
    expect(verifySignature(secret, d.headers['flow-e-signature'] ?? '', d.body, nowS + 600)).toBe(
      false,
    );
    expect(verifySignature('whsec_wrong', d.headers['flow-e-signature'] ?? '', d.body, nowS)).toBe(
      false,
    );
    const body = JSON.parse(d.body) as {
      event: string;
      entry: { data: { payment_id: string } };
      receipt: Receipt;
    };
    expect(body.event).toBe('payment.approved');
    expect(body.entry.data.payment_id).toBe(p.payment_id);
    const view = await w.store.view(w.orgId, ALICE);
    expect(verifyReceipt(body.receipt, createPublicKey(view.publicKeyPem)).valid).toBe(true);
    // No keys or secrets in the payload.
    expect(d.body).not.toMatch(/PRIVATE KEY|whsec_|flowe_ak_/);
  });

  it('retries with backoff, then marks the delivery failed; a person can resend', async () => {
    await hooks.create(w.orgId, ALICE, {
      url: 'https://erp.example.com/x',
      events: ['payment.review'],
    });
    await w.store.requestPayment(w.auth, request('800'), ORIGIN);
    await hooks.enqueue();
    answer = 500;
    await hooks.deliverDue();
    for (const delay of RETRY_DELAYS_MS) {
      w.clock.now += delay - 1;
      expect(await hooks.deliverDue()).toBe(0); // not due yet
      w.clock.now += 1;
      expect(await hooks.deliverDue()).toBe(1);
    }
    const [d] = await hooks.deliveries(w.orgId, CAROL);
    expect(d).toMatchObject({
      status: 'failed',
      attempts: RETRY_DELAYS_MS.length + 1,
      lastStatus: 500,
    });
    answer = 204;
    await expect(hooks.resend(w.orgId, BOB, d?.id ?? '')).rejects.toThrow(ForbiddenError);
    expect(await hooks.resend(w.orgId, ALICE, d?.id ?? '')).toBe('delivered');
  });

  it('a failing webhook never changes, blocks or delays a decision', async () => {
    await hooks.create(w.orgId, ALICE, {
      url: 'https://erp.example.com/x',
      events: ['payment.approved', 'payment.declined'],
    });
    answer = new Error('connection refused');
    const p = await w.store.requestPayment(w.auth, request('100'), ORIGIN);
    expect(p.decision).toBe('approved');
    await hooks.enqueue();
    await hooks.deliverDue();
    const view = await w.store.view(w.orgId, ALICE);
    expect(view.payments[0]?.status).toBe('approved');
    expect(view.audit.ok).toBe(true);
    expect((await hooks.deliveries(w.orgId, ALICE))[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
  });

  it('only sends the chosen events, only once, and only what happened after it was added', async () => {
    await w.store.requestPayment(w.auth, request('100'), ORIGIN); // before: not sent
    await hooks.create(w.orgId, ALICE, {
      url: 'https://erp.example.com/x',
      events: ['payment.review'],
    });
    await w.store.requestPayment(w.auth, request('100'), ORIGIN); // approved: not chosen
    await w.store.requestPayment(w.auth, request('800'), ORIGIN); // review
    expect(await hooks.enqueue()).toBe(1);
    expect(await hooks.enqueue()).toBe(0);
    expect(eventsFor({ type: 'payment.resolved', data: '{"status":"approved"}' })).toEqual([
      'payment.approved',
    ]);
    expect(eventsFor({ type: 'payment.ordered', data: '{}' })).toEqual(['order.recorded']);
    expect(eventsFor({ type: 'invoice.recorded', data: '{"match":"mismatch"}' })).toEqual([
      'invoice.mismatch',
    ]);
    expect(eventsFor({ type: 'config.updated', data: '{}' })).toEqual([]);
  });

  it('refuses internal addresses when saved and when resolved; only owners manage webhooks', async () => {
    for (const url of [
      'http://erp.example.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
      'https://intranet/x',
      'https://erp.example.com:8443/x',
      'https://user:pw@erp.example.com/x',
    ]) {
      await expect(
        hooks.create(w.orgId, ALICE, { url, events: ['payment.approved'] }),
      ).rejects.toThrow();
    }
    expect(webhookUrlProblem('https://erp.example.com/x')).toBeNull();
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.20.1.1',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    const err = await new Promise<unknown>((resolve) => {
      safeLookup('localhost', {}, (e) => {
        resolve(e);
      });
    });
    expect(String(err)).toMatch(/private or internal/);
    await expect(
      hooks.create(w.orgId, BOB, {
        url: 'https://erp.example.com/x',
        events: ['payment.approved'],
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('sends a test event at once and shows it in the delivery log', async () => {
    const { id, secret } = await hooks.create(w.orgId, ALICE, {
      url: 'https://erp.example.com/x',
      events: ['order.recorded'],
    });
    expect(await hooks.sendTest(w.orgId, ALICE, id)).toBe('delivered');
    expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({ event: 'test' });
    expect(sign(secret, 1, 'a')).toMatch(/^t=1,v1=[0-9a-f]{64}$/);
    await hooks.disable(w.orgId, ALICE, id);
    await expect(hooks.sendTest(w.orgId, ALICE, id)).rejects.toThrow(/No such webhook/);
  });
});

describe('read API (D4)', () => {
  let w: World;
  let keys: ApiKeyStore;
  let call: ReturnType<typeof api>;
  let key: string;
  let ids: string[];
  beforeEach(async () => {
    w = await world();
    keys = new ApiKeyStore(w.db, w.store, { clock: () => w.clock.now });
    call = api({
      keys,
      orgs: w.store,
      reorder: new ReorderStore(w.db, w.store),
      limiter: newApiLimiter(),
    });
    key = (await keys.create(w.orgId, ALICE, { name: 'Accounting', scopes: ['read'] })).key;
    ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        (await w.store.requestPayment(w.auth, request('100', 'Example Labware AG'), ORIGIN))
          .payment_id,
      );
      w.clock.now += MINUTE;
    }
    w.clock.now += 11 * MINUTE;
    for (const [i, id] of ids.entries()) {
      await w.store.agentRecordOrder(w.auth, id, `PO-${String(i)}`);
      w.clock.now += MINUTE;
    }
  });
  afterEach(async () => {
    await w.close();
  });

  it('lists orders newest first, a page at a time', async () => {
    const first = await call('GET', '/api/v1/orders?limit=2', key);
    const data = first.body.data as { payment_id: string; ordered: { reference: string } }[];
    expect(data.map((o) => o.payment_id)).toEqual([ids[2], ids[1]]);
    expect(data[0]?.ordered.reference).toBe('PO-2');
    const next = await call(
      'GET',
      `/api/v1/orders?limit=2&cursor=${String(first.body.next_cursor)}`,
      key,
    );
    expect((next.body.data as { payment_id: string }[]).map((o) => o.payment_id)).toEqual([ids[0]]);
    expect(next.body.next_cursor).toBeNull();
    expect((await call('GET', '/api/v1/orders?limit=500', key)).status).toBe(400);
  });

  it('returns a payment and its signed receipt', async () => {
    const p = await call('GET', `/api/v1/payments/${ids[0] ?? ''}`, key);
    expect(p.body).toMatchObject({
      payment_id: ids[0],
      status: 'approved',
      amount: '100.00',
      currency: 'CHF',
    });
    const r = await call('GET', `/api/v1/receipts/${ids[0] ?? ''}`, key);
    const view = await w.store.view(w.orgId, ALICE);
    expect(
      verifyReceipt(r.body as unknown as Receipt, createPublicKey(view.publicKeyPem)).valid,
    ).toBe(true);
    expect((await call('GET', '/api/v1/payments/pay_nothing', key)).status).toBe(404);
    expect((await call('GET', '/api/v1/payments/..%2Fetc', key)).status).toBe(404);
  });

  it("never shows another organisation's data", async () => {
    const other = await w.store.createOrg(DAVE, {
      name: 'Other Labs AG (fictional)',
      baseCurrency: 'CHF',
      timezone: 'Europe/Zurich',
    });
    const otherKey = (await keys.create(other, DAVE, { name: 'Theirs', scopes: ['read'] })).key;
    expect((await call('GET', `/api/v1/payments/${ids[0] ?? ''}`, otherKey)).status).toBe(404);
    expect((await call('GET', `/api/v1/receipts/${ids[0] ?? ''}`, otherKey)).status).toBe(404);
    expect((await call('GET', '/api/v1/orders', otherKey)).body.data).toEqual([]);
    await expect(keys.revoke(other, ALICE, 'x')).rejects.toThrow(ForbiddenError);
  });
});
