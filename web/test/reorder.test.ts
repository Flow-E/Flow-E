import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionError } from '@flow-e/mcp/core';
import { ForbiddenError } from '@/server/permissions';
import { ReorderStore } from '@/server/reorder';
import {
  MAX_STEPS,
  claudeRun,
  isDue,
  mcpTools,
  type ModelCaller,
  type ReorderItem,
} from '@/server/reorder-agent';
import { ALICE, BOB, CAROL, DAVE, ORIGIN, request, world, type World } from './org-helpers';

const MINUTE = 60_000;

/** Usual prices for the fictional lab, and an approved-supplier list. */
async function setUp(w: World, edit?: (buyer: Record<string, unknown>) => void) {
  const view = await w.store.view(w.orgId, ALICE);
  const raw = structuredClone(view.raw) as Record<string, unknown> & {
    agents: Record<string, Record<string, unknown>>;
  };
  raw.reference_prices = [
    { item: 'Pipette tips', match: ['pipette tips'], price: '120', supplier: 'Example Labware AG' },
    { item: 'Glassware', match: ['glassware'], price: '300', supplier: 'Example Labware AG' },
    { item: 'Buffer', match: ['buffer'], price: '40' },
  ];
  const buyer = raw.agents.buyer;
  if (!buyer) throw new Error('no buyer');
  edit?.(buyer);
  await w.store.updateConfig(w.orgId, ALICE, raw);
}

async function decisions(w: World) {
  const view = await w.store.view(w.orgId, ALICE);
  return view.payments.map((p) => ({
    item: p.request.item,
    merchant: p.request.merchant,
    status: p.status,
  }));
}

