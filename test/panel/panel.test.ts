import { request as httpRequest } from 'node:http';
import { Script } from 'node:vm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/kya-commands.js';
import { loadSigningIssuer } from '../../src/kya/store.js';
import { Ledger } from '../../src/ledger/ledger.js';
import { APP_JS, INDEX_HTML } from '../../src/panel/assets.js';
import { PanelError, startPanel, type RunningPanel } from '../../src/panel/server.js';
import { MINUTE, NOW } from '../engine/fixtures.js';
import { pay } from '../ledger/helpers.js';

let home: string;
let config: string;
let panel: RunningPanel;
let token: string;
let base: string;
let reviewId: string;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-panel-'));
  home = join(dir, '.mandate');
  config = join(dir, 'mandate.yaml');
  runInit({ home, config });
  const issuer = loadSigningIssuer(home);
  const ledger = Ledger.open(join(home, 'ledger.db'), {
    issuer: issuer.id,
    privateKey: issuer.privateKey,
  });
  reviewId = pay(ledger, { amount: 600_000 }, NOW - 2 * MINUTE).entry.data.payment_id as string;
  pay(ledger, { merchant: '<img src=x onerror=alert(1)>', country: 'RU' }, NOW - MINUTE);
  ledger.close();
  panel = await startPanel({
    home,
    configPath: config,
    port: 0,
    actor: 'tester (panel)',
    clock: () => NOW,
  });
  const url = new URL(panel.url);
  token = url.hash.replace('#token=', '');
  base = `${url.protocol}//${url.host}`;
});

afterEach(async () => {
  await panel.close();
});

