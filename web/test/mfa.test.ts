import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MfaError, MfaStore } from '@/server/mfa';
import { PERMISSIONS, type Permission } from '@/server/permissions';
import {
  MFA_MAX_AGE_MS,
  STRONG_PERMISSIONS,
  challengeUrl,
  enrolUrl,
  strongSessionNeed,
} from '@/server/strong-session';
import { totpCode } from '@/server/totp';
import { ALICE, BOB, CAROL, DAVE, world, type World } from './org-helpers';

const HOUR = 3_600_000;

describe('second factor storage', () => {
  let w: World;
  let mfa: MfaStore;
  beforeEach(async () => {
    w = await world();
    mfa = new MfaStore(w.db, randomBytes(32), { clock: () => w.clock.now });
  });
  afterEach(async () => {
    await w.close();
  });

  async function enrol(userId: string) {
    await mfa.begin(userId);
    const secret = (await mfa.pendingSecret(userId)) ?? '';
    const codes = await mfa.confirm(userId, totpCode(secret, w.clock.now));
    return { secret, codes };
  }

  it('is off until a set-up is confirmed with a first code; the secret is stored encrypted', async () => {
    expect(await mfa.status(BOB.userId)).toMatchObject({ enabled: false, pending: false });
    await mfa.begin(BOB.userId);
    expect(await mfa.status(BOB.userId)).toMatchObject({ enabled: false, pending: true });
    const secret = (await mfa.pendingSecret(BOB.userId)) ?? '';
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const dump = JSON.stringify(await w.db.query('select * from user_mfa'));
    expect(dump).not.toContain(secret);
    await expect(mfa.confirm(BOB.userId, '000000')).rejects.toThrow(MfaError);
    const codes = await mfa.confirm(BOB.userId, totpCode(secret, w.clock.now));
    expect(codes).toHaveLength(10);
    expect(await mfa.status(BOB.userId)).toMatchObject({
      enabled: true,
      pending: false,
      recoveryCodesLeft: 10,
    });
    expect(await mfa.pendingSecret(BOB.userId)).toBeNull();
    const after = JSON.stringify(await w.db.query('select * from user_mfa'));
    for (const c of codes) expect(after).not.toContain(c);
    await expect(mfa.begin(BOB.userId)).rejects.toThrow('already set up');
  });

  it('refuses a replayed code, and the code used to set it up', async () => {
    const { secret } = await enrol(BOB.userId);
    // The set-up code was for this step; it does not work again.
    expect(await mfa.verify(BOB.userId, totpCode(secret, w.clock.now))).toBeNull();
    w.clock.now += 30_000;
    const code = totpCode(secret, w.clock.now);
    expect(await mfa.verify(BOB.userId, code)).toBe('app');
    expect(await mfa.verify(BOB.userId, code)).toBeNull();
    // An older code from inside the window is refused too once a newer one was used.
    w.clock.now += 30_000;
    expect(await mfa.verify(BOB.userId, totpCode(secret, w.clock.now - 30_000))).toBeNull();
    expect(await mfa.verify(BOB.userId, totpCode(secret, w.clock.now))).toBe('app');
  });

  it('accepts each recovery code once', async () => {
    const { codes } = await enrol(BOB.userId);
    const [first = '', second = ''] = codes;
    expect(await mfa.verify(BOB.userId, first.toUpperCase())).toBe('recovery');
    expect(await mfa.verify(BOB.userId, first)).toBeNull();
    expect((await mfa.status(BOB.userId)).recoveryCodesLeft).toBe(9);
    expect(await mfa.verify(BOB.userId, 'aaaaa-aaaaa')).toBeNull();
    // Another person's recovery code does nothing for Bob.
    const alice = await enrol(ALICE.userId);
    expect(await mfa.verify(BOB.userId, alice.codes[0] ?? '')).toBeNull();
    expect(await mfa.verify(BOB.userId, second)).toBe('recovery');
  });

  it('turns off only with a current code (or a recovery code)', async () => {
    const { secret } = await enrol(BOB.userId);
    await expect(mfa.disable(BOB.userId, '123456')).rejects.toThrow(MfaError);
    expect(await mfa.isEnabled(BOB.userId)).toBe(true);
    w.clock.now += 30_000;
    await mfa.disable(BOB.userId, totpCode(secret, w.clock.now));
    expect(await mfa.isEnabled(BOB.userId)).toBe(false);
    expect(await w.db.query('select * from user_mfa')).toHaveLength(0);
  });

  it('a person without a set-up never verifies', async () => {
    expect(await mfa.verify(DAVE.userId, '123456')).toBeNull();
    await mfa.begin(DAVE.userId);
    const secret = (await mfa.pendingSecret(DAVE.userId)) ?? '';
    // Pending is not enabled: codes do not count yet.
    expect(await mfa.verify(DAVE.userId, totpCode(secret, w.clock.now))).toBeNull();
    await mfa.cancelPending(DAVE.userId);
    expect(await mfa.status(DAVE.userId)).toMatchObject({ enabled: false, pending: false });
  });
});

