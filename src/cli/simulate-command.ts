import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CATALOG, DEMO_AGENT, DEMO_STORY_STEPS, type CatalogItem } from '../demo/content.js';
import { DEMO_MARKER, DemoError } from '../demo/setup.js';
import type { CommandResult } from './ledger-commands.js';

/**
 * `flow-e simulate`: a stand-in agent for the demo, so the dashboard fills up without Claude.
 * It talks to Flow-E over MCP stdio exactly as Claude does, and only ever in a folder made by
 * `flow-e demo`, so fake requests can never land in a real ledger.
 */

export const SIMULATE_ACTIONS = ['story', 'buy', 'list', 'status', 'mandate'] as const;

export interface SimulateOptions {
  dir: string;
  action: string;
  arg?: string | undefined;
  /** This CLI's entry file and the Node binary, to start `serve` the way an MCP client would. */
  cliPath: string;
  nodePath: string;
}

type Json = Record<string, unknown>;

export function catalogList(): string {
  return CATALOG.map(
    (c, i) => `${String(i + 1)}. ${c.item} from ${c.supplier}: ${c.currency} ${c.price}`,
  ).join('\n');
}

function demoFolder(dir: string): string {
  const abs = resolve(dir);
  if (!existsSync(join(abs, DEMO_MARKER))) {
    throw new DemoError(`${abs} is not a demo folder made by "flow-e demo".`);
  }
  return abs;
}

function itemNumber(arg: string | undefined): number {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > CATALOG.length) {
    throw new DemoError(
      `${catalogList()}\nPick an item number from 1 to ${String(CATALOG.length)}, e.g. "simulate buy 6".`,
    );
  }
  return n;
}

export async function runSimulate(o: SimulateOptions): Promise<CommandResult> {
  const action = o.action;
  if (!(SIMULATE_ACTIONS as readonly string[]).includes(action)) {
    throw new DemoError(
      `Unknown action "${action}". Use one of: story, buy <1-${String(CATALOG.length)}>, list, status <payment-id>, mandate.`,
    );
  }
  const dir = demoFolder(o.dir);
  if (action === 'list') return { ok: true, text: catalogList() };
  // Validate arguments before starting a server.
  const buyItem = action === 'buy' ? itemNumber(o.arg) : null;
  if (action === 'status' && !o.arg) {
    throw new DemoError('Say which payment: "simulate status <payment-id>".');
  }

  const client = new Client({ name: 'flow-e-simulate', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: o.nodePath,
      args: [o.cliPath, 'serve', '--agent', DEMO_AGENT],
      env: {
        FLOWE_HOME: join(dir, '.flow-e'),
        FLOWE_CONFIG: join(dir, 'mandate.yaml'),
      },
      stderr: 'ignore',
    }),
  );
  const call = async (name: string, args: Json = {}): Promise<Json> => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    const text = result.content[0]?.text ?? '';
    if (result.isError === true) throw new DemoError(text);
    return JSON.parse(text) as Json;
  };
  const buy = async (item: CatalogItem, amount?: string): Promise<string> => {
    const r = await call('request_payment', {
      merchant: item.supplier,
      amount: amount ?? item.price,
      currency: item.currency,
      category: item.category,
      country: item.country,
      memo: item.item,
    });
    const label = amount ? `${item.item}, split part: ${item.currency} ${amount}` : item.item;
    return (
      `${String(r.decision).toUpperCase().padEnd(9)}${label}  ${String(r.amount)}  ${String(r.payment_id)}\n` +
      `         ${String(r.reason)}`
    );
  };

  try {
    if (action === 'story') {
      const lines = [
        "Fake agent buying this week's lab supplies (fictional data; no money moves).",
        '',
      ];
      for (const step of DEMO_STORY_STEPS) {
        lines.push(await buy(CATALOG[step.item - 1] as CatalogItem, step.amount));
      }
      lines.push('', 'Open the control panel: the centrifuge is waiting for your approval.');
      return { ok: true, text: lines.join('\n') };
    }
    if (buyItem !== null) {
      return { ok: true, text: await buy(CATALOG[buyItem - 1] as CatalogItem) };
    }
    if (action === 'status')
      return { ok: true, text: formatPayment(await call('get_payment', { id: o.arg })) };
    return { ok: true, text: formatMandate(await call('check_mandate')) };
  } finally {
    await client.close();
  }
}

/** The fields of get_payment that the summary shows (see src/mcp/server.ts). */
interface PaymentView {
  payment_id: string;
  status: string;
  reason: string;
  merchant: string;
  amount: string;
  memo: string | null;
  decided_by: string;
  note_from_human: string | null;
  cancellable_until: string | null;
}

/** The fields of check_mandate that the summary shows. */
interface MandateView {
  agent: { id: string; status: string; owner: string };
  today: {
    date: string;
    daily_budget: string;
    approved: string;
    pending_review: string;
    remaining: string;
  };
  limits: { per_payment: string; human_approval_above: string | null };
  allowed: { currencies: string[]; categories: string[]; suppliers: string[] | string };
}

function formatPayment(json: Json): string {
  const p = json as unknown as PaymentView;
  const by = p.decided_by === 'engine' ? 'decided by the rules' : `decided by ${p.decided_by}`;
  const lines = [
    `${p.payment_id}: ${p.status} (${by})`,
    `  ${p.amount} to ${p.merchant}${p.memo ? `: ${p.memo}` : ''}`,
    `  ${p.reason}`,
  ];
  if (p.note_from_human) lines.push(`  note: ${p.note_from_human}`);
  if (p.cancellable_until) lines.push(`  cancellable until ${p.cancellable_until}`);
  return lines.join('\n');
}

function formatMandate(json: Json): string {
  const { agent, today, limits, allowed } = json as unknown as MandateView;
  const suppliers = Array.isArray(allowed.suppliers)
    ? allowed.suppliers.join(', ')
    : allowed.suppliers;
  return [
    `Agent ${agent.id} (${agent.status}), owner ${agent.owner}`,
    `  today ${today.date}: budget ${today.daily_budget}, approved ${today.approved}, ` +
      `pending review ${today.pending_review}, remaining ${today.remaining}`,
    `  per payment up to ${limits.per_payment}; human approval above ` +
      (limits.human_approval_above ?? 'never'),
    `  suppliers: ${suppliers}`,
    `  currencies: ${allowed.currencies.join(', ')}; categories: ${allowed.categories.join(', ')}`,
  ].join('\n');
}
