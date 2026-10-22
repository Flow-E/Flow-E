import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openPglite, type Db } from '@/server/db';
import { decryptSecret, encryptSecret, parseEncryptionKey } from '@/server/keys';
import { SandboxStore } from '@/server/store';

const CLI = path.resolve(__dirname, '../../dist/cli/index.js');
const MIGRATIONS = path.resolve(__dirname, '../db/migrations');
/** Wednesday 21 Oct 2026, 12:00 in Zurich. */
const NOW = Date.parse('2026-10-21T10:00:00Z');
const MINUTE = 60_000;

let db: Db;
let store: SandboxStore;
let now: number;
const key = randomBytes(32);
const ALICE = 'dev:alice@example.com';
const BOB = 'dev:bob@example.com';
const by = { by: 'alice@example.com (sandbox)' };

beforeEach(async () => {
  db = await openPglite();
  await migrate(db, MIGRATIONS);
  now = NOW;
  store = new SandboxStore(db, key, { clock: () => now });
  await store.ensureSandbox(ALICE);
});

afterEach(async () => {
  await db.close();
});

const decisions = (outcomes: { result: { decision: string; rule: string | null } }[]) =>
  outcomes.map((o) => `${o.result.decision}${o.result.rule ? ` ${o.result.rule}` : ''}`);

describe('sandbox creation', () => {
  it('starts with the fictional demo: two agents, own keys, an empty and intact ledger', async () => {
    const v = await store.view(ALICE);
    expect(v.agents.map((a) => a.id)).toEqual(['lab-procurement', 'office-supplies']);
    expect(v.organisation).toBe('Example Labs AG (fictional)');
    expect(v.issuer).toMatch(/^flow-e-issuer:[0-9a-f]{16}$/);
    expect(v.entries).toHaveLength(0);
    expect(v.audit).toEqual({ ok: true, entries: 0, head: null });
  });

  it('is idempotent and keeps the private key encrypted at rest', async () => {
    await store.ensureSandbox(ALICE);
    const rows = await db.query<{ issuer_private_key_enc: string }>(
      'select issuer_private_key_enc from sandboxes',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issuer_private_key_enc).not.toMatch(/PRIVATE KEY/);
    expect(decryptSecret(rows[0]?.issuer_private_key_enc ?? '', key)).toMatch(/BEGIN PRIVATE KEY/);
  });
});

describe('the demo story', () => {
  it('gives the same decisions as the core CLI `flow-e simulate`', async () => {
    const web = decisions(await store.playStory(ALICE));
    expect(web).toEqual([
      'declined SUPPLIER',
      'approved',
      'review APPROVAL_THRESHOLD',
      'declined PER_PAYMENT_LIMIT',
      'declined SPLIT_DETECTION',
      'declined SUPPLIER',
      'approved',
    ]);

    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'flow-e-web-')), 'demo');
    execFileSync(process.execPath, [CLI, 'demo', '--dir', dir, '--no-panel']);
    const out = execFileSync(process.execPath, [CLI, 'simulate', '--dir', dir], {
      encoding: 'utf8',
    });
    const cli = out
      .split('\n')
      .filter((l) => /^(APPROVED|DECLINED|REVIEW)\b/.test(l))
      .map((l) => l.split(/\s+/)[0]?.toLowerCase());
    expect(cli).toEqual(web.map((d) => d.split(' ')[0]));
  });

  it('keeps an intact, signed hash chain', async () => {
    await store.playStory(ALICE);
    const v = await store.view(ALICE);
    expect(v.audit).toMatchObject({ ok: true, entries: 7 });
    expect(v.entries[1]?.prev_hash).toBe(v.entries[0]?.hash);
  });
});

