import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActionError, canonicalJson, normalizeName, type ReferencePrice } from '@flow-e/mcp/core';
import type { ApiCaller } from './api-keys';
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

  /** The list as people keep it (typed in, or accepted suggestions). */
  async items(orgId: string, user: User): Promise<ReorderItem[]> {
    assertCan(await this.orgs.role(orgId, user), 'org.read');
    return this.itemsOf(orgId);
  }

  private async itemsOf(orgId: string, withSuggested = false): Promise<ReorderItem[]> {
    const rows = await this.db.query<{
      id: string;
      item: string;
      supplier: string | null;
      quantity: number;
      stock: number | null;
      min_stock: number | null;
      category: string | null;
      country: string | null;
    }>(
      `select id, item, supplier, quantity, stock, min_stock, category, country
         from org_reorder_items
        where org_id = $1 and (status = 'active' or ($2 and status = 'suggested'))
        order by position, created_at`,
      [orgId, withSuggested],
    );
    return rows.map((r) => ({
      id: r.id,
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
      // Suggestions from other systems stay; only the list people keep is replaced.
      await tx.query("delete from org_reorder_items where org_id = $1 and status = 'active'", [
        orgId,
      ]);
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
    const auto = (await this.settingsOf(orgId)).autoIncludeSuggested;
    const items = await this.itemsOf(orgId, auto);
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
    // Suggestions join one run, then they are used.
    const used = items.filter((i) => i.id !== undefined).map((i) => i.id as string);
    if (auto && used.length > 0) {
      await this.db.query(
        `update org_reorder_items set status = 'used', updated_at = $3::timestamptz
          where org_id = $1 and status = 'suggested' and id = any($2::uuid[])`,
        [orgId, `{${used.join(',')}}`, new Date(this.clock()).toISOString()],
      );
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

  // Suggestions from other systems --------------------------------------------------------------

  async suggestions(orgId: string, user: User): Promise<Suggestion[]> {
    assertCan(await this.orgs.role(orgId, user), 'org.read');
    const rows = await this.db.query<SuggestionRow>(
      `select id, item, supplier, quantity, unit, reason, to_char(needed_by, 'YYYY-MM-DD') as needed_by,
              price_item, source, status, ${iso('created_at')} as created_at
         from org_reorder_items
        where org_id = $1 and status in ('suggested', 'needs_matching')
        order by created_at desc`,
      [orgId],
    );
    return rows.map((r) => ({
      id: r.id,
      item: r.item,
      supplier: r.supplier,
      quantity: r.quantity,
      unit: r.unit,
      reason: r.reason,
      neededBy: r.needed_by,
      priceItem: r.price_item,
      source: r.source ?? '',
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  /** Add a suggestion to the list people keep (then it is edited like any row), or dismiss it. */
  async decideSuggestion(
    orgId: string,
    user: User,
    id: string,
    decision: 'accept' | 'dismiss',
  ): Promise<void> {
    assertCan(await this.orgs.role(orgId, user), 'reorder.manage');
    if (!z.uuid().safeParse(id).success) throw new ActionError('No such suggestion.');
    const rows = await this.db.query<{ id: string }>(
      `update org_reorder_items
          set status = $3, updated_by = $4, updated_at = $5::timestamptz
        where id = $1 and org_id = $2
          and status in ('suggested', 'needs_matching')
          and ($3 = 'dismissed' or status = 'suggested')
        returning id`,
      [
        id,
        orgId,
        decision === 'accept' ? 'active' : 'dismissed',
        user.email.trim().toLowerCase().slice(0, 100),
        new Date(this.clock()).toISOString(),
      ],
    );
    if (rows.length === 0) {
      throw new ActionError(
        decision === 'accept'
          ? 'Link it to the price list first, or it was already handled.'
          : 'No such suggestion, or it was already handled.',
      );
    }
  }

  /** A person links a "needs matching" suggestion to a price-list item; it becomes suggested. */
  async linkSuggestion(orgId: string, user: User, id: string, priceItem: string): Promise<void> {
    assertCan(await this.orgs.role(orgId, user), 'reorder.manage');
    if (!z.uuid().safeParse(id).success) throw new ActionError('No such suggestion.');
    const view = await this.orgs.view(orgId, user);
    const ref = (view.config.policy.referencePrices ?? []).find((r) => r.id === priceItem);
    if (!ref) throw new ActionError('Choose an item from the price list.');
    const rows = await this.db.query<{ id: string }>(
      `update org_reorder_items
          set status = 'suggested', item = $3, supplier = coalesce($4, supplier), price_item = $5,
              updated_by = $6, updated_at = $7::timestamptz
        where id = $1 and org_id = $2 and status = 'needs_matching'
        returning id`,
      [
        id,
        orgId,
        ref.item,
        ref.supplier ?? null,
        ref.id,
        user.email.trim().toLowerCase().slice(0, 100),
        new Date(this.clock()).toISOString(),
      ],
    );
    if (rows.length === 0) throw new ActionError('No such suggestion, or it was already handled.');
  }

  async settings(orgId: string, user: User): Promise<{ autoIncludeSuggested: boolean }> {
    assertCan(await this.orgs.role(orgId, user), 'org.read');
    return this.settingsOf(orgId);
  }

  private async settingsOf(orgId: string): Promise<{ autoIncludeSuggested: boolean }> {
    const rows = await this.db.query<{ auto_include_suggested: boolean }>(
      'select auto_include_suggested from org_integration_settings where org_id = $1',
      [orgId],
    );
    return { autoIncludeSuggested: rows[0]?.auto_include_suggested === true };
  }

  async setAutoInclude(orgId: string, user: User, on: boolean): Promise<void> {
    assertCan(await this.orgs.role(orgId, user), 'reorder.manage');
    await this.db.query(
      `insert into org_integration_settings (org_id, auto_include_suggested, updated_by, updated_at)
       values ($1, $2, $3, $4::timestamptz)
       on conflict (org_id) do update
         set auto_include_suggested = excluded.auto_include_suggested,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [
        orgId,
        on,
        user.email.trim().toLowerCase().slice(0, 100),
        new Date(this.clock()).toISOString(),
      ],
    );
  }

  /**
   * A reorder signal from another system (POST /api/v1/reorder-signals). It only adds a
   * suggestion to the list; it never buys. Matched by price-list id, or by exact item name (and
   * supplier, when given); anything else is kept as "needs matching", never guessed. The same
   * idempotency key gives the same answer and adds nothing; reused with a different request, it
   * is refused.
   */
  async receiveSignal(
    caller: ApiCaller,
    input: unknown,
    prices: readonly ReferencePrice[],
  ): Promise<{ status: 200 | 201 | 409; body: unknown }> {
    const signal = signalSchema.parse(input);
    const request = canonicalJson(signal);
    return this.db.transaction(async (tx) => {
      // Two signals with the same key at once: the second waits here, then sees the first.
      await tx.query('select id from orgs where id = $1 for update', [caller.orgId]);
      const earlier = await tx.query<{ request: unknown; result: unknown }>(
        `select request, result from org_reorder_signals where org_id = $1 and idempotency_key = $2`,
        [caller.orgId, signal.idempotency_key],
      );
      const prior = earlier[0];
      if (prior) {
        const same =
          canonicalJson(
            (typeof prior.request === 'string'
              ? JSON.parse(prior.request)
              : prior.request) as never,
          ) === request;
        if (!same) {
          return {
            status: 409,
            body: { error: 'This idempotency key was already used for a different signal.' },
          };
        }
        return {
          status: 200,
          body:
            typeof prior.result === 'string' ? (JSON.parse(prior.result) as unknown) : prior.result,
        };
      }
      const ref = matchPriceItem(prices, signal);
      const id = randomUUID();
      const now = new Date(this.clock()).toISOString();
      const item = ref?.item ?? signal.item ?? signal.item_id ?? '';
      const supplier = ref?.supplier ?? signal.supplier ?? null;
      await tx.query(
        `insert into org_reorder_items
           (id, org_id, position, item, supplier, quantity, unit, reason, needed_by, price_item,
            source, status, updated_by, updated_at, created_at)
         values ($1, $2, 999, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $10, $12::timestamptz, $12::timestamptz)`,
        [
          id,
          caller.orgId,
          item.slice(0, 200),
          supplier,
          signal.quantity,
          signal.unit ?? null,
          signal.reason ?? null,
          signal.needed_by ?? null,
          ref?.id ?? null,
          caller.name,
          ref ? 'suggested' : 'needs_matching',
          now,
        ],
      );
      const result = {
        suggestion_id: id,
        status: ref ? 'suggested' : 'needs_matching',
        item,
        price_item: ref?.id ?? null,
        supplier,
        quantity: signal.quantity,
        message: ref
          ? 'Added to the reorder list as a suggestion. Nothing is bought until a run asks Flow-E for it.'
          : 'Kept as "needs matching": no price-list item has this id or name. A person will link it.',
      };
      await tx.query(
        `insert into org_reorder_signals (org_id, idempotency_key, key_id, request, result, created_at)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz)`,
        [caller.orgId, signal.idempotency_key, caller.keyId, request, JSON.stringify(result), now],
      );
      return { status: 201, body: result };
    });
  }
}

export const signalSchema = z
  .strictObject({
    /** A price-list id, e.g. "pipette-tips-20-racks". */
    item_id: z.string().trim().min(1).max(100).optional(),
    /** Or the item's name as in the price list. */
    item: z.string().trim().min(1).max(200).optional(),
    supplier: z.string().trim().min(1).max(200).optional(),
    quantity: z.number().int().min(1).max(100_000),
    unit: z.string().trim().min(1).max(40).optional(),
    reason: z.string().trim().min(1).max(300).optional(),
    needed_by: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30')
      .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a real date')
      .optional(),
    idempotency_key: z.string().trim().min(1).max(200),
  })
  .refine((s) => s.item_id !== undefined || s.item !== undefined, {
    message: 'Name the item: "item_id" (from the price list) or "item".',
    path: ['item'],
  });
export type ReorderSignal = z.infer<typeof signalSchema>;

/** Exact match only: by id, or by the item's name (and supplier when given). Never a guess. */
export function matchPriceItem(
  prices: readonly ReferencePrice[],
  s: Pick<ReorderSignal, 'item_id' | 'item' | 'supplier'>,
): ReferencePrice | null {
  if (s.item_id !== undefined) return prices.find((p) => p.id === s.item_id) ?? null;
  const name = normalizeName(s.item ?? '');
  const supplier = s.supplier === undefined ? null : normalizeName(s.supplier);
  const same = prices.filter((p) => normalizeName(p.item) === name);
  if (supplier === null) return same.length === 1 ? (same[0] ?? null) : null;
  return (
    same.find((p) => p.supplier !== undefined && normalizeName(p.supplier) === supplier) ??
    same.find((p) => p.supplier === undefined) ??
    null
  );
}

export interface Suggestion {
  id: string;
  item: string;
  supplier: string | null;
  quantity: number;
  unit: string | null;
  reason: string | null;
  neededBy: string | null;
  priceItem: string | null;
  source: string;
  status: 'suggested' | 'needs_matching';
  createdAt: string;
}

interface SuggestionRow {
  id: string;
  item: string;
  supplier: string | null;
  quantity: number;
  unit: string | null;
  reason: string | null;
  needed_by: string | null;
  price_item: string | null;
  source: string | null;
  status: 'suggested' | 'needs_matching';
  created_at: string;
}
