import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgentAdd, runInit } from '../../src/cli/kya-commands.js';
import { loadIssuer, storePaths } from '../../src/kya/store.js';
import { newId } from '../../src/ledger/ledger.js';
import {
  cancelCoolingOff,
  resolvePayment,
  setAgentFrozen,
  setKillSwitch,
} from '../../src/control/actions.js';
import { createMandateServer, type MandateServer } from '../../src/mcp/server.js';
import { evaluate } from '../../src/engine/evaluate.js';
import { MINUTE, NOW, context, credential, mandate, request } from '../engine/fixtures.js';

const DAY = 86_400_000;
const OTHER_AGENT = `
  marketing-bot:
    owner: 'J. Doe, Marketing'
    daily_budget: 500
    per_payment_limit: 100
    currencies: [CHF]
    categories: ['7311']
`;

let dir: string;
let home: string;
let config: string;
let now: number;
let mandateServer: MandateServer;
let client: Client;

async function connect(): Promise<void> {
  mandateServer = createMandateServer({
    home,
    configPath: config,
    agentId: 'lab-procurement',
    clock: () => now,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mandateServer.server.connect(serverSide);
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientSide);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mandate-mcp-'));
  home = join(dir, '.imprest');
  config = join(dir, 'mandate.yaml');
  runInit({ home, config });
  writeFileSync(config, readFileSync(config, 'utf8') + OTHER_AGENT);
  for (const id of ['lab-procurement', 'marketing-bot']) {
    runAgentAdd({
      home,
      config,
      id,
      days: 90,
      scope: ['payments:request'],
      force: false,
      now: NOW - DAY,
    });
  }
  now = NOW;
  await connect();
});

afterEach(async () => {
  await client.close();
  mandateServer.close();
});

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content[0]?.text ?? '';
  return {
    isError: result.isError === true,
    text,
    json: () => JSON.parse(text) as Record<string, unknown>,
  };
}

const buy = (args: Record<string, unknown> = {}) =>
  call('request_payment', {
    merchant: 'Alpine Reagents AG',
    amount: '1200.00',
    currency: 'CHF',
    category: '5169',
    country: 'CH',
    memo: 'Buffer solution, 10 L',
    ...args,
  });

describe('tool surface', () => {
  it('exposes exactly the four agent tools, none that approve, change policy or unfreeze', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_mandate',
      'get_payment',
      'list_payments',
      'request_payment',
    ]);
    const request = tools.find((t) => t.name === 'request_payment');
    expect(request?.description).toMatch(/Never split a declined payment into smaller ones/);
    expect(request?.inputSchema.required?.sort()).toEqual([
      'amount',
      'category',
      'country',
      'currency',
      'merchant',
    ]);
    expect(tools.find((t) => t.name === 'check_mandate')?.annotations?.readOnlyHint).toBe(true);
  });

  it('gives the model instructions', () => {
    expect(client.getInstructions()).toMatch(/does not move money/);
  });
});

describe('check_mandate', () => {
  it('shows limits, allowed values and the remaining budget', async () => {
    const r = (await call('check_mandate')).json();
    expect(r).toMatchObject({
      agent: {
        id: 'lab-procurement',
        owner: 'M. Keller, Head of Lab',
        organisation: 'Example Labs AG (fictional)',
        status: 'active',
      },
      base_currency: 'CHF',
      today: { date: '2026-10-21', daily_budget: 'CHF 20000.00', remaining: 'CHF 20000.00' },
      limits: {
        per_payment: 'CHF 8000.00',
        human_approval_above: 'CHF 5000.00',
        business_hours: null,
      },
      allowed: {
        currencies: ['CHF', 'EUR'],
        fx_to_base: { EUR: '0.93' },
        suppliers: ['Alpine Reagents AG', 'Basel Labware AG'],
        blocked_countries: ['RU', 'BY', 'IR', 'KP'],
      },
    });
  });

  it('counts approved and pending spend', async () => {
    await buy();
    await buy({ merchant: 'Basel Labware AG', amount: '6000', category: '5047' });
    expect((await call('check_mandate')).json().today).toMatchObject({
      approved: 'CHF 1200.00',
      pending_review: 'CHF 6000.00',
      remaining: 'CHF 12800.00',
    });
  });
});

