import 'server-only';
import type { Db, Sql } from './db';
import { decryptSecret, encryptSecret } from './keys';
import {
  cleanCode,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  normaliseRecoveryCode,
  verifyTotp,
} from './totp';

/**
 * Second factor storage (table user_mfa, migration 005). The TOTP secret is encrypted with the
 * same key-encryption key as issuer keys; recovery codes are kept only as SHA-256 hashes and
 * each works once. Never log a secret, a code or a recovery code.
 */

export class MfaError extends Error {
  override name = 'MfaError';
}

export interface MfaStatus {
  /** Set up and confirmed with a first code. */
  enabled: boolean;
  /** Set-up started but not yet confirmed. */
  pending: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

interface Row {
  secret_enc: string;
  enabled_at: string | null;
  last_step: string | null;
  recovery_hashes: unknown;
}

function hashesOf(value: unknown): string[] {
  const v = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
}

const BAD_CODE = 'That code did not work. Check the time on your phone and try the newest code.';

export class MfaStore {
  private readonly clock: () => number;

  constructor(
    private readonly db: Db,
    private readonly encryptionKey: Buffer,
    opts: { clock?: () => number } = {},
  ) {
    this.clock = opts.clock ?? Date.now;
  }

  private async row(sql: Sql, userId: string, forUpdate = false): Promise<Row | null> {
    const rows = await sql.query<Row>(
      `select secret_enc,
              to_char(enabled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as enabled_at,
              last_step::text as last_step, recovery_hashes
         from user_mfa where user_id = $1${forUpdate ? ' for update' : ''}`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async status(userId: string): Promise<MfaStatus> {
    const r = await this.row(this.db, userId);
    return {
      enabled: r?.enabled_at != null,
      pending: r !== null && r.enabled_at == null,
      enabledAt: r?.enabled_at ?? null,
      recoveryCodesLeft: r ? hashesOf(r.recovery_hashes).length : 0,
    };
  }

  async isEnabled(userId: string): Promise<boolean> {
    return (await this.status(userId)).enabled;
  }

  /** Start (or restart) a set-up: a new secret, not yet active. Refused once enabled. */
  async begin(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const r = await this.row(tx, userId, true);
      if (r?.enabled_at != null) {
        throw new MfaError('An authenticator app is already set up. Turn it off first.');
      }
      const sealed = encryptSecret(newTotpSecret(), this.encryptionKey);
      await tx.query(
        `insert into user_mfa (user_id, secret_enc, created_at)
         values ($1, $2, $3::timestamptz)
         on conflict (user_id) do update
           set secret_enc = excluded.secret_enc, enabled_at = null, last_step = null,
               recovery_hashes = '[]'::jsonb, created_at = excluded.created_at`,
        [userId, sealed, new Date(this.clock()).toISOString()],
      );
    });
  }

  /** The secret of a set-up that is not confirmed yet, to show as text and QR code. */
  async pendingSecret(userId: string): Promise<string | null> {
    const r = await this.row(this.db, userId);
    if (!r || r.enabled_at != null) return null;
    return decryptSecret(r.secret_enc, this.encryptionKey);
  }

  /**
   * Confirm a set-up with the first code from the app. Returns the recovery codes: the only
   * time they exist in plain text.
   */
  async confirm(userId: string, code: string): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const r = await this.row(tx, userId, true);
      if (!r) throw new MfaError('Start the set-up first.');
      if (r.enabled_at != null) throw new MfaError('An authenticator app is already set up.');
      const step = verifyTotp(decryptSecret(r.secret_enc, this.encryptionKey), code, this.clock());
      if (step === null) throw new MfaError(BAD_CODE);
      const codes = newRecoveryCodes();
      await tx.query(
        `update user_mfa set enabled_at = $2::timestamptz, last_step = $3,
                recovery_hashes = $4::jsonb
          where user_id = $1`,
        [
          userId,
          new Date(this.clock()).toISOString(),
          step,
          JSON.stringify(codes.map(hashRecoveryCode)),
        ],
      );
      return codes;
    });
  }

  /**
   * Check a code from the app, or a recovery code. A used app code (or an older one) and a
   * used recovery code are refused. Returns which kind matched, or null.
   */
  async verify(userId: string, input: string): Promise<'app' | 'recovery' | null> {
    return this.db.transaction(async (tx) => {
      const r = await this.row(tx, userId, true);
      if (!r || r.enabled_at == null) return null;
      const now = this.clock();
      const digits = cleanCode(input);
      if (/^\d{6}$/.test(digits)) {
        const last = r.last_step === null ? null : Number(r.last_step);
        const step = verifyTotp(decryptSecret(r.secret_enc, this.encryptionKey), digits, now, last);
        if (step === null) return null;
        await tx.query('update user_mfa set last_step = $2 where user_id = $1', [userId, step]);
        return 'app';
      }
      if (normaliseRecoveryCode(input).length !== 10) return null;
      const hash = hashRecoveryCode(input);
      const hashes = hashesOf(r.recovery_hashes);
      if (!hashes.includes(hash)) return null;
      await tx.query('update user_mfa set recovery_hashes = $2::jsonb where user_id = $1', [
        userId,
        JSON.stringify(hashes.filter((h) => h !== hash)),
      ]);
      return 'recovery';
    });
  }

  /** Turn the second factor off (a current code or a recovery code is required). */
  async disable(userId: string, code: string): Promise<void> {
    if ((await this.verify(userId, code)) === null) throw new MfaError(BAD_CODE);
    await this.db.query('delete from user_mfa where user_id = $1', [userId]);
  }

  /** Throw away a set-up that was started but never confirmed. */
  async cancelPending(userId: string): Promise<void> {
    await this.db.query('delete from user_mfa where user_id = $1 and enabled_at is null', [userId]);
  }
}
