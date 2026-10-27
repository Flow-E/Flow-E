import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleMcp, newLimiter, type McpDeps } from '@/server/mcp-endpoint';
import { ALICE, DAVE, ORIGIN, outbox, request, world, type World } from './org-helpers';

const URL_ = new URL(`${ORIGIN}/api/mcp`);

let w: World;
let deps: McpDeps;

beforeEach(async () => {
  w = await world();
  deps = { store: w.store, limiter: newLimiter(() => w.clock.now), origin: ORIGIN };
});

afterEach(async () => {
  await w.close();
});

/** fetch, routed straight into the endpoint handler (no network). */
const fetchVia = (d: McpDeps) => (input: string | URL | Request, init?: RequestInit) =>
  handleMcp(new Request(input, init), d);

async function connect(key: string) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(URL_, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
    fetch: fetchVia(deps),
  });
  await client.connect(transport);
  return client;
}

type ToolText = { content: { type: string; text: string }[]; isError?: boolean };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as ToolText;
  const text = res.content[0]?.text ?? '';
  return {
    isError: res.isError === true,
    text,
    json: () => JSON.parse(text) as Record<string, unknown>,
  };
}

async function post(key: string | null, body: unknown, extra: Record<string, string> = {}) {
  return handleMcp(
    new Request(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...extra,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    deps,
  );
}

const ping = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

describe('remote MCP endpoint', () => {
  it('lists the same five tools as the stdio server', async () => {
    const client = await connect(w.agentKey);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_mandate',
      'get_payment',
      'list_payments',
      'record_order',
      'request_payment',
    ]);
    expect(client.getInstructions()).toContain('check_mandate');
    await client.close();
  });

  it('decides approved, declined and review, and records each in the signed ledger', async () => {
    const client = await connect(w.agentKey);
    const mandate = (await call(client, 'check_mandate')).json();
    expect(mandate.agent).toMatchObject({ id: 'buyer', status: 'active' });

    const approved = (await call(client, 'request_payment', request('120'))).json();
    expect(approved.decision).toBe('approved');
    const declined = (
      await call(client, 'request_payment', { ...request('10'), category: '7995' })
    ).json();
    expect(declined).toMatchObject({ decision: 'declined', rule: 'CATEGORY' });
    const review = (await call(client, 'request_payment', request('800'))).json();
    expect(review.decision).toBe('review');

    const v = await w.store.view(w.orgId, ALICE);
    expect(v.payments.map((p) => p.status)).toEqual(['review', 'declined', 'approved']);
    expect(v.audit.ok).toBe(true);
    expect(v.entries.filter((e) => e.type === 'payment.decision')).toHaveLength(3);
    expect((await outbox(w.db, 'approval')).length).toBe(2);

    const got = (await call(client, 'get_payment', { id: String(review.payment_id) })).json();
    expect(got.status).toBe('review');
    const list = (await call(client, 'list_payments', { limit: 2 })).json();
    expect((list.payments as unknown[]).length).toBe(2);
    expect((await call(client, 'request_payment', { ...request('1.234') })).text).toMatch(
      /^Invalid amount/,
    );
    await client.close();
  });

  it('applies a freeze and the kill switch to the very next request', async () => {
    const client = await connect(w.agentKey);
    await w.store.setFrozen(w.orgId, ALICE, 'buyer', true);
    expect((await call(client, 'request_payment', request('10'))).json()).toMatchObject({
      decision: 'declined',
    });
    await w.store.setFrozen(w.orgId, ALICE, 'buyer', false);
    await w.store.setKillSwitch(w.orgId, ALICE, true);
    expect((await call(client, 'request_payment', request('10'))).json()).toMatchObject({
      decision: 'declined',
      rule: 'KILL_SWITCH',
    });
    await client.close();
  });

  it('answers 401 with a JSON-RPC error for a missing, wrong, revoked or expired key', async () => {
    for (const key of [null, 'flowe_ak_wrong', `flowe_ak_${'A'.repeat(43)}`]) {
      const res = await post(key, ping);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
      expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 }, id: null });
    }
    const k = await w.store.createKey(w.orgId, ALICE, 'buyer', { expiresInDays: 1 });
    expect((await post(k.key, ping)).status).not.toBe(401);
    w.clock.now += 86_400_000 + 1;
    expect((await post(k.key, ping)).status).toBe(401);
    await w.store.revokeKey(w.orgId, ALICE, w.auth.keyId);
    expect((await post(w.agentKey, ping)).status).toBe(401);
    await expect(connect(w.agentKey)).rejects.toThrow();
  });

  it("keeps each agent to its own organisation's payments", async () => {
    const daveOrg = await w.store.createOrg(DAVE, {
      name: 'Dave Fictional GmbH',
      baseCurrency: 'EUR',
      timezone: 'UTC',
    });
    await w.store.createAgent(daveOrg, DAVE, {
      agentId: 'buyer',
      displayName: 'Dave buyer',
      owner: 'dave@example.com',
      dailyBudget: '1000',
      perPaymentLimit: '500',
      categories: ['5169'],
    });
    const daveKey = (await w.store.createKey(daveOrg, DAVE, 'buyer', { expiresInDays: null })).key;
    const alice = await connect(w.agentKey);
    const mine = (await call(alice, 'request_payment', request('120'))).json();
    const dave = await connect(daveKey);
    expect((await call(dave, 'get_payment', { id: String(mine.payment_id) })).isError).toBe(true);
    expect((await call(dave, 'list_payments')).json()).toEqual({ payments: [] });
    expect((await call(dave, 'check_mandate')).json()).toMatchObject({ base_currency: 'EUR' });
    await alice.close();
    await dave.close();
  });

  it('rate-limits each key, limits the body size and accepts POST only', async () => {
    for (let i = 0; i < 60; i++) expect((await post(w.agentKey, ping)).status).toBe(200);
    const limited = await post(w.agentKey, ping);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    w.clock.now += 60_001;
    expect((await post(w.agentKey, ping)).status).toBe(200);

    expect((await post(w.agentKey, 'x'.repeat(70_000))).status).toBe(413);
    expect((await post(w.agentKey, '{not json')).status).toBe(400);
    const get = await handleMcp(new Request(URL_, { method: 'GET' }), deps);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
  });
});