describe('owner actions', () => {
  it('approves a payment in review, starting cooling-off for a new supplier', async () => {
    const story = await store.playStory(ALICE);
    const centrifuge = story[2];
    await store.resolve(ALICE, centrifuge?.paymentId ?? '', 'approved', { ...by, note: 'ok' });
    const v = await store.view(ALICE);
    expect(v.pending).toHaveLength(0);
    const p = v.payments.find((x) => x.paymentId === centrifuge?.paymentId);
    expect(p).toMatchObject({ status: 'approved', decidedBy: by.by, note: 'ok' });
  });

  it('declines, and refuses to resolve twice', async () => {
    const [, , centrifuge] = await store.playStory(ALICE);
    const id = centrifuge?.paymentId ?? '';
    await store.resolve(ALICE, id, 'declined', by);
    await expect(store.resolve(ALICE, id, 'approved', by)).rejects.toThrow(
      /not waiting for review/,
    );
  });

  it('cancels inside the cooling-off window, not after', async () => {
    const story = await store.playStory(ALICE);
    await store.cancel(ALICE, story[1]?.paymentId ?? '', by);
    now += 11 * MINUTE;
    await expect(store.cancel(ALICE, story[6]?.paymentId ?? '', by)).rejects.toThrow(/closed at/);
    const v = await store.view(ALICE);
    expect(v.payments.find((p) => p.paymentId === story[1]?.paymentId)?.status).toBe('cancelled');
  });

  it('freezing an agent and the kill switch both block the next request', async () => {
    const gloves = {
      agentId: 'lab-procurement',
      merchant: 'Example Labware AG',
      amount: '240.00',
      currency: 'CHF',
      category: '5047',
      country: 'CH',
    };
    await store.setFrozen(ALICE, 'lab-procurement', true, by);
    expect((await store.requestPayment(ALICE, gloves)).result.rule).toBe('AGENT_STATUS');
    await store.setFrozen(ALICE, 'lab-procurement', false, by);
    await store.setKillSwitch(ALICE, true, by);
    expect((await store.requestPayment(ALICE, gloves)).result.rule).toBe('KILL_SWITCH');
    await store.setKillSwitch(ALICE, false, by);
    expect((await store.requestPayment(ALICE, gloves)).result.decision).toBe('approved');
    const v = await store.view(ALICE);
    expect(v.controls.killSwitch).toMatchObject({ on: false, by: by.by });
    expect(v.audit.ok).toBe(true);
  });

  it('rejects an unknown agent and a bad amount without recording anything', async () => {
    const base = { merchant: 'X', currency: 'CHF', category: '5047', country: 'CH' };
    await expect(store.setFrozen(ALICE, 'ghost', true, by)).rejects.toThrow(/not in this sandbox/);
    await expect(
      store.requestPayment(ALICE, { ...base, agentId: 'lab-procurement', amount: '12.345' }),
    ).rejects.toThrow(/Invalid amount/);
    await expect(
      store.requestPayment(ALICE, {
        ...base,
        agentId: 'lab-procurement',
        amount: '1',
        category: 'x',
      }),
    ).rejects.toThrow();
    expect((await store.view(ALICE)).entries).toHaveLength(0);
  });
});

describe('append-only storage', () => {
  it('refuses UPDATE, DELETE and TRUNCATE on the ledger', async () => {
    await store.playStory(ALICE);
    await expect(db.query("update ledger_entries set data = '{}' where seq = 2")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query('delete from ledger_entries where seq = 3')).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query('truncate ledger_entries')).rejects.toThrow(/append-only/);
  });

  it('names the first broken entry when the database is edited around the triggers', async () => {
    await store.playStory(ALICE);
    await db.query('alter table ledger_entries disable trigger ledger_entries_no_change');
    await db.query(
      `update ledger_entries set data = replace(data, '"declined"', '"approved"') where seq = 4`,
    );
    const v = await store.view(ALICE);
    expect(v.audit).toMatchObject({ ok: false, firstBroken: { seq: 4 } });
  });
});

describe('isolation between users', () => {
  it("never shows or acts on another user's sandbox", async () => {
    const story = await store.playStory(ALICE);
    await store.ensureSandbox(BOB);
    const bob = await store.view(BOB);
    expect(bob.payments).toHaveLength(0);
    expect(bob.issuer).not.toBe((await store.view(ALICE)).issuer);
    const alicePayment = story[2]?.paymentId ?? '';
    expect(await store.payment(BOB, alicePayment)).toBeNull();
    await expect(store.resolve(BOB, alicePayment, 'approved', by)).rejects.toThrow(/No payment/);
    expect((await store.view(ALICE)).pending).toHaveLength(1);
  });

  it('a user without a sandbox gets a clear error, not someone else’s', async () => {
    await expect(store.view('dev:nobody@example.com')).rejects.toThrow(/No sandbox yet/);
  });
});

