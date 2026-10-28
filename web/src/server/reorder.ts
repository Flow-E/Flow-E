import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActionError } from '@flow-e/mcp/core';
import type { Db } from './db';
import type { OrgStore, User } from './org-store';
import { assertCan } from './permissions';
import {
  claudeRun,
  mcpTools,
  simulatedRun,
  type LogLine,
  type ModelCaller,
  type ReorderItem,
  type RunOutcome,
} from './reorder-agent';

/**
 * The reorder list and the runs of the built-in agent, per organisation. Every query is scoped
 * by org_id, and every method checks the person's role in that organisation first.
 */

export const MAX_ITEMS = 50;
/** A run that has not finished after this long is shown as stopped and no longer blocks a new one. */
const STALE_RUN_MS = 10 * 60_000;

const iso = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Empty, missing or null means "not set". */
const optionalCount = z
  .union([z.literal(''), z.null(), z.coerce.number().int().min(0).max(100_000_000)])
  .optional()
  .transform((v) => (v === '' || v === null || v === undefined ? null : v));
const optionalText = (schema: z.ZodString) =>
  z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((v) => (v ? v : null))
    .pipe(schema.nullable());

export const itemSchema = z.object({
  item: z.string().trim().min(1, 'Name the item.').max(200),
  supplier: optionalText(z.string().max(200)),
  quantity: z.coerce.number().int('Quantity is a whole number.').min(1).max(100_000),
  stock: optionalCount,
  minStock: optionalCount,
  category: optionalText(z.string().regex(/^\d{4}$/, 'A category is a four-digit code.')),
  country: optionalText(
    z.string().regex(/^[A-Za-z]{2}$/, 'A country is a two-letter code such as CH.'),
  ).transform((v) => v?.toUpperCase() ?? null),
});
export type ItemInput = z.input<typeof itemSchema>;

export interface RunRecord {
  id: string;
  agentId: string;
  mode: 'claude' | 'simulated';
  status: 'running' | 'finished' | 'stopped' | 'failed';
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  steps: number;
  tokens: number;
  log: LogLine[];
}

interface RunRow {
  id: string;
  agent_id: string;
  mode: RunRecord['mode'];
  status: RunRecord['status'];
  started_by: string;
  started_at: string;
  finished_at: string | null;
  steps: number;
  tokens: number;
  log: LogLine[] | string;
}

const RUN_COLUMNS = `id, agent_id, mode, status, started_by, ${iso('started_at')} as started_at,
  ${iso('finished_at')} as finished_at, steps, tokens, log`;

export class ReorderStore {
  private readonly clock: () => number;

  constructor(
    private readonly db: Db,
    private readonly orgs: OrgStore,
    opts: { clock?: () => number } = {},
  ) {
    this.clock = opts.clock ?? Date.now;
  }

  async items(orgId: string, user: User): Promise<ReorderItem[]> {
    assertCan(await this.orgs.role(orgId, user), 'org.read');
    return this.itemsOf(orgId);
  }

  private async itemsOf(orgId: string): Promise<ReorderItem[]> {
    const rows = await this.db.query<{
      item: string;
      supplier: string | null;
      quantity: number;
      stock: number | null;
      min_stock: number | null;
      category: string | null;
      country: string | null;
    }>(
      `select item, supplier, quantity, stock, min_stock, category, country
         from org_reorder_items where org_id = $1 order by position`,
      [orgId],
    );
    return rows.map((r) => ({
      item: r.item,
      supplier: r.supplier,
      quantity: r.quantity,
      stock: r.stock,
      minStock: r.min_stock,
      category: r.category,
      country: r.country,
    }));
  }

  /** Replace the whole list. Every row is checked; a bad row names its line and saves nothing. */
  async saveItems(orgId: string, user: User, input: readonly ItemInput[]): Promise<void> {
    assertCan(await this.orgs.role(orgId, user), 'reorder.manage');
    if (input.length > MAX_ITEMS) {
      throw new ActionError(`A reorder list has at most ${String(MAX_ITEMS)} items.`);
    }
    const items = input.map((row, i) => {
      const r = itemSchema.safeParse(row);
      if (!r.success) {
        throw new ActionError(
          `Line ${String(i + 1)}: ${r.error.issues[0]?.message ?? 'not valid'}`,
        );
      }
      return r.data;
    });
    const now = new Date(this.clock()).toISOString();
    await this.db.transaction(async (tx) => {
      await tx.query('delete from org_reorder_items where org_id = $1', [orgId]);
      for (const [i, it] of items.entries()) {
        await tx.query(
          `insert into org_reorder_items
             (id, org_id, position, item, supplier, quantity, stock, min_stock, category, country, updated_by, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)`,
          [
            randomUUID(),
            orgId,
            i,
            it.item,
            it.supplier,
            it.quantity,
            it.stock,
            it.minStock,
            it.category,
            it.country,
            user.email.trim().toLowerCase().slice(0, 100),
            now,
          ],
        );
      }
    });
  }

