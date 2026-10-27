import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeNext } from '@/lib/next-path';
import { encryptionKeyFromEnv } from './keys';
import { MfaStore } from './mfa';
import type { User } from './org-store';
import { can, type Permission, type Role } from './permissions';
import { getDb } from './runtime';
import { getSession } from './session';

/**
 * The one place that decides when an owner or approver must have passed the second factor
 * (authenticator app) in this session: approving or declining, changing the mandate, managing
 * agents' keys, managing members, and the kill switch. Viewers never need it (they cannot do
 * these things), and neither does the sandbox (fictional data, nothing to protect).
 */

/** Permissions that need a second factor. Everything else does not. */
export const STRONG_PERMISSIONS: readonly Permission[] = [
  'payment.resolve',
  'mandate.update',
  'agent.create',
  'agent.keys',
  'member.invite',
  'member.manage',
  'killswitch.set',
];

/** A passed second factor counts for this long (sessions last 12 hours too). */
export const MFA_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const SECURITY_PATH = '/account/security';
export const CHALLENGE_PATH = '/account/verify';

/** ok: go ahead · enrol: set up an authenticator app first · challenge: enter a code first. */
export type StrongNeed = 'ok' | 'enrol' | 'challenge';

export interface StrongInput {
  /** The person's role in the organisation, from the database; null when not a member. */
  role: Role | null | undefined;
  permission: Permission;
  /** The sandbox is always exempt. */
  scope: 'org' | 'sandbox';
  enrolled: boolean;
  /** When this session last passed the second factor (ms), if it has. */
  mfaAt: number | undefined;
  now: number;
}

/** Pure decision: what this person must do before the action. */
export function strongSessionNeed(i: StrongInput): StrongNeed {
  if (i.scope === 'sandbox') return 'ok';
  if (!STRONG_PERMISSIONS.includes(i.permission)) return 'ok';
  // Without the role the store refuses anyway, with the usual message.
  if (!can(i.role, i.permission)) return 'ok';
  if (!i.enrolled) return 'enrol';
  if (i.mfaAt === undefined) return 'challenge';
  // A time in the future (beyond small clock skew) is not trusted either.
  if (i.mfaAt > i.now + 60_000 || i.now - i.mfaAt >= MFA_MAX_AGE_MS) return 'challenge';
  return 'ok';
}

export const ENROL_MESSAGE = 'Set up an authenticator app before you approve payments.';

export function enrolUrl(next: string): string {
  return `${SECURITY_PATH}?required=1&next=${encodeURIComponent(safeNext(next, '/app'))}`;
}

export function challengeUrl(next: string): string {
  return `${CHALLENGE_PATH}?next=${encodeURIComponent(safeNext(next, '/app'))}`;
}

const globalForMfa = globalThis as unknown as { floweMfa?: Promise<MfaStore> };

/** One MFA store per server process, on the shared database. */
export function getMfaStore(): Promise<MfaStore> {
  globalForMfa.floweMfa ??= getDb()
    .then((db) => new MfaStore(db, encryptionKeyFromEnv()))
    .catch((err: unknown) => {
      globalForMfa.floweMfa = undefined;
      throw err;
    });
  return globalForMfa.floweMfa;
}

/** Where the person came from (same site only), to come back after the code. */
export async function returnPath(fallback: string): Promise<string> {
  const h = await headers();
  const referer = h.get('referer');
  if (!referer) return safeNext(fallback, '/app');
  try {
    const url = new URL(referer);
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (host && url.host !== host) return safeNext(fallback, '/app');
    return safeNext(`${url.pathname}${url.search}`, safeNext(fallback, '/app'));
  } catch {
    return safeNext(fallback, '/app');
  }
}

/**
 * Call before an organisation action that needs owner or approver rights. Redirects to set up
 * an authenticator app, or to enter a code and come back to `next`; returns when all is well.
 * Never call it for the sandbox.
 */
export async function requireStrongSession(
  user: User,
  role: Role | null | undefined,
  permission: Permission,
  next: string,
): Promise<void> {
  if (!STRONG_PERMISSIONS.includes(permission) || !can(role, permission)) return;
  const session = await getSession();
  const enrolled = await (await getMfaStore()).isEnabled(user.userId);
  const need = strongSessionNeed({
    role,
    permission,
    scope: 'org',
    enrolled,
    // Only a session of this very user counts.
    mfaAt: session?.userId === user.userId ? session.mfaAt : undefined,
    now: Date.now(),
  });
  if (need === 'enrol') redirect(enrolUrl(next));
  if (need === 'challenge') redirect(challengeUrl(next));
}

/**
 * Where to go right after signing in: people with an authenticator app enter a code first,
 * then continue to `next`. If the lookup fails, straight to `next`; the actions still check.
 */
export async function afterSignIn(userId: string, next: string): Promise<string> {
  // The sandbox never asks for a code.
  if (next === '/sandbox' || next.startsWith('/sandbox/') || next.startsWith('/sandbox?')) {
    return next;
  }
  try {
    if (await (await getMfaStore()).isEnabled(userId)) return challengeUrl(next);
  } catch {
    // fall through: enforcement happens at each protected action anyway
  }
  return next;
}