describe('request_payment', () => {
  it('approves, records the decision in the ledger and returns a receipt id', async () => {
    const r = await buy();
    expect(r.isError).toBe(false);
    const body = r.json();
    expect(body).toMatchObject({
      decision: 'approved',
      rule: null,
      amount: 'CHF 1200.00',
      amount_in_base_currency: 'CHF 1200.00',
      cancellable_until: '2026-10-21T10:10:00.000Z',
    });
    expect(body.reason).toMatch(/^All rules passed\./);
    expect(body.payment_id).toMatch(/^pay_[0-9a-f]{20}$/);
    const entry = mandateServer.ledger.find(body.receipt_id as string);
    expect(entry?.data).toMatchObject({ payment_id: body.payment_id, decision: 'approved' });
    expect(mandateServer.ledger.audit(loadIssuer(home).publicKey).ok).toBe(true);
  });

  it('accepts a numeric category code and pads it', async () => {
    expect((await buy({ category: 5169 })).json()).toMatchObject({ decision: 'approved' });
    await buy({ category: 742 });
    expect(mandateServer.ledger.payments('lab-procurement')[1]?.request.category).toBe('0742');
  });

  it('converts foreign currency and accepts a numeric amount', async () => {
    const body = (await buy({ amount: 100, currency: 'eur' })).json();
    expect(body).toMatchObject({ amount: 'EUR 100.00', amount_in_base_currency: 'CHF 93.00' });
  });

  it('declines, with the reason, and still records it', async () => {
    const body = (await buy({ country: 'ru' })).json();
    expect(body).toMatchObject({ decision: 'declined', rule: 'COUNTRY' });
    expect(body.next_step).toMatch(/do not retry it in a disguised form/);
    expect(body.next_step).toMatch(/different supplier that your mandate allows/);
    expect(mandateServer.ledger.payments('lab-procurement')).toHaveLength(1);
  });

  it('sends a large payment to review', async () => {
    const body = (await buy({ amount: '6000' })).json();
    expect(body).toMatchObject({ decision: 'review', rule: 'APPROVAL_THRESHOLD' });
    expect(body.next_step).toMatch(/A human must approve/);
  });

  it('catches a split payment across two calls', async () => {
    await buy({ amount: '4500' });
    now += 2 * MINUTE;
    const body = (await buy({ amount: '4000' })).json();
    expect(body).toMatchObject({ decision: 'declined', rule: 'SPLIT_DETECTION' });
  });

  it.each(['12.505', '1,200', '-5', 'twelve', ''])(
    'rejects amount %j before the engine, recording nothing',
    async (amount) => {
      const r = await buy({ amount });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Invalid amount/);
      expect(mandateServer.ledger.entries()).toHaveLength(0);
    },
  );

  it.each([
    ['category', 'lab'],
    ['category', 12345],
    ['category', 51.69],
    ['country', 'Switzerland'],
    ['currency', 'C'],
    ['merchant', ''],
  ])('rejects a malformed %s via the input schema', async (field, value) => {
    const r = await buy({ [field]: value });
    expect(r.isError).toBe(true);
    expect(mandateServer.ledger.entries()).toHaveLength(0);
  });

  it('applies an owner freeze in mandate.yaml immediately, without a restart', async () => {
    writeFileSync(config, readFileSync(config, 'utf8').replace('status: active', 'status: frozen'));
    const body = (await buy()).json();
    expect(body).toMatchObject({ decision: 'declined', rule: 'AGENT_STATUS' });
  });

  it('declines when the credential file is gone', async () => {
    unlinkSync(join(storePaths(home).credentials, 'lab-procurement.json'));
    const body = (await buy()).json();
    expect(body).toMatchObject({ decision: 'declined', rule: 'KYA_CREDENTIAL' });
  });

  it('declines once the credential has expired', async () => {
    now = NOW + 100 * DAY;
    expect((await buy()).json()).toMatchObject({ decision: 'declined', rule: 'KYA_CREDENTIAL' });
  });

  it('fails closed when the mandate file is broken', async () => {
    writeFileSync(config, 'agents: [');
    const r = await buy();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/NOT authorized; treat it as declined/);
    expect(mandateServer.ledger.entries()).toHaveLength(0);
  });

  it('never leaks keys or credential signatures', async () => {
    const outputs = [
      (await call('check_mandate')).text,
      (await buy()).text,
      (await call('list_payments')).text,
    ].join('\n');
    const cred = readFileSync(join(storePaths(home).credentials, 'lab-procurement.json'), 'utf8');
    const signature = (JSON.parse(cred) as { signature: string }).signature;
    expect(outputs).not.toContain(signature);
    expect(outputs).not.toMatch(/PRIVATE KEY|BEGIN/);
  });
});

