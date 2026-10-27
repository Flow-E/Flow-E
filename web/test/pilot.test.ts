import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openPglite, type Db } from '@/server/db';
import { OutboxMailer, readOutbox, type Mailer } from '@/server/email';
import {
  MAX_PILOT_BODY_BYTES,
  PILOT_LIMITS,
  PILOT_PER_CLIENT,
  PILOT_PER_CLIENT_WINDOW_MS,
  adminEmails,
  handlePilot,
  isPilotAdmin,
  leadsRecipient,
  listPilotRequests,
  newPilotLimits,
  parsePilotForm,
  savePilotRequest,
  setPilotStatus,
  type PilotDeps,
} from '@/server/pilot';
import { gateExempt } from '@/server/gate';
import { MIGRATIONS } from './org-helpers';

const VALID = {
  name: 'Ada Example',
  email: 'Ada@Example-Labs.test',
  company: 'Example Labs AG (fictional)',
  role: 'Head of Lab',
  size: '50-249',
  buying: 'Reagents and consumables from three suppliers',
  country: 'Switzerland',
  message: '',
};

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function post(
  fields: Record<string, string>,
  init: { ip?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  const body = init.body ?? new URLSearchParams(fields).toString();
  return new Request('http://localhost:3150/api/pilot', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-real-ip': init.ip ?? '203.0.113.7',
      ...init.headers,
    },
    body,
  });
}

let db: Db;
let clock: { now: number };
let deps: PilotDeps;
let sent: { to: string; subject: string; text: string }[];

beforeAll(async () => {
  db = await openPglite();
  await migrate(db, MIGRATIONS);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('delete from pilot_requests');
  await db.query('delete from email_outbox');
  clock = { now: Date.parse('2026-10-27T09:00:00Z') };
  sent = [];
  const mailer: Mailer = {
    name: 'test',
    send(m) {
      sent.push(m);
      return Promise.resolve();
    },
  };
  deps = {
    sql: db,
    limits: newPilotLimits(() => clock.now),
    mailer: () => mailer,
    env: { NODE_ENV: 'test', FLOWE_LEADS_TO: 'founder@flow-e.test' },
    origin: 'http://localhost:3150',
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pilot form validation', () => {
  it('accepts a complete form, trims, lower-cases the email and drops empty optionals', () => {
    const r = parsePilotForm(form({ ...VALID, name: '  Ada Example  ', message: '   ' }));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.data).toEqual({
      name: 'Ada Example',
      email: 'ada@example-labs.test',
      company: 'Example Labs AG (fictional)',
      role: 'Head of Lab',
      size: '50-249',
      buying: 'Reagents and consumables from three suppliers',
      country: 'Switzerland',
      message: null,
    });
  });

  it('refuses missing required fields, a bad email and an unknown size', () => {
    for (const key of ['name', 'email', 'company', 'role', 'size', 'buying']) {
      const fields = Object.fromEntries(Object.entries(VALID).filter(([k]) => k !== key));
      expect(parsePilotForm(form(fields)).kind, key).toBe('invalid');
      expect(parsePilotForm(form({ ...VALID, [key]: '   ' })).kind, `${key} blank`).toBe('invalid');
    }
    expect(parsePilotForm(form({ ...VALID, email: 'not an email' })).kind).toBe('invalid');
    expect(parsePilotForm(form({ ...VALID, size: '5000' })).kind).toBe('invalid');
  });

  it('caps every field', () => {
    for (const [key, max] of Object.entries(PILOT_LIMITS)) {
      if (key === 'email') continue;
      const ok = parsePilotForm(form({ ...VALID, [key]: 'x'.repeat(max) }));
      const tooLong = parsePilotForm(form({ ...VALID, [key]: 'x'.repeat(max + 1) }));
      expect(ok.kind, key).toBe('ok');
      expect(tooLong.kind, key).toBe('invalid');
    }
    const long = `${'a'.repeat(250)}@example.test`;
    expect(parsePilotForm(form({ ...VALID, email: long })).kind).toBe('invalid');
  });

  it('turns control characters into spaces, keeping line breaks only in long text', () => {
    const r = parsePilotForm(
      form({ ...VALID, company: 'Example\r\nLabs\u0007AG', buying: 'line one\r\nline two' }),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.data.company).toBe('Example Labs AG');
    expect(r.data.buying).toBe('line one\nline two');
  });

  it('treats a filled honeypot as a bot, whatever else is in the form', () => {
    expect(parsePilotForm(form({ ...VALID, website: 'https://spam.test' })).kind).toBe('bot');
    expect(parsePilotForm(form({ website: 'x' })).kind).toBe('bot');
    expect(parsePilotForm(form({ ...VALID, website: '' })).kind).toBe('ok');
  });
});

