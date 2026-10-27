import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from './db';
import type { EmailMessage, Mailer } from './email';
import {
  HONEYPOT_FIELD,
  PILOT_LIMITS,
  PILOT_SIZES,
  type PilotSize,
  type PilotStatus,
} from '@/lib/pilot-fields';
import { RateLimiter } from './rate-limit';

/**
 * Pilot requests: the form on the home page posts to /api/pilot (a route handler, so it works
 * without JavaScript and never dispatches a Server Action). Every field is capped and validated,
 * a hidden honeypot field catches simple bots, each client address may send only a few per
 * window, and the content is never logged. The founder is emailed when FLOWE_LEADS_TO is set;
 * a failed email never fails the request. /admin/pilots lists them for FLOWE_ADMIN_EMAILS.
 */

export {
  HONEYPOT_FIELD,
  PILOT_LIMITS,
  PILOT_SIZES,
  PILOT_STATUSES,
  type PilotSize,
  type PilotStatus,
} from '@/lib/pilot-fields';

/** Larger bodies are refused before parsing. Well above the sum of the field caps. */
export const MAX_PILOT_BODY_BYTES = 16 * 1024;
/** Per client address, and for the whole server instance. */
export const PILOT_PER_CLIENT = 5;
export const PILOT_PER_CLIENT_WINDOW_MS = 10 * 60_000;
export const PILOT_GLOBAL_PER_HOUR = 120;

/** Collapses control characters (except line breaks in long text) and trims. */
function clean(multiline: boolean) {
  return (v: unknown) => {
    if (typeof v !== 'string') return v;
    const s = v.replace(/\r\n?/g, '\n');
    return (
      multiline
        ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
        : s.replace(/[\u0000-\u001F\u007F]/g, ' ')
    ).trim();
  };
}

const line = (max: number, what: string) =>
  z.preprocess(
    clean(false),
    z
      .string({ error: `Enter your ${what}.` })
      .min(1, `Enter your ${what}.`)
      .max(max, `Keep the ${what} under ${String(max)} characters.`),
  );

const optional = (max: number, multiline: boolean, what: string) =>
  z.preprocess(
    (v) => {
      const c = clean(multiline)(v);
      return c === '' || c === undefined || c === null ? null : c;
    },
    z
      .string()
      .max(max, `Keep the ${what} under ${String(max)} characters.`)
      .nullable(),
  );

export const pilotSchema = z.object({
  name: line(PILOT_LIMITS.name, 'name'),
  email: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
    z
      .string({ error: 'Enter your work email.' })
      .max(PILOT_LIMITS.email, 'That email address is too long.')
      .pipe(z.email('Enter a valid work email.')),
  ),
  company: line(PILOT_LIMITS.company, 'company'),
  role: line(PILOT_LIMITS.role, 'role'),
  size: z.enum(
    PILOT_SIZES.map((s) => s.value) as [PilotSize, ...PilotSize[]],
    'Choose the company size.',
  ),
  buying: z.preprocess(
    clean(true),
    z
      .string({ error: 'Tell us what your agents should buy.' })
      .min(1, 'Tell us what your agents should buy.')
      .max(PILOT_LIMITS.buying, `Keep it under ${String(PILOT_LIMITS.buying)} characters.`),
  ),
  country: optional(PILOT_LIMITS.country, false, 'country'),
  message: optional(PILOT_LIMITS.message, true, 'message'),
});

export type PilotInput = z.infer<typeof pilotSchema>;

export type PilotParse =
  { kind: 'ok'; data: PilotInput } | { kind: 'bot' } | { kind: 'invalid'; errors: string[] };

/** Read the form: the honeypot first, then the schema. Unknown fields are ignored. */
export function parsePilotForm(form: FormData): PilotParse {
  const trap = form.get(HONEYPOT_FIELD);
  if (typeof trap === 'string' && trap.trim() !== '') return { kind: 'bot' };
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(PILOT_LIMITS).concat('size')) {
    const v = form.get(key);
    raw[key] = typeof v === 'string' ? v : undefined;
  }
  const parsed = pilotSchema.safeParse(raw);
  if (!parsed.success)
    return { kind: 'invalid', errors: parsed.error.issues.map((i) => i.message) };
  return { kind: 'ok', data: parsed.data };
}

// Storage ---------------------------------------------------------------------------------------

export interface PilotRequest extends PilotInput {
  id: string;
  created_at: string;
  status: PilotStatus;
  status_changed_at: string | null;
  status_changed_by: string | null;
}