describe('get_payment and list_payments', () => {
  it('returns a payment by payment id or receipt id', async () => {
    const made = (await buy({ amount: '6000' })).json();
    for (const id of [made.payment_id, made.receipt_id]) {
      expect((await call('get_payment', { id })).json()).toMatchObject({
        payment_id: made.payment_id,
        status: 'review',
        merchant: 'Alpine Reagents AG',
        amount: 'CHF 6000.00',
        memo: 'Buffer solution, 10 L',
      });
    }
  });

  it("cannot see another agent's payment", async () => {
    const theirs = mandateServer.ledger.appendDecision({
      agentId: 'marketing-bot',
      paymentId: newId('pay'),
      request: request(),
      result: evaluate(
        { id: 'lab-procurement', status: 'active', credential: credential() },
        mandate(),
        request(),
        context(),
      ),
      baseCurrency: 'CHF',
      now,
    });
    const r = await call('get_payment', { id: theirs.entry.data.payment_id as string });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/You have no payment/);
    expect((await call('list_payments')).json().payments).toHaveLength(0);
  });

  it('says so for an unknown id', async () => {
    expect((await call('get_payment', { id: 'pay_nope' })).isError).toBe(true);
  });

  it('lists newest first, up to the limit', async () => {
    await buy({ amount: '100' });
    now += MINUTE;
    await buy({ amount: '200', merchant: 'Basel Labware AG', category: '5047' });
    now += MINUTE;
    await buy({ amount: '300', country: 'RU' });
    const all = (await call('list_payments')).json().payments as {
      amount: string;
      status: string;
    }[];
    expect(all.map((p) => [p.amount, p.status])).toEqual([
      ['CHF 300.00', 'declined'],
      ['CHF 200.00', 'approved'],
      ['CHF 100.00', 'approved'],
    ]);
    expect((await call('list_payments', { limit: 1 })).json().payments).toHaveLength(1);
    expect((await call('list_payments', { limit: 0 })).isError).toBe(true);
  });

  it('still shows history when the mandate file is broken', async () => {
    await buy();
    writeFileSync(config, 'agents: [');
    expect((await call('list_payments')).json().payments).toHaveLength(1);
    expect((await call('check_mandate')).isError).toBe(true);
  });
});

describe('startup', () => {
  it('refuses to start without a credential', () => {
    unlinkSync(join(storePaths(home).credentials, 'lab-procurement.json'));
    expect(() =>
      createMandateServer({ home, configPath: config, agentId: 'lab-procurement' }),
    ).toThrow(/has no credential/);
  });

  it('refuses to start for an agent without a mandate', () => {
    expect(() => createMandateServer({ home, configPath: config, agentId: 'ghost' })).toThrow(
      /"ghost" is not in/,
    );
  });

  it('refuses to start without an issuer key', () => {
    expect(() =>
      createMandateServer({
        home: join(dir, 'empty'),
        configPath: config,
        agentId: 'lab-procurement',
      }),
    ).toThrow(/imprest init/);
  });
});

describe('human control, seen through the agent tools', () => {
  const human = () => ({ by: 'M. Keller', now });

  it('a payment in review becomes approved after a human acts, and get_payment shows it', async () => {
    const made = (await buy({ amount: '6000' })).json();
    now += 5 * MINUTE;
    resolvePayment(mandateServer.ledger, made.payment_id as string, 'approved', {
      ...human(),
      note: 'Quote checked',
    });
    expect((await call('get_payment', { id: made.payment_id })).json()).toMatchObject({
      status: 'approved',
      decided_by: 'M. Keller',
      decided_at: '2026-10-21T10:05:00.000Z',
      note_from_human: 'Quote checked',
      cancellable_until: '2026-10-21T10:15:00.000Z',
    });
  });

  it('a payment in review becomes declined after a human acts', async () => {
    const made = (await buy({ amount: '6000' })).json();
    resolvePayment(mandateServer.ledger, made.payment_id as string, 'declined', human());
    expect((await call('get_payment', { id: made.payment_id })).json().status).toBe('declined');
    expect((await call('check_mandate')).json().today).toMatchObject({
      pending_review: 'CHF 0.00',
    });
  });

  it('a cancelled payment shows as cancelled and no longer counts against the budget', async () => {
    const made = (await buy()).json();
    cancelCoolingOff(mandateServer.ledger, made.payment_id as string, human());
    expect((await call('get_payment', { id: made.payment_id })).json().status).toBe('cancelled');
    expect((await call('check_mandate')).json().today).toMatchObject({ approved: 'CHF 0.00' });
  });

  it('freezing the agent declines its next request; unfreezing restores it', async () => {
    setAgentFrozen(mandateServer.ledger, 'lab-procurement', true, human());
    expect((await call('check_mandate')).json().agent).toMatchObject({ status: 'frozen' });
    expect((await buy()).json()).toMatchObject({ decision: 'declined', rule: 'AGENT_STATUS' });
    setAgentFrozen(mandateServer.ledger, 'lab-procurement', false, human());
    expect((await buy()).json()).toMatchObject({ decision: 'approved' });
  });

  it('freezing another agent does not affect this one', async () => {
    setAgentFrozen(mandateServer.ledger, 'marketing-bot', true, human());
    expect((await buy()).json()).toMatchObject({ decision: 'approved' });
  });

  it('the kill switch declines every request until it is released', async () => {
    setKillSwitch(mandateServer.ledger, true, human());
    expect((await call('check_mandate')).json().agent).toMatchObject({
      status: 'blocked: the organisation kill switch is on',
    });
    expect((await buy()).json()).toMatchObject({ decision: 'declined', rule: 'KILL_SWITCH' });
    setKillSwitch(mandateServer.ledger, false, human());
    expect((await buy()).json()).toMatchObject({ decision: 'approved' });
  });

  it('the agent tools still cannot approve, freeze or unfreeze anything', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).join(' ');
    expect(names).not.toMatch(/approve|decline|freeze|kill|cancel|policy|resolve/);
    await expect(
      client.callTool({ name: 'approve_payment', arguments: { id: 'x' } }),
    ).resolves.toMatchObject({ isError: true });
  });
});