describe('Run reorder, simulated (no API key)', () => {
  let w: World;
  let reorder: ReorderStore;
  beforeEach(async () => {
    w = await world();
    reorder = new ReorderStore(w.db, w.store, { clock: () => w.clock.now });
    await setUp(w);
  });
  afterEach(async () => {
    await w.close();
  });

  it('asks for each due item through the agent tools and logs what happened', async () => {
    await reorder.saveItems(w.orgId, ALICE, [
      { item: 'Pipette tips', quantity: '2' }, // CHF 240, approved
      { item: 'Glassware', quantity: '2', supplier: 'Example Labware AG' }, // CHF 600, to a person
      { item: 'Gloves', quantity: '1' }, // no usual price: skipped
      { item: 'Buffer', quantity: '3', stock: '10', minStock: '5' }, // stock is fine: not due
      { item: 'Buffer', quantity: '1' }, // usual price but no supplier: skipped
    ]);
    const run = await reorder.run(w.orgId, BOB, {
      agentId: 'buyer',
      origin: ORIGIN,
      callModel: null,
    });
    expect(run).toMatchObject({ mode: 'simulated', status: 'finished', agentId: 'buyer' });
    expect(run.tokens).toBe(0);
    expect(await decisions(w)).toEqual(
      expect.arrayContaining([
        { item: 'Pipette tips', merchant: 'Example Labware AG', status: 'approved' },
        { item: 'Glassware', merchant: 'Example Labware AG', status: 'review' },
      ]),
    );
    expect(await decisions(w)).toHaveLength(2);
    const text = run.log.map((l) => l.text).join('\n');
    expect(text).toMatch(/Simulated run/);
    expect(text).toMatch(/Pipette tips from Example Labware AG for CHF 240.00: approved/);
    expect(text).toMatch(/Glassware .*: sent to a person/);
    expect(text).toMatch(/Skipped Gloves: it has no usual price/);
    expect(text).toMatch(/Skipped Buffer: no supplier is set/);
    // The approved one gets an order (or is told to wait for the cooling-off period).
    expect(text).toMatch(/order/i);
    // The person waiting stays waiting: the agent cannot approve.
    const runs = await reorder.runs(w.orgId, CAROL);
    expect(runs[0]?.id).toBe(run.id);
  });

  it('follows a supplier hint once, and never splits', async () => {
    await setUp(w, (buyer) => {
      buyer.suppliers = { mode: 'allowlist', allow: ['Example Labware AG'] };
    });
    await reorder.saveItems(w.orgId, ALICE, [
      { item: 'Buffer', quantity: '1', supplier: 'Example Other AG' },
    ]);
    const run = await reorder.run(w.orgId, ALICE, {
      agentId: 'buyer',
      origin: ORIGIN,
      callModel: null,
    });
    const all = await decisions(w);
    expect(all).toHaveLength(2);
    expect(all).toEqual(
      expect.arrayContaining([
        { item: 'Buffer', merchant: 'Example Other AG', status: 'declined' },
        { item: 'Buffer', merchant: 'Example Labware AG', status: 'approved' },
      ]),
    );
    expect(run.log.map((l) => l.text)).toContain(
      "Followed Flow-E's hint: ask Example Labware AG, an approved supplier.",
    );
  });

  it('stops when the agent is frozen, and asks for nothing', async () => {
    await w.store.setFrozen(w.orgId, ALICE, 'buyer', true);
    await reorder.saveItems(w.orgId, ALICE, [{ item: 'Pipette tips', quantity: '1' }]);
    const run = await reorder.run(w.orgId, ALICE, {
      agentId: 'buyer',
      origin: ORIGIN,
      callModel: null,
    });
    expect(run.status).not.toBe('failed');
    expect((await decisions(w)).every((d) => d.status === 'declined')).toBe(true);
  });

  it('refuses a second run while one is going, an unknown agent and an empty list', async () => {
    await expect(
      reorder.run(w.orgId, ALICE, { agentId: 'buyer', origin: ORIGIN, callModel: null }),
    ).rejects.toThrow(/reorder list first/);
    await reorder.saveItems(w.orgId, ALICE, [{ item: 'Pipette tips', quantity: '1' }]);
    await expect(
      reorder.run(w.orgId, ALICE, { agentId: 'nobody', origin: ORIGIN, callModel: null }),
    ).rejects.toThrow(ActionError);
    await w.db.query(
      `insert into org_agent_runs (id, org_id, agent_id, mode, status, started_by, started_at)
       values (gen_random_uuid(), $1, 'buyer', 'simulated', 'running', 'x', $2::timestamptz)`,
      [w.orgId, new Date(w.clock.now - MINUTE).toISOString()],
    );
    await expect(
      reorder.run(w.orgId, ALICE, { agentId: 'buyer', origin: ORIGIN, callModel: null }),
    ).rejects.toThrow(/still going/);
    // Ten minutes later the stuck run no longer blocks, and shows as stopped.
    w.clock.now += 11 * MINUTE;
    expect((await reorder.runs(w.orgId, ALICE))[0]?.status).toBe('stopped');
    await expect(
      reorder.run(w.orgId, ALICE, { agentId: 'buyer', origin: ORIGIN, callModel: null }),
    ).resolves.toMatchObject({ status: 'finished' });
  });

  it('checks every line of the list and names the bad one', async () => {
    await expect(
      reorder.saveItems(w.orgId, ALICE, [
        { item: 'Tips', quantity: '1' },
        { item: 'Gloves', quantity: '0' },
      ]),
    ).rejects.toThrow(/^Line 2:/);
    for (const bad of [
      { item: '', quantity: '1' },
      { item: 'X', quantity: '1.5' },
      { item: 'X', quantity: '1', category: '51' },
      { item: 'X', quantity: '1', country: 'Switzerland' },
      { item: 'X', quantity: '1', stock: '-2' },
    ]) {
      await expect(reorder.saveItems(w.orgId, ALICE, [bad])).rejects.toThrow(ActionError);
    }
    await reorder.saveItems(w.orgId, ALICE, [
      { item: ' Tips ', quantity: '4', country: 'ch', category: '5169', stock: '', supplier: '' },
    ]);
    expect(await reorder.items(w.orgId, CAROL)).toEqual([
      {
        id: expect.any(String) as string,
        item: 'Tips',
        supplier: null,
        quantity: 4,
        stock: null,
        minStock: null,
        category: '5169',
        country: 'CH',
      },
    ]);
  });

  it('keeps each organisation to itself; viewers only read', async () => {
    await reorder.saveItems(w.orgId, ALICE, [{ item: 'Pipette tips', quantity: '1' }]);
    await expect(reorder.items(w.orgId, DAVE)).rejects.toThrow(ForbiddenError);
    await expect(reorder.runs(w.orgId, DAVE)).rejects.toThrow(ForbiddenError);
    await expect(reorder.saveItems(w.orgId, CAROL, [{ item: 'X', quantity: '1' }])).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      reorder.run(w.orgId, CAROL, { agentId: 'buyer', origin: ORIGIN, callModel: null }),
    ).rejects.toThrow(ForbiddenError);
    const daveOrg = await w.store.createOrg(DAVE, {
      name: 'Other Labs AG (fictional)',
      baseCurrency: 'CHF',
      timezone: 'Europe/Zurich',
    });
    expect(await reorder.items(daveOrg, DAVE)).toEqual([]);
    expect(await reorder.runs(daveOrg, DAVE)).toEqual([]);
  });
});

describe('the agent has no special access', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it('sees only the five agent tools; nothing approves, changes a mandate or unfreezes', async () => {
    const pending = await w.store.requestPayment(w.auth, request('800'), ORIGIN);
    await w.store.setFrozen(w.orgId, ALICE, 'buyer', true);
    await w.store.setFrozen(w.orgId, ALICE, 'buyer', false);
    const tools = await mcpTools(
      w.store,
      { orgId: w.orgId, agentId: 'buyer', keyId: 'run:t' },
      ORIGIN,
    );
    try {
      expect((await tools.list()).map((t) => t.name).sort()).toEqual([
        'check_mandate',
        'get_payment',
        'list_payments',
        'record_order',
        'request_payment',
      ]);
      for (const name of [
        'approve_payment',
        'resolve',
        'update_mandate',
        'unfreeze',
        'set_kill_switch',
      ]) {
        const r = await tools.call(name, { id: pending.payment_id }).catch((e: unknown) => ({
          ok: false,
          text: String(e),
        }));
        expect(r.ok).toBe(false);
      }
      // It cannot even read another agent's payment, let alone change it.
      expect((await tools.call('get_payment', { id: 'pay_00000000000000000000' })).ok).toBe(false);
    } finally {
      await tools.close();
    }
    const view = await w.store.view(w.orgId, ALICE);
    expect(view.payments.find((p) => p.paymentId === pending.payment_id)?.status).toBe('review');
  });
});