  async runs(orgId: string, user: User, limit = 20): Promise<RunRecord[]> {
    assertCan(await this.orgs.role(orgId, user), 'org.read');
    const rows = await this.db.query<RunRow>(
      `select ${RUN_COLUMNS} from org_agent_runs where org_id = $1
        order by started_at desc limit $2`,
      [orgId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((r) => this.record(r));
  }

  private record(r: RunRow): RunRecord {
    const stale = r.status === 'running' && this.clock() - Date.parse(r.started_at) > STALE_RUN_MS;
    return {
      id: r.id,
      agentId: r.agent_id,
      mode: r.mode,
      status: stale ? 'stopped' : r.status,
      startedBy: r.started_by,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      steps: r.steps,
      tokens: r.tokens,
      log: typeof r.log === 'string' ? (JSON.parse(r.log) as LogLine[]) : r.log,
    };
  }

  /**
   * Run the agent once for `agentId`, through the same MCP tools any external agent uses. With
   * `callModel` Claude decides; without it the run is simulated. One run per organisation at a
   * time. The run's log is saved whatever happens; payments are in the ledger as usual.
   */
  async run(
    orgId: string,
    user: User,
    input: { agentId: string; origin: string; callModel: ModelCaller | null },
  ): Promise<RunRecord> {
    assertCan(await this.orgs.role(orgId, user), 'reorder.run');
    const view = await this.orgs.view(orgId, user);
    if (!view.config.agents[input.agentId]) throw new ActionError('Choose one of your agents.');
    const items = await this.itemsOf(orgId);
    if (items.length === 0) throw new ActionError('Add items to the reorder list first.');

    const id = randomUUID();
    const mode = input.callModel ? 'claude' : 'simulated';
    const now = this.clock();
    await this.db.transaction(async (tx) => {
      const busy = await tx.query<{ id: string }>(
        `select id from org_agent_runs
          where org_id = $1 and status = 'running' and started_at > $2::timestamptz
          for update`,
        [orgId, new Date(now - STALE_RUN_MS).toISOString()],
      );
      if (busy.length > 0) throw new ActionError('A run is still going. Wait until it finishes.');
      await tx.query(
        `insert into org_agent_runs (id, org_id, agent_id, mode, status, started_by, started_at)
         values ($1, $2, $3, $4, 'running', $5, $6::timestamptz)`,
        [
          id,
          orgId,
          input.agentId,
          mode,
          user.email.trim().toLowerCase().slice(0, 100),
          new Date(now).toISOString(),
        ],
      );
    });

    let outcome: RunOutcome;
    const tools = await mcpTools(
      this.orgs,
      { orgId, agentId: input.agentId, keyId: `run:${id}` },
      input.origin,
    );
    try {
      const prices = view.config.policy.referencePrices ?? [];
      const decimals = view.config.policy.currencyDecimals;
      outcome = input.callModel
        ? await claudeRun({
            tools,
            items,
            prices,
            callModel: input.callModel,
            currencyDecimals: decimals,
          })
        : await simulatedRun({
            tools,
            items,
            prices,
            currencyDecimals: decimals,
            orderReference: (n) => `RR-${id.slice(0, 8)}-${String(n)}`,
          });
    } catch (err) {
      console.error('reorder run failed', err instanceof Error ? err.name : 'unknown');
      outcome = {
        status: 'failed',
        steps: 0,
        tokens: 0,
        log: [
          { text: 'The run failed. Payments already decided stay in the ledger.', tone: 'neutral' },
        ],
      };
    } finally {
      await tools.close();
    }
    await this.db.query(
      `update org_agent_runs
          set status = $3, finished_at = $4::timestamptz, steps = $5, tokens = $6, log = $7::jsonb
        where id = $1 and org_id = $2`,
      [
        id,
        orgId,
        outcome.status,
        new Date(this.clock()).toISOString(),
        outcome.steps,
        outcome.tokens,
        JSON.stringify(outcome.log),
      ],
    );
    const rows = await this.db.query<RunRow>(
      `select ${RUN_COLUMNS} from org_agent_runs where id = $1 and org_id = $2`,
      [id, orgId],
    );
    const row = rows[0];
    if (!row) throw new Error('run row missing');
    return this.record(row);
  }
}
