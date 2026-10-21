import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { parseConfig, type MandateConfig } from '../config/schema.js';
import {
  ActionError,
  cancelCoolingOff,
  effectiveStatus,
  resolvePayment,
  setAgentFrozen,
  setKillSwitch,
} from '../control/actions.js';
import { exportCsv } from '../control/csv.js';
import { formatMoney } from '../engine/money.js';
import { dailySpend } from '../engine/rules.js';
import type { Ledger, PaymentRecord } from '../ledger/ledger.js';
import { APP_CSS, APP_JS, INDEX_HTML } from './assets.js';

/**
 * The owner's control panel. Local only: bound to the loopback interface, every API call needs
 * the random token printed at start (sent as a header, so other sites cannot forge requests),
 * and the Host header must be a loopback name (blocks DNS rebinding). The page uses no inline
 * script and renders agent-supplied text as text, never as HTML.
 */

export interface PanelAppOptions {
  configPath: string;
  ledger: Ledger;
  publicKey: KeyObject;
  token: string;
  port: number;
  actor: string;
  clock?: () => number;
}

export function newPanelToken(): string {
  return randomBytes(32).toString('base64url');
}

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

const noteSchema = z.object({ note: z.string().max(500).optional() }).strict();

function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

export function createPanelApp(o: PanelAppOptions): Hono {
  const clock = o.clock ?? Date.now;
  const allowedHosts = new Set([
    `127.0.0.1:${String(o.port)}`,
    `localhost:${String(o.port)}`,
    `[::1]:${String(o.port)}`,
  ]);
  const expected = digest(o.token);
  let auditCache: { key: string; value: { ok: boolean; entries: number; message: string } } | null =
    null;

  const app = new Hono();

  app.use('*', async (c, next) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    if (!allowedHosts.has(c.req.header('host') ?? '')) {
      return c.text('Forbidden host.', 403);
    }
    await next();
    return undefined;
  });

  app.get('/', (c) => c.html(INDEX_HTML));
  app.get('/app.js', (c) =>
    c.body(APP_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }),
  );
  app.get('/app.css', (c) => c.body(APP_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' }));

  app.use('/api/*', bodyLimit({ maxSize: 8 * 1024 }), async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!timingSafeEqual(digest(given), expected)) {
      return c.json({ error: 'Missing or wrong panel token.' }, 401);
    }
    await next();
    return undefined;
  });

  const loadConfig = (): { config: MandateConfig | null; error: string | null } => {
    try {
      return { config: parseConfig(readFileSync(o.configPath, 'utf8')), error: null };
    } catch (err) {
      return { config: null, error: (err as Error).message };
    }
  };

  const audit = () => {
    const entries = o.ledger.entries();
    const last = entries.at(-1);
    const key = last ? `${String(last.seq)}:${last.hash}` : 'empty';
    if (auditCache?.key !== key) {
      const r = o.ledger.audit(o.publicKey);
      auditCache = {
        key,
        value: r.ok
          ? {
              ok: true,
              entries: r.entries,
              message: `Intact: ${String(r.entries)} entries, every signature valid.`,
            }
          : {
              ok: false,
              entries: r.entries,
              message: `BROKEN at entry #${String(r.firstBroken.seq)}: ${r.firstBroken.reason}.`,
            },
      };
    }
    return auditCache.value;
  };

  app.get('/api/state', (c) => {
    const now = clock();
    const { config, error } = loadConfig();
    const controls = o.ledger.controls();
    const all = o.ledger.payments();
    const decimals = config?.policy.currencyDecimals;
    const fmt = (minor: number | null, currency: string) =>
      minor === null ? null : formatMoney(minor, currency, decimals);
    const view = (p: PaymentRecord) => ({
      payment_id: p.paymentId,
      receipt_id: p.receiptId,
      agent_id: p.agentId,
      status: p.status,
      engine_decision: p.engineDecision,
      rule: p.rule,
      reason: p.reason,
      merchant: p.request.merchant,
      amount: fmt(p.request.amount, p.request.currency),
      amount_base: fmt(p.amountBase, p.baseCurrency),
      category: p.request.category,
      country: p.request.country,
      memo: p.request.memo ?? null,
      created_at: p.createdAt,
      cancellable_until: p.cancellableUntil,
      decided_by: p.decidedBy,
      note: p.note,
    });
    const agents = config
      ? Object.values(config.agents).map((a) => {
          const spend = dailySpend(
            o.ledger.paymentViews(a.id),
            now,
            config.policy.timezone,
            a.mandate.dailyBudget,
          );
          const base = (n: number) => fmt(n, config.policy.baseCurrency);
          const human = controls.frozen[a.id];
          return {
            id: a.id,
            owner: a.owner,
            configured_status: a.status,
            frozen_by_human: human?.frozen ? { by: human.by, at: human.at } : null,
            effective_status: effectiveStatus(a.status, controls, a.id),
            today: {
              budget: base(a.mandate.dailyBudget),
              approved: base(spend.approved),
              pending: base(spend.pending),
              remaining: base(spend.remaining),
            },
          };
        })
      : [];
    const newestFirst = [...all].reverse();
    return c.json({
      issuer: o.ledger.issuer,
      now: new Date(now).toISOString(),
      config_error: error,
      kill_switch: controls.killSwitch,
      agents,
      pending: newestFirst.filter((p) => p.status === 'review').map(view),
      cooling_off: newestFirst
        .filter(
          (p) =>
            p.status === 'approved' &&
            p.cancellableUntil !== null &&
            Date.parse(p.cancellableUntil) > now,
        )
        .map(view),
      payments: newestFirst.slice(0, 100).map(view),
      audit: audit(),
    });
  });

  const act = async (c: Context, run: (note: string | undefined) => unknown) => {
    let note: string | undefined;
    if ((c.req.header('content-length') ?? '0') !== '0') {
      const parsed = noteSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Body must be {"note"?: string (≤500)}.' }, 400);
      note = parsed.data.note;
    }
    try {
      run(note);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ActionError) return c.json({ error: err.message }, 409);
      return c.json({ error: 'internal error' }, 500);
    }
  };
  const actor = (note: string | undefined) => ({ by: o.actor, note, now: clock() });

  app.post('/api/payments/:id/approve', (c) =>
    act(c, (note) => resolvePayment(o.ledger, c.req.param('id'), 'approved', actor(note))),
  );
  app.post('/api/payments/:id/decline', (c) =>
    act(c, (note) => resolvePayment(o.ledger, c.req.param('id'), 'declined', actor(note))),
  );
  app.post('/api/payments/:id/cancel', (c) =>
    act(c, (note) => cancelCoolingOff(o.ledger, c.req.param('id'), actor(note))),
  );
  app.post('/api/agents/:id/freeze', (c) =>
    act(c, (note) => {
      knownAgent(c.req.param('id'));
      return setAgentFrozen(o.ledger, c.req.param('id'), true, actor(note));
    }),
  );
  app.post('/api/agents/:id/unfreeze', (c) =>
    act(c, (note) => {
      knownAgent(c.req.param('id'));
      return setAgentFrozen(o.ledger, c.req.param('id'), false, actor(note));
    }),
  );
  app.post('/api/kill-switch/on', (c) =>
    act(c, (note) => setKillSwitch(o.ledger, true, actor(note))),
  );
  app.post('/api/kill-switch/off', (c) =>
    act(c, (note) => setKillSwitch(o.ledger, false, actor(note))),
  );

  app.get('/api/export.csv', (c) => {
    const date = new Date(clock()).toISOString().slice(0, 10);
    return c.body(exportCsv(o.ledger), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="imprest-ledger-${date}.csv"`,
    });
  });

  app.notFound((c) => c.json({ error: 'Not found.' }, 404));
  app.onError((err, c) => {
    // Hono's own HTTP errors (e.g. 413 from the body limit) keep their status; anything else is 500.
    if (err instanceof HTTPException)
      return c.json({ error: err.message || 'Request rejected.' }, err.status);
    return c.json({ error: 'internal error' }, 500);
  });

  function knownAgent(id: string): void {
    const { config } = loadConfig();
    if (config && !config.agents[id])
      throw new ActionError(`Agent "${id}" is not in mandate.yaml.`);
  }

  return app;
}