const auth = () => ({ Authorization: `Bearer ${token}` });
const post = (path: string, body?: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: { ...auth(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
interface PaymentView {
  payment_id: string;
  merchant: string;
  status: string;
  decided_by: string;
  note: string | null;
}
interface PanelState {
  kill_switch: { on: boolean; by: string } | null;
  config_error: string | null;
  agents: { id: string; effective_status: string; frozen_by_human: { by: string } | null }[];
  pending: PaymentView[];
  cooling_off: PaymentView[];
  payments: PaymentView[];
  audit: { ok: boolean; entries: number };
}

const state = async () =>
  (await (await fetch(`${base}/api/state`, { headers: auth() })).json()) as PanelState;

/** Raw request with a chosen Host header (fetch does not allow setting it). */
function withHost(host: string): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: '/api/state',
        headers: { Host: host, ...auth() },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('access', () => {
  it('listens on 127.0.0.1 and puts a 256-bit token in the URL fragment', () => {
    expect(panel.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/);
  });

  it('serves the page shell with strict security headers', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it.each([
    ['no token', {}],
    ['a wrong token', { Authorization: 'Bearer nope' }],
    ['a token without Bearer', { Authorization: 'x' }],
  ])('refuses the API with %s', async (_n, headers) => {
    const res = await fetch(`${base}/api/state`, { headers });
    expect(res.status).toBe(401);
    expect((await fetch(`${base}/api/kill-switch/on`, { method: 'POST', headers })).status).toBe(
      401,
    );
  });

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    expect(await withHost('evil.example:80')).toBe(403);
    expect(await withHost(new URL(base).host)).toBe(200);
    expect(await withHost(`localhost:${new URL(base).port}`)).toBe(200);
  });

  it('reports a port that is already taken', async () => {
    await expect(
      startPanel({ home, configPath: config, port: panel.port, actor: 'x' }),
    ).rejects.toThrow(PanelError);
  });
});

describe('state', () => {
  it('lists agents, pending approvals, payments and the audit result', async () => {
    const s = await state();
    expect(s.kill_switch).toBeNull();
    expect(s.config_error).toBeNull();
    expect(s.agents).toEqual([
      expect.objectContaining({
        id: 'lab-procurement',
        effective_status: 'active',
        today: {
          budget: 'CHF 20000.00',
          approved: 'CHF 0.00',
          pending: 'CHF 6000.00',
          remaining: 'CHF 14000.00',
        },
      }),
    ]);
    expect(s.pending.map((p: { payment_id: string }) => p.payment_id)).toEqual([reviewId]);
    expect(s.payments).toHaveLength(2);
    expect(s.audit).toMatchObject({ ok: true, entries: 2 });
  });

  it('returns agent-supplied text as data, unescaped, for the page to render as text', async () => {
    const s = await state();
    expect(s.payments[0]?.merchant).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('actions', () => {
  it('approves a payment in review, once', async () => {
    const res = await post(`/api/payments/${reviewId}/approve`, { note: 'Quote checked' });
    expect(res.status).toBe(200);
    const s = await state();
    expect(s.pending).toHaveLength(0);
    expect(s.payments[1]).toMatchObject({
      status: 'approved',
      decided_by: 'tester (panel)',
      note: 'Quote checked',
    });
    expect(s.cooling_off).toHaveLength(1);
    const again = await post(`/api/payments/${reviewId}/approve`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: `Payment ${reviewId} is approved, not waiting for review.`,
    });
  });

  it('declines a payment in review', async () => {
    expect((await post(`/api/payments/${reviewId}/decline`)).status).toBe(200);
    expect((await state()).payments[1]?.status).toBe('declined');
  });

  it('cancels during cooling-off', async () => {
    await post(`/api/payments/${reviewId}/approve`);
    expect((await post(`/api/payments/${reviewId}/cancel`)).status).toBe(200);
    expect((await state()).payments[1]?.status).toBe('cancelled');
  });

  it('freezes and unfreezes an agent, and refuses an unknown one', async () => {
    expect((await post('/api/agents/lab-procurement/freeze')).status).toBe(200);
    expect((await state()).agents[0]).toMatchObject({
      effective_status: 'frozen',
      frozen_by_human: { by: 'tester (panel)' },
    });
    expect((await post('/api/agents/lab-procurement/unfreeze')).status).toBe(200);
    expect((await state()).agents[0]?.effective_status).toBe('active');
    expect((await post('/api/agents/ghost/freeze')).status).toBe(409);
  });

  it('turns the kill switch on and off', async () => {
    expect((await post('/api/kill-switch/on', { note: 'incident' })).status).toBe(200);
    expect((await state()).kill_switch).toMatchObject({ on: true, by: 'tester (panel)' });
    expect((await post('/api/kill-switch/off')).status).toBe(200);
    expect((await state()).kill_switch?.on).toBe(false);
  });

  it('rejects a malformed or oversized body', async () => {
    expect((await post('/api/kill-switch/on', { note: 1 })).status).toBe(400);
    expect((await post('/api/kill-switch/on', { other: 'x' })).status).toBe(400);
    expect((await post('/api/kill-switch/on', { note: 'x'.repeat(20_000) })).status).toBe(413);
    expect((await state()).kill_switch).toBeNull();
  });

  it('every panel action lands in the audited ledger', async () => {
    await post(`/api/payments/${reviewId}/approve`);
    await post('/api/agents/lab-procurement/freeze');
    await post('/api/kill-switch/on');
    expect((await state()).audit).toMatchObject({ ok: true, entries: 5 });
  });
});

describe('CSV export', () => {
  it('downloads the ledger as CSV', async () => {
    const res = await fetch(`${base}/api/export.csv`, { headers: auth() });
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="mandate-ledger-2026-10-21.csv"',
    );
    expect((await res.text()).trimEnd().split('\r\n')).toHaveLength(3);
  });
});

describe('page script', () => {
  it('is valid JavaScript (parsed, not just grepped)', () => {
    expect(() => new Script(APP_JS)).not.toThrow();
  });
  it('never inserts HTML: no innerHTML, outerHTML, insertAdjacentHTML or document.write', () => {
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
  it('has no inline script in the page shell', () => {
    expect(INDEX_HTML.match(/<script[^>]*>/g)).toEqual(['<script src="/app.js" defer>']);
  });
});