export async function savePilotRequest(sql: Sql, data: PilotInput): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `insert into pilot_requests (id, name, email, company, role, size, buying, country, message)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      data.name,
      data.email,
      data.company,
      data.role,
      data.size,
      data.buying,
      data.country,
      data.message,
    ],
  );
  return id;
}

/** A timestamp column as ISO 8601 in UTC, so Date.parse reads it the same everywhere. */
const iso = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export async function listPilotRequests(sql: Sql, limit = 200): Promise<PilotRequest[]> {
  return sql.query<PilotRequest>(
    `select id, ${iso('created_at')} as created_at, name, email, company, role, size, buying,
            country, message, status, ${iso('status_changed_at')} as status_changed_at,
            status_changed_by
       from pilot_requests order by created_at desc, id limit $1`,
    [limit],
  );
}

/** Mark a request; false when there is no such request. */
export async function setPilotStatus(
  sql: Sql,
  id: string,
  status: PilotStatus,
  by: string,
): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) return false;
  const rows = await sql.query<{ id: string }>(
    `update pilot_requests set status = $2, status_changed_at = now(), status_changed_by = $3
      where id = $1 returning id`,
    [id, status, by],
  );
  return rows.length === 1;
}

// Who may see them ------------------------------------------------------------------------------

/** FLOWE_ADMIN_EMAILS, comma-separated, compared case-insensitively. Empty means nobody. */
export function adminEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.FLOWE_ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@')),
  );
}

export function isPilotAdmin(
  session: { email: string } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!session?.email) return false;
  return adminEmails(env).has(session.email.trim().toLowerCase());
}

// Notification ----------------------------------------------------------------------------------

/** FLOWE_LEADS_TO when it is one valid address; otherwise null (no email is sent). */
export function leadsRecipient(env: NodeJS.ProcessEnv = process.env): string | null {
  const to = env.FLOWE_LEADS_TO?.trim();
  if (!to) return null;
  return z.email().safeParse(to).success ? to : null;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function pilotLeadEmail(
  to: string,
  data: PilotInput,
  adminUrl: string | null,
): EmailMessage {
  const size = PILOT_SIZES.find((s) => s.value === data.size)?.label ?? data.size;
  const rows: [string, string][] = [
    ['Name', data.name],
    ['Email', data.email],
    ['Company', data.company],
    ['Role', data.role],
    ['Size', size],
    ['Country', data.country ?? '–'],
    ['Agents should buy', data.buying],
    ['Message', data.message ?? '–'],
  ];
  const text = `${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${
    adminUrl ? `\nAll requests: ${adminUrl}\n` : ''
  }`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<p>New pilot request from the Flow-E site.</p>
<table style="border-collapse:collapse">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;vertical-align:top;color:#555">${escapeHtml(k)}</td><td style="padding:4px 0;white-space:pre-wrap">${escapeHtml(v)}</td></tr>`,
    )
    .join('')}</table>
${adminUrl ? `<p><a href="${escapeHtml(adminUrl)}">All requests</a></p>` : ''}
</body></html>`;
  // Subject lines are one line: the company name is already free of control characters.
  return {
    to,
    subject: `Pilot request: ${data.company.slice(0, 80)}`,
    text,
    html,
    kind: 'pilot',
  };
}

// HTTP ------------------------------------------------------------------------------------------

export interface PilotLimits {
  perClient: RateLimiter;
  global: RateLimiter;
}

export function newPilotLimits(clock?: () => number): PilotLimits {
  return {
    perClient: new RateLimiter(PILOT_PER_CLIENT, PILOT_PER_CLIENT_WINDOW_MS, clock),
    global: new RateLimiter(PILOT_GLOBAL_PER_HOUR, 60 * 60_000, clock),
  };
}

/** The client address as the hosting proxy reports it (Vercel sets both headers). */
export function clientKey(req: Request): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'unknown';
}

/** Read at most `limit` bytes of the body; null when it is larger. */
async function readBody(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > limit) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readForm(req: Request): Promise<FormData | null> {
  const type = req.headers.get('content-type') ?? '';
  if (
    !type.startsWith('application/x-www-form-urlencoded') &&
    !type.startsWith('multipart/form-data')
  ) {
    return null;
  }
  const body = await readBody(req, MAX_PILOT_BODY_BYTES);
  if (body === null) return null;
  try {
    return await new Response(body, { headers: { 'content-type': type } }).formData();
  } catch {
    return null;
  }
}

export type PilotOutcome = 'sent' | 'error' | 'limited';

function back(req: Request, outcome: PilotOutcome, retryAfterS?: number): Response {
  const headers: Record<string, string> = {
    location: new URL(`/?pilot=${outcome}#pilot`, req.url).toString(),
    'cache-control': 'no-store',
  };
  if (retryAfterS) headers['retry-after'] = String(retryAfterS);
  return new Response(null, { status: 303, headers });
}

export interface PilotDeps {
  sql: Sql;
  limits: PilotLimits;
  /** Created only when there is someone to notify. */
  mailer: () => Mailer;
  env?: NodeJS.ProcessEnv;
  /** The site's origin for the admin link in the email; null leaves the link out. */
  origin?: string | null;
}

/**
 * POST /api/pilot with the form. Always answers 303 back to the form: ?pilot=sent, error or
 * limited. A bot that fills the honeypot is told "sent" and nothing is stored or emailed.
 */
export async function handlePilot(req: Request, deps: PilotDeps): Promise<Response> {
  // A form posted from another site is not ours to accept.
  if (req.headers.get('sec-fetch-site') === 'cross-site') return back(req, 'error');

  const mine = deps.limits.perClient.take(clientKey(req));
  const all = mine.ok ? deps.limits.global.take('*') : mine;
  if (!mine.ok || !all.ok) {
    return back(req, 'limited', Math.max(mine.retryAfterS, all.retryAfterS));
  }

  const form = await readForm(req);
  if (!form) return back(req, 'error');
  const parsed = parsePilotForm(form);
  if (parsed.kind === 'bot') return back(req, 'sent');
  if (parsed.kind === 'invalid') return back(req, 'error');

  try {
    await savePilotRequest(deps.sql, parsed.data);
  } catch (err) {
    // Never the content: only what went wrong.
    console.error('pilot request not stored', err instanceof Error ? err.name : 'unknown');
    return back(req, 'error');
  }

  const to = leadsRecipient(deps.env);
  if (to) {
    try {
      const adminUrl = deps.origin ? `${deps.origin}/admin/pilots` : null;
      await deps.mailer().send(pilotLeadEmail(to, parsed.data, adminUrl));
    } catch (err) {
      console.error('pilot notification not sent', err instanceof Error ? err.name : 'unknown');
    }
  }
  return back(req, 'sent');
}
