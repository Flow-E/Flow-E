import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Sql } from './db';

/**
 * Outgoing email as an adapter. Every message is plain text plus a simple HTML version with no
 * images, tracking pixels or remote content.
 *
 * - `OutboxMailer` (development): stores messages in the email_outbox table; /dev/outbox shows
 *   them. Refuses to run when NODE_ENV is production, so links never sit in a database there.
 * - `SmtpMailer`: the shape for a real provider (EMAIL_FROM, SMTP_URL). Not wired yet: sending
 *   throws until a transport is added and reviewed.
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

export class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  readonly from: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (!env.EMAIL_FROM || !env.SMTP_URL) {
      throw new MailerConfigError('EMAIL_FROM and SMTP_URL must both be set to send email.');
    }
    this.from = env.EMAIL_FROM;
  }

  send(_message: EmailMessage): Promise<void> {
    return Promise.reject(
      new MailerConfigError('SMTP sending is not wired yet; see web/README.md.'),
    );
  }
}

/** Production without email configured: every send fails (and is logged), nothing is stored. */
export class DisabledMailer implements Mailer {
  readonly name = 'disabled';

  send(_message: EmailMessage): Promise<void> {
    return Promise.reject(new MailerConfigError('Email is not configured on this server.'));
  }
}

/**
 * The mailer for this environment: SMTP when configured, the outbox outside production, and
 * otherwise a mailer that refuses. Never throws here, so a missing email setup cannot take the
 * rest of the site (the sandbox) down.
 */
export function mailerFromEnv(sql: Sql, env: NodeJS.ProcessEnv = process.env): Mailer {
  if (env.SMTP_URL || env.EMAIL_FROM) {
    try {
      return new SmtpMailer(env);
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
