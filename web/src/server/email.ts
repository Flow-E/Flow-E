import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Sql } from './db';

/**
 * Outgoing email as an adapter. Every message is plain text plus a simple HTML version with no
 * images, tracking pixels or remote content.
 *
 * - `OutboxMailer` (development): stores messages in the email_outbox table; /dev/outbox shows
 *   them. Refuses to run when NODE_ENV is production, so links never sit in a database there.
 * - `ResendMailer`: real delivery through the Resend HTTP API (RESEND_API_KEY, EMAIL_FROM).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** "invitation" or "approval", for the outbox list. */
  kind: string;
}

export interface Mailer {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

export class MailerConfigError extends Error {
  override name = 'MailerConfigError';
}

export class OutboxMailer implements Mailer {
  readonly name = 'outbox';

  constructor(
    private readonly sql: Sql,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    if (env.NODE_ENV === 'production') {
      throw new MailerConfigError('The development outbox cannot be used in production.');
    }
  }

  async send(m: EmailMessage): Promise<void> {
    await this.sql.query(
      `insert into email_outbox (id, to_email, subject, body_text, body_html, kind)
       values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), m.to, m.subject, m.text, m.html, m.kind],
    );
  }
}

export class EmailSendError extends Error {
  override name = 'EmailSendError';
}

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10_000;

/**
 * Sends through Resend (https://resend.com): one POST per message, 10 second timeout. Errors
 * carry the HTTP status and Resend's own message, never the API key or the email body (bodies
 * hold one-time links).
 */
export class ResendMailer implements Mailer {
  readonly name = 'resend';
  readonly from: string;
  readonly #apiKey: string;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    const apiKey = env.RESEND_API_KEY?.trim();
    const from = env.EMAIL_FROM?.trim();
    if (!apiKey || !from) {
      throw new MailerConfigError('RESEND_API_KEY and EMAIL_FROM must both be set to send email.');
    }
    this.#apiKey = apiKey;
    this.from = from;
  }

  async send(m: EmailMessage): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [m.to],
          subject: m.subject,
          text: m.text,
          html: m.html,
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
    } catch (err) {
      const why =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'timed out'
          : 'could not be reached';
      throw new EmailSendError(`Resend ${why}.`);
    }
    if (res.ok) return;
    const detail = (await resendErrorMessage(res)).replaceAll(this.#apiKey, '[redacted]');
    const text = `Resend refused the email (HTTP ${res.status}${detail ? `: ${detail}` : ''}).`;
    // The caller logs only the error name; this says why, without the key or the body.
    console.error('email not sent:', text);
    throw new EmailSendError(text);
  }
}

/** Resend answers errors as `{ statusCode, name, message }`. Only the message, kept short. */
async function resendErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      return body.message.slice(0, 300);
    }
  } catch {
    // Not JSON: the status alone has to do.
  }
  return '';
}

/** Production without email configured: every send fails (and is logged), nothing is stored. */
export class DisabledMailer implements Mailer {
  readonly name = 'disabled';

  send(_message: EmailMessage): Promise<void> {
    return Promise.reject(new MailerConfigError('Email is not configured on this server.'));
  }
}

/**
 * The mailer for this environment: Resend when RESEND_API_KEY and EMAIL_FROM are set, the outbox
 * outside production, and otherwise a mailer that refuses. Setting only one of the two refuses
 * too, rather than quietly falling back to the outbox. Never throws here, so a missing email
 * setup cannot take the rest of the site (the sandbox) down.
 */
export function mailerFromEnv(sql: Sql, env: NodeJS.ProcessEnv = process.env): Mailer {
  if (env.RESEND_API_KEY || env.EMAIL_FROM) {
    try {
      return new ResendMailer(env);
    } catch {
      return new DisabledMailer();
    }
  }
  if (env.NODE_ENV === 'production') return new DisabledMailer();
  return new OutboxMailer(sql, env);
}

/** Whether /dev/outbox may be shown. */
export function outboxVisible(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.FLOWE_DEV_LOGIN === '1';
}

export interface OutboxMessage {
  id: string;
  to_email: string;
  subject: string;
  body_text: string;
  body_html: string;
  kind: string;
  created_at: string;
}

export async function readOutbox(sql: Sql, limit = 50): Promise<OutboxMessage[]> {
  return sql.query<OutboxMessage>(
    `select id, to_email, subject, body_text, body_html, kind, created_at::text as created_at
       from email_outbox order by created_at desc limit $1`,
    [limit],
  );
}

// Templates -------------------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function htmlPage(paragraphs: string[], links: { label: string; href: string }[]): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
  const buttons = links
    .map(
      (l) =>
        `<p><a href="${escapeHtml(l.href)}" style="display:inline-block;padding:10px 16px;border:1px solid #444;border-radius:6px;color:#111;text-decoration:none">${escapeHtml(l.label)}</a></p>`,
    )
    .join('\n');
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">\n${body}\n${buttons}\n<p style="color:#666;font-size:12px">Flow-E authorizes payments; it never moves money.</p>\n</body></html>`;
}

export function invitationEmail(input: {
  to: string;
  orgName: string;
  role: string;
  invitedBy: string;
  link: string;
  expiresAt: string;
}): EmailMessage {
  const lines = [
    `${input.invitedBy} invited you to join ${input.orgName} on Flow-E as ${input.role}.`,
    `Open the link and sign in as ${input.to} to accept. It works once and expires on ${input.expiresAt}.`,
    'If you did not expect this, ignore this email.',
  ];
  return {
    to: input.to,
    subject: `Join ${input.orgName} on Flow-E`,
    text: `${lines.join('\n\n')}\n\nAccept: ${input.link}\n`,
    html: htmlPage(lines, [{ label: 'Accept the invitation', href: input.link }]),
    kind: 'invitation',
  };
}

export function approvalEmail(input: {
  to: string;
  orgName: string;
  agent: string;
  supplier: string;
  amount: string;
  reason: string;
  paymentId: string;
  approveLink: string;
  declineLink: string;
}): EmailMessage {
  const lines = [
    `${input.agent} asks to pay ${input.amount} to ${input.supplier} (${input.orgName}).`,
    `Why it needs you: ${input.reason}`,
    `Payment ${input.paymentId}. Each link asks you to sign in and confirm; nothing happens when you only open it. The links work once and expire in 24 hours.`,
  ];
  return {
    to: input.to,
    subject: `Approval needed: ${input.amount} to ${input.supplier}`,
    text: `${lines.join('\n\n')}\n\nApprove: ${input.approveLink}\nDecline: ${input.declineLink}\n`,
    html: htmlPage(lines, [
      { label: 'Approve…', href: input.approveLink },
      { label: 'Decline…', href: input.declineLink },
    ]),
    kind: 'approval',
  };
}