describe('who needs a second factor', () => {
  let w: World;
  let mfa: MfaStore;
  beforeEach(async () => {
    w = await world();
    mfa = new MfaStore(w.db, randomBytes(32), { clock: () => w.clock.now });
  });
  afterEach(async () => {
    await w.close();
  });

  async function need(
    user: typeof BOB,
    permission: Permission,
    mfaAt: number | undefined,
    scope: 'org' | 'sandbox' = 'org',
  ) {
    return strongSessionNeed({
      role: await w.store.role(w.orgId, user),
      permission,
      scope,
      enrolled: await mfa.isEnabled(user.userId),
      mfaAt,
      now: w.clock.now,
    });
  }

  it('an approver without an authenticator app is sent to set one up', async () => {
    expect(await need(BOB, 'payment.resolve', undefined)).toBe('enrol');
    expect(await need(BOB, 'killswitch.set', undefined)).toBe('enrol');
    expect(await need(ALICE, 'mandate.update', undefined)).toBe('enrol');
    expect(await need(ALICE, 'agent.keys', undefined)).toBe('enrol');
    expect(await need(ALICE, 'member.manage', undefined)).toBe('enrol');
  });

  it('an enrolled approver must enter a code each session, and again after 12 hours', async () => {
    await mfa.begin(BOB.userId);
    const secret = (await mfa.pendingSecret(BOB.userId)) ?? '';
    await mfa.confirm(BOB.userId, totpCode(secret, w.clock.now));
    expect(await need(BOB, 'payment.resolve', undefined)).toBe('challenge');
    expect(await need(BOB, 'payment.resolve', w.clock.now - HOUR)).toBe('ok');
    expect(await need(BOB, 'payment.resolve', w.clock.now - MFA_MAX_AGE_MS)).toBe('challenge');
    // A verification time from the future is not trusted.
    expect(await need(BOB, 'payment.resolve', w.clock.now + HOUR)).toBe('challenge');
  });

  it('viewers are never asked (they cannot act), nor is anyone in the sandbox', async () => {
    for (const p of STRONG_PERMISSIONS) {
      expect(await need(CAROL, p, undefined)).toBe('ok');
      expect(await need(BOB, p, undefined, 'sandbox')).toBe('ok');
      expect(await need(DAVE, p, undefined)).toBe('ok'); // not a member: the store refuses
    }
    // Reading and day-to-day work outside the list need no code.
    expect(await need(BOB, 'org.read', undefined)).toBe('ok');
    expect(await need(BOB, 'payment.fulfil', undefined)).toBe('ok');
  });

  it('covers exactly the founder’s list, each for owners or approvers', () => {
    expect([...STRONG_PERMISSIONS].sort()).toEqual(
      [
        'agent.create',
        'agent.keys',
        'killswitch.set',
        'mandate.update',
        'member.invite',
        'member.manage',
        'payment.resolve',
      ].sort(),
    );
    for (const p of STRONG_PERMISSIONS) expect(PERMISSIONS[p]).not.toContain('viewer');
  });

  it('redirects only to our own pages', () => {
    expect(enrolUrl('/app/x/payments/y')).toBe(
      '/account/security?required=1&next=%2Fapp%2Fx%2Fpayments%2Fy',
    );
    expect(challengeUrl('https://evil.example')).toBe('/account/verify?next=%2Fapp');
    expect(challengeUrl('//evil.example')).toBe('/account/verify?next=%2Fapp');
    expect(challengeUrl('/approve/abc_-1')).toBe('/account/verify?next=%2Fapprove%2Fabc_-1');
  });

  it('every organisation action that needs it calls the check (source guard)', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/app/app/actions.ts'), 'utf8');
    const body = (name: string) => {
      const start = src.indexOf(`export async function ${name}(`);
      const end = src.indexOf('\nexport async function', start + 1);
      return src.slice(start, end === -1 ? undefined : end);
    };
    const expected: Record<string, Permission> = {
      resolveAction: 'payment.resolve',
      killSwitchAction: 'killswitch.set',
      updateMandateAction: 'mandate.update',
      createAgentAction: 'agent.create',
      createKeyAction: 'agent.keys',
      rotateKeyAction: 'agent.keys',
      revokeKeyAction: 'agent.keys',
      inviteAction: 'member.invite',
      revokeInvitationAction: 'member.invite',
      changeRoleAction: 'member.manage',
      removeMemberAction: 'member.manage',
    };
    for (const [name, permission] of Object.entries(expected)) {
      expect(body(name), name).toContain(`await strong(store, user, orgId, '${permission}')`);
    }
    expect(body('confirmApprovalAction')).toMatch(
      /requireStrongSession\([\s\S]*'payment\.resolve'/,
    );
    // The sandbox actions never ask for a code.
    const sandbox = readFileSync(path.resolve(__dirname, '../src/app/sandbox/actions.ts'), 'utf8');
    expect(sandbox).not.toContain('requireStrongSession');
  });
});
