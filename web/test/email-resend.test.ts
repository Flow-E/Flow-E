import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmailSendError,
  MailerConfigError,
  RESEND_ENDPOINT,
  ResendMailer,
  approvalEmail,
  mailerFromEnv,
} from '@/server/email';

const KEY = 're_test_0123456789abcdef';
const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  RESEND_API_KEY: KEY,
  EMAIL_FROM: 'Flow-E <approvals@example.com>',
};
const sql = { query: () => Promise.resolve([]) };

const message = approvalEmail({
  to: 'alice@example.com',
  orgName: 'Example Org (fictional)',
  agent: 'buyer-bot',
  supplier: 'Paper Supplies Ltd (fictional)',
  amount: 'EUR 600.00',
  reason: 'over the approval threshold',
  paymentId: 'pay_1',
  approveLink: 'https://site.example/approve/tok_secret_approve',
  declineLink: 'https://site.example/approve/tok_secret_decline',
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('choosing a mailer', () => {
  it('uses Resend when RESEND_API_KEY and EMAIL_FROM are both set, in any environment', () => {
    expect(mailerFromEnv(sql, ENV).name).toBe('resend');
    expect(mailerFromEnv(sql, { ...ENV, NODE_ENV: 'development' }).name).toBe('resend');
  });

  it('refuses when only one of the two is set, and never falls back to the outbox', () => {
    for (const NODE_ENV of ['production', 'development'] as const) {
      expect(mailerFromEnv(sql, { NODE_ENV, RESEND_API_KEY: KEY }).name).toBe('disabled');
      expect(mailerFromEnv(sql, { NODE_ENV, EMAIL_FROM: ENV.EMAIL_FROM }).name).toBe('disabled');
    }
  });

  it('keeps the outbox in development and refuses in production when nothing is set', () => {
    expect(mailerFromEnv(sql, { NODE_ENV: 'development' }).name).toBe('outbox');
    expect(mailerFromEnv(sql, { NODE_ENV: 'production' }).name).toBe('disabled');
  });

  it('the Resend mailer itself needs both values', () => {
    expect(() => new ResendMailer({ NODE_ENV: 'production', RESEND_API_KEY: KEY })).toThrow(
      MailerConfigError,
    );
    expect(() => new ResendMailer({ ...ENV, RESEND_API_KEY: ' ' })).toThrow(MailerConfigError);
  });
});

describe('sending through Resend', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts one JSON message with the Bearer key and a timeout', async () => {
    fetchMock.mockResolvedValue(json(200, { id: 'email_1' }));
    await new ResendMailer(ENV).send(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init?.body as string)).toEqual({
      from: ENV.EMAIL_FROM,
      to: ['alice@example.com'],
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  });

  it.each([
    [403, 'The example.com domain is not verified.'],
    [422, 'Invalid `to` field.'],
    [500, 'Internal server error.'],
  ])('throws on HTTP %i with the status and Resend’s message', async (status, msg) => {
    fetchMock.mockResolvedValue(json(status, { statusCode: status, name: 'x', message: msg }));
    const err = await new ResendMailer(ENV).send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    const text = (err as Error).message;
    expect(text).toContain(`HTTP ${status}`);
    expect(text).toContain(msg);
    expect(text).not.toContain(KEY);
  });

  it('never puts the key or the one-time links in the error or the log', async () => {
    fetchMock.mockResolvedValue(json(401, { message: `API key ${KEY} is invalid` }));
    const err = await new ResendMailer(ENV).send(message).catch((e: unknown) => e);
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    for (const text of [(err as Error).message, logged]) {
      expect(text).toContain('HTTP 401');
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('tok_secret');
    }
  });

  it('copes with a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));
    await expect(new ResendMailer(ENV).send(message)).rejects.toThrow(
      'Resend refused the email (HTTP 502).',
    );
  });

  it('reports a timeout or network failure without details', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(new ResendMailer(ENV).send(message)).rejects.toThrow('Resend timed out.');
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${KEY}`));
    const err = await new ResendMailer(ENV).send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as Error).message).toBe('Resend could not be reached.');
  });
});
