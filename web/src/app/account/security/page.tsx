import type { Metadata } from 'next';
import Link from 'next/link';
import QRCode from 'qrcode';
import { Logo } from '@/components/ui';
import { safeNext } from '@/lib/next-path';
import { requireUser } from '@/server/org-view';
import { ENROL_MESSAGE, SECURITY_PATH, getMfaStore } from '@/server/strong-session';
import { otpauthUri } from '@/server/totp';
import {
  cancelMfaSetupAction,
  confirmMfaAction,
  disableMfaAction,
  startMfaAction,
} from '../actions';
import { SecurityPanel } from '../client';

export const metadata: Metadata = { title: 'Security', robots: { index: false } };

function day(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

/** Set up, check or turn off the authenticator app (second factor). */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; required?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next, '/app');
  const user = await requireUser(
    `${SECURITY_PATH}${params.next ? `?next=${encodeURIComponent(next)}` : ''}`,
  );
  const mfa = await getMfaStore();
  const status = await mfa.status(user.userId);
  const secret = status.pending ? await mfa.pendingSecret(user.userId) : null;
  // Rendered here as an SVG string: no script, nothing loaded from elsewhere (CSP-safe).
  const qrSvg = secret
    ? await QRCode.toString(otpauthUri(secret, user.email), {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#ffffff' },
      })
    : null;

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-lg">
        <Link href="/app" aria-label="Flow-E" className="rounded-md">
          <Logo />
        </Link>
        <h1 className="mt-8 font-serif text-3xl tracking-[-0.015em]">Authenticator app</h1>
        <p className="mt-2 text-ink-2">A second step after signing in, for {user.email}.</p>
        {params.required === '1' && !status.enabled ? (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-review/40 bg-review-soft px-4 py-3 text-sm text-ink"
          >
            {ENROL_MESSAGE}
          </p>
        ) : null}
        <div className="mt-6 rounded-xl border border-rule bg-surface px-4 py-5 sm:px-6">
          <SecurityPanel
            status={status.enabled ? 'on' : status.pending ? 'pending' : 'off'}
            secret={secret}
            qrSvg={qrSvg}
            enabledAt={status.enabledAt ? day(status.enabledAt) : null}
            recoveryLeft={status.recoveryCodesLeft}
            next={next}
            start={startMfaAction}
            cancel={cancelMfaSetupAction}
            confirm={confirmMfaAction}
            disable={disableMfaAction}
          />
        </div>
        <p className="mt-6 text-sm">
          <Link href={next} className="text-accent underline">
            Back
          </Link>
        </p>
      </div>
    </main>
  );
}