describe('Run reorder with Claude (model faked)', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    await setUp(w);
  });
  afterEach(async () => {
    await w.close();
  });

  const tips: ReorderItem = {
    item: 'Pipette tips',
    supplier: 'Example Labware AG',
    quantity: 2,
    stock: null,
    minStock: null,
    category: null,
    country: null,
  };
  const items: ReorderItem[] = [tips];
  const turn = (content: Record<string, unknown>[], stop = 'tool_use', tokens = 1000) => ({
    stop_reason: stop,
    content,
    usage: { input_tokens: tokens - 100, output_tokens: 100 },
  });
  const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
    type: 'tool_use',
    id,
    name,
    input,
  });

  async function withTools<T>(fn: (tools: Awaited<ReturnType<typeof mcpTools>>) => Promise<T>) {
    const tools = await mcpTools(
      w.store,
      { orgId: w.orgId, agentId: 'buyer', keyId: 'run:c' },
      ORIGIN,
    );
    try {
      return await fn(tools);
    } finally {
      await tools.close();
    }
  }

  it('runs the tool loop, logs each call and counts tokens', async () => {
    const bodies: Record<string, unknown>[] = [];
    const script = [
      turn([toolUse('t1', 'check_mandate', {})]),
      turn([
        { type: 'thinking', thinking: '', signature: 'sig' },
        toolUse('t2', 'request_payment', {
          merchant: 'Example Labware AG',
          amount: '240.00',
          currency: 'CHF',
          category: '5169',
          country: 'CH',
          item: 'Pipette tips',
          quantity: 2,
        }),
      ]),
      turn([{ type: 'text', text: 'Ordered pipette tips.' }], 'end_turn'),
    ];
    const model: ModelCaller = (body) => {
      bodies.push(structuredClone(body));
      return Promise.resolve(script.shift() ?? null);
    };
    const out = await withTools((tools) =>
      claudeRun({ tools, items, prices: [], callModel: model }),
    );
    expect(out).toMatchObject({ status: 'finished', steps: 2, tokens: 3000 });
    expect(out.log.map((l) => l.text)).toEqual([
      'Run by Claude (claude-opus-5-5).',
      'Read its mandate and budgets.',
      'Asked to buy Pipette tips from Example Labware AG for CHF 240.00: approved.',
      'Done.',
    ]);
    // Only the agent tools are offered, the thinking block goes back unchanged, and results
    // come back as tool_result blocks.
    expect((bodies[0]?.tools as { name: string }[]).map((t) => t.name).sort()).toEqual([
      'check_mandate',
      'get_payment',
      'list_payments',
      'record_order',
      'request_payment',
    ]);
    const last = bodies[2]?.messages as { role: string; content: unknown }[];
    expect(JSON.stringify(last)).toContain('"signature":"sig"');
    expect(last.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't2', is_error: false }],
    });
    expect(bodies[0]).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default' });
  });

  it('stops at the step cap and at the token cap', async () => {
    const forever: ModelCaller = () => Promise.resolve(turn([toolUse('t', 'check_mandate', {})]));
    const steps = await withTools((tools) =>
      claudeRun({ tools, items, prices: [], callModel: forever }),
    );
    expect(steps).toMatchObject({ status: 'stopped', steps: MAX_STEPS });
    const costly: ModelCaller = () =>
      Promise.resolve(turn([toolUse('t', 'check_mandate', {})], 'tool_use', 9_000));
    const tokens = await withTools((tools) =>
      claudeRun({ tools, items, prices: [], callModel: costly, maxTokens: 20_000 }),
    );
    expect(tokens).toMatchObject({ status: 'stopped', steps: 3, tokens: 27_000 });
  });

  it('ends as failed when the model does not answer, without throwing', async () => {
    const out = await withTools((tools) =>
      claudeRun({
        tools,
        items,
        prices: [],
        callModel: () => Promise.reject(new Error('network')),
      }),
    );
    expect(out.status).toBe('failed');
    expect((await w.store.view(w.orgId, ALICE)).payments).toHaveLength(0);
  });

  it('nothing is due when every stock is above its minimum', () => {
    expect(isDue({ ...tips, stock: 5, minStock: 5 })).toBe(false);
    expect(isDue({ ...tips, stock: 4, minStock: 5 })).toBe(true);
    expect(isDue({ ...tips, stock: 4, minStock: null })).toBe(true);
  });
});