describe('POST /api/pilot', () => {
  it('stores a request, emails the founder and redirects back with 303', async () => {
    const res = await handlePilot(post(VALID), deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3150/?pilot=sent#pilot');
    const rows = await listPilotRequests(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company: 'Example Labs AG (fictional)',
      email: 'ada@example-labs.test',
      status: 'new',
      message: null,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('founder@flow-e.test');
    expect(sent[0]?.subject).toBe('Pilot request: Example Labs AG (fictional)');
    expect(sent[0]?.text).toContain('Reagents and consumables');
    expect(sent[0]?.text).toContain('http://localhost:3150/admin/pilots');
  });

  it('sends no email without FLOWE_LEADS_TO, or with an invalid one', async () => {
    await handlePilot(post(VALID), { ...deps, env: { NODE_ENV: 'test' } });
    await handlePilot(post(VALID), {
      ...deps,
      env: { NODE_ENV: 'test', FLOWE_LEADS_TO: 'a, b@c.test' },
    });
    expect(sent).toHaveLength(0);
    expect(await listPilotRequests(db)).toHaveLength(2);
    expect(leadsRecipient({ NODE_ENV: 'test', FLOWE_LEADS_TO: ' x@y.test ' })).toBe('x@y.test');
  });

  it('lands in the development outbox with the real mailer', async () => {
    const res = await handlePilot(post(VALID), {
      ...deps,
      mailer: () => new OutboxMailer(db, { NODE_ENV: 'test' }),
    });
    expect(res.headers.get('location')).toContain('pilot=sent');
    const outbox = await readOutbox(db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.kind).toBe('pilot');
    expect(outbox[0]?.body_html).not.toContain('<script');
  });

  it('escapes HTML in the email', async () => {
    await handlePilot(post({ ...VALID, company: '<b>Evil</b> & Co' }), deps);
    const html = (sent[0] as unknown as { html: string }).html;
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
  });

  it('still answers "sent" when the email fails, and logs no content', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await handlePilot(post(VALID), {
      ...deps,
      mailer: () => ({ name: 'broken', send: () => Promise.reject(new Error('Ada Example')) }),
    });
    expect(res.headers.get('location')).toContain('pilot=sent');
    expect(await listPilotRequests(db)).toHaveLength(1);
    const logged = JSON.stringify(log.mock.calls);
    for (const v of [VALID.name, VALID.company, VALID.buying, 'ada@example-labs.test']) {
      expect(logged).not.toContain(v);
    }
  });

  it('answers "error" and logs no content when the database fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await handlePilot(post(VALID), {
      ...deps,
      sql: { query: () => Promise.reject(new Error(`insert failed: ${VALID.buying}`)) },
    });
    expect(res.headers.get('location')).toContain('pilot=error');
    expect(JSON.stringify(log.mock.calls)).not.toContain(VALID.buying);
    expect(sent).toHaveLength(0);
  });

  it('pretends success to a bot that fills the honeypot, and stores nothing', async () => {
    const res = await handlePilot(post({ ...VALID, website: 'https://spam.test' }), deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('pilot=sent');
    expect(await listPilotRequests(db)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('sends invalid input back with "error" and stores nothing', async () => {
    const res = await handlePilot(post({ ...VALID, email: 'nope' }), deps);
    expect(res.headers.get('location')).toBe('http://localhost:3150/?pilot=error#pilot');
    expect(await listPilotRequests(db)).toHaveLength(0);
  });

  it('refuses other content types, oversized bodies and cross-site posts', async () => {
    const json = await handlePilot(
      post(VALID, { headers: { 'content-type': 'application/json' }, body: '{}' }),
      deps,
    );
    expect(json.headers.get('location')).toContain('pilot=error');
    const big = await handlePilot(
      post(VALID, { body: `name=${'x'.repeat(MAX_PILOT_BODY_BYTES)}` }),
      deps,
    );
    expect(big.headers.get('location')).toContain('pilot=error');
    const cross = await handlePilot(
      post(VALID, { headers: { 'sec-fetch-site': 'cross-site' } }),
      deps,
    );
    expect(cross.headers.get('location')).toContain('pilot=error');
    expect(await listPilotRequests(db)).toHaveLength(0);
  });

  it('rate-limits per client address, and lets it through again after the window', async () => {
    for (let i = 0; i < PILOT_PER_CLIENT; i++) {
      const ok = await handlePilot(post(VALID), deps);
      expect(ok.headers.get('location')).toContain('pilot=sent');
    }
    const limited = await handlePilot(post(VALID), deps);
    expect(limited.status).toBe(303);
    expect(limited.headers.get('location')).toBe('http://localhost:3150/?pilot=limited#pilot');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another address is not affected; bots count against the limit too.
    const other = await handlePilot(post(VALID, { ip: '198.51.100.4' }), deps);
    expect(other.headers.get('location')).toContain('pilot=sent');
    expect(await listPilotRequests(db)).toHaveLength(PILOT_PER_CLIENT + 1);

    clock.now += PILOT_PER_CLIENT_WINDOW_MS + 1;
    const again = await handlePilot(post(VALID), deps);
    expect(again.headers.get('location')).toContain('pilot=sent');
  });
});

describe('pilot request storage', () => {
  it('lists newest first and records status changes with who and when', async () => {
    const parsed = parsePilotForm(form(VALID));
    if (parsed.kind !== 'ok') throw new Error('fixture');
    const first = await savePilotRequest(db, parsed.data);
    await db.query(
      `update pilot_requests set created_at = now() - interval '1 hour' where id = $1`,
      [first],
    );
    const second = await savePilotRequest(db, { ...parsed.data, company: 'Second (fictional)' });
    const rows = await listPilotRequests(db);
    expect(rows.map((r) => r.id)).toEqual([second, first]);
    expect(rows[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    expect(await setPilotStatus(db, first, 'contacted', 'founder@flow-e.test')).toBe(true);
    const marked = (await listPilotRequests(db)).find((r) => r.id === first);
    expect(marked).toMatchObject({ status: 'contacted', status_changed_by: 'founder@flow-e.test' });
    expect(marked?.status_changed_at).toMatch(/Z$/);
  });

  it('refuses unknown ids, malformed ids and statuses outside the list', async () => {
    expect(await setPilotStatus(db, '6f1b2c3d-0000-4000-8000-000000000000', 'contacted', 'x')).toBe(
      false,
    );
    expect(await setPilotStatus(db, "x' or '1'='1", 'contacted', 'x')).toBe(false);
    const parsed = parsePilotForm(form(VALID));
    if (parsed.kind !== 'ok') throw new Error('fixture');
    const id = await savePilotRequest(db, parsed.data);
    await expect(setPilotStatus(db, id, 'archived' as unknown as 'new', 'x')).rejects.toThrow();
  });

  it('has the same caps in the table as in the form', async () => {
    await expect(
      db.query(
        `insert into pilot_requests (id, name, email, company, role, size, buying)
         values (gen_random_uuid(), 'a', 'a@b.test', 'c', 'r', 'huge', 'b')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `insert into pilot_requests (id, name, email, company, role, size, buying)
         values (gen_random_uuid(), $1, 'a@b.test', 'c', 'r', '1-9', 'b')`,
        ['x'.repeat(PILOT_LIMITS.name + 1)],
      ),
    ).rejects.toThrow();
  });

  it('is locked like every other table: row-level security on, no policies', async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where relname = 'pilot_requests'`,
    );
    expect(rls[0]?.relrowsecurity).toBe(true);
    const policies = await db.query(`select 1 from pg_policies where tablename = 'pilot_requests'`);
    expect(policies).toHaveLength(0);
  });
});

describe('who may see pilot requests', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    FLOWE_ADMIN_EMAILS: ' Founder@Flow-E.test, second@flow-e.test ,,nonsense',
  };

  it('only signed-in people whose email is in FLOWE_ADMIN_EMAILS, case-insensitively', () => {
    expect(isPilotAdmin({ email: 'founder@flow-e.test' }, env)).toBe(true);
    expect(isPilotAdmin({ email: 'SECOND@flow-e.test' }, env)).toBe(true);
    expect(isPilotAdmin({ email: 'someone@flow-e.test' }, env)).toBe(false);
    expect(isPilotAdmin({ email: 'nonsense' }, env)).toBe(false);
    expect(isPilotAdmin(null, env)).toBe(false);
    expect(isPilotAdmin(undefined, env)).toBe(false);
    expect(isPilotAdmin({ email: '' }, env)).toBe(false);
  });

  it('lets nobody in when the variable is unset or empty', () => {
    expect(adminEmails({ NODE_ENV: 'test' }).size).toBe(0);
    expect(isPilotAdmin({ email: 'founder@flow-e.test' }, { NODE_ENV: 'test' })).toBe(false);
    expect(
      isPilotAdmin({ email: 'founder@flow-e.test' }, { NODE_ENV: 'test', FLOWE_ADMIN_EMAILS: '' }),
    ).toBe(false);
  });
});

describe('the preview password', () => {
  it('still guards the pilot form and the admin page', () => {
    expect(gateExempt('/api/pilot', 'POST', false)).toBe(false);
    expect(gateExempt('/admin/pilots', 'GET', false)).toBe(false);
    expect(gateExempt('/', 'GET', false)).toBe(false);
  });
});