describe('receipts', () => {
  it('a sandbox receipt verifies offline with the core CLI and the public key only', async () => {
    const [first] = await store.playStory(ALICE);
    const detail = await store.payment(ALICE, first?.paymentId ?? '');
    const v = await store.view(ALICE);
    const dir = mkdtempSync(path.join(tmpdir(), 'flow-e-receipt-'));
    writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(detail?.receipt));
    writeFileSync(path.join(dir, 'issuer.pub'), v.publicKeyPem);
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        '--home',
        path.join(dir, 'none'),
        'verify',
        path.join(dir, 'receipt.json'),
        '--pubkey',
        path.join(dir, 'issuer.pub'),
        '--offline',
      ],
      { encoding: 'utf8' },
    );
    expect(out).toMatch(/issuer signature is valid/);
    expect(out.trim().endsWith('VALID')).toBe(true);
    expect(detail?.trace).toHaveLength(15);
  });

  it('verifies in the sandbox, and catches an edited receipt', async () => {
    const [first] = await store.playStory(ALICE);
    const detail = await store.payment(ALICE, first?.paymentId ?? '');
    const text = JSON.stringify(detail?.receipt);
    expect((await store.verify(ALICE, text)).valid).toBe(true);
    const forged = text.replace('"declined"', '"approved"');
    const check = await store.verify(ALICE, forged);
    expect(check.valid).toBe(false);
    expect(check.checks.join('\n')).toMatch(/contents do not match/);
  });
});

interface RawMandate {
  base_currency: string;
  agents: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

describe('mandate editing', () => {
  const edit = async (mutate: (raw: RawMandate) => void) => {
    const raw = structuredClone((await store.view(ALICE)).raw) as RawMandate;
    mutate(raw);
    await store.updateConfig(ALICE, raw, by);
  };
  const lab = (raw: RawMandate) => raw.agents['lab-procurement'] ?? {};

  it('applies a valid change and records it in the ledger', async () => {
    await edit((raw) => {
      lab(raw).daily_budget = 15000;
    });
    const v = await store.view(ALICE);
    expect(v.config.agents['lab-procurement']?.mandate.dailyBudget).toBe(1_500_000);
    expect(v.entries.at(-1)?.type).toBe('config.updated');
    expect(v.audit.ok).toBe(true);
  });

  it('rejects an invalid mandate, a new base currency and new agents', async () => {
    await expect(
      edit((raw) => {
        lab(raw).categories = ['51'];
      }),
    ).rejects.toThrow(/four-digit/);
    await expect(
      edit((raw) => {
        raw.base_currency = 'EUR';
      }),
    ).rejects.toThrow(/base currency/);
    await expect(
      edit((raw) => {
        raw.agents['new-bot'] = lab(raw);
      }),
    ).rejects.toThrow(/added or removed/);
  });
});

describe('reset and export', () => {
  it('reset starts a new sandbox; the old ledger stays in the database untouched', async () => {
    await store.playStory(ALICE);
    const before = await store.view(ALICE);
    await store.resetSandbox(ALICE);
    const after = await store.view(ALICE);
    expect(after.issuer).not.toBe(before.issuer);
    expect(after.entries).toHaveLength(0);
    const rows = await db.query<{ n: number }>('select count(*)::int as n from ledger_entries');
    expect(rows[0]?.n).toBe(7);
  });

  it('exports formula-safe CSV', async () => {
    await store.playStory(ALICE);
    const lines = (await store.csv(ALICE)).trimEnd().split('\r\n');
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatch(/^"seq","created_at","type"/);
  });
});

describe('key encryption', () => {
  it('round-trips, and fails with another key or a malformed value', () => {
    const sealed = encryptSecret('secret', key);
    expect(decryptSecret(sealed, key)).toBe('secret');
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow();
    expect(() => decryptSecret('nope', key)).toThrow(/Malformed/);
  });

  it('requires a 32-byte base64 key', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/not set/);
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow(
      /32 random bytes/,
    );
    expect(parseEncryptionKey(key.toString('base64'))).toHaveLength(32);
  });
});
