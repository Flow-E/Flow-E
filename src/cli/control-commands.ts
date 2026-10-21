import { readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { ConfigError, parseConfig } from '../config/schema.js';
import {
  ActionError,
  cancelCoolingOff,
  resolvePayment,
  setAgentFrozen,
  setKillSwitch,
} from '../control/actions.js';
import { exportCsv } from '../control/csv.js';
import { formatMoney } from '../engine/money.js';
import { loadSigningIssuer } from '../kya/store.js';
import { Ledger, type PaymentRecord } from '../ledger/ledger.js';
import type { CommandResult } from './ledger-commands.js';

/** Human-owner commands. They need the issuer key, because every action is a signed entry. */

export function defaultActor(): string {
  try {
    return `${userInfo().username} (cli)`;
  } catch {
    return 'cli';
  }
}

function withLedger<T>(home: string, run: (ledger: Ledger) => T): T {
  const issuer = loadSigningIssuer(home);
  const ledger = Ledger.open(join(home, 'ledger.db'), {
    issuer: issuer.id,
    privateKey: issuer.privateKey,
  });
  try {
    return run(ledger);
  } finally {
    ledger.close();
  }
}

function describe(p: PaymentRecord): string {
  return `${formatMoney(p.request.amount, p.request.currency)} to ${p.request.merchant} (agent ${p.agentId})`;
}

interface ActionOptions {
  home: string;
  by: string;
  note?: string | undefined;
  now: number;
}

export function runResolve(
  o: ActionOptions & { id: string; status: 'approved' | 'declined' },
): CommandResult {
  return withLedger(o.home, (ledger) => {
    const p = resolvePayment(ledger, o.id, o.status, o);
    const verb = o.status === 'approved' ? 'Approved' : 'Declined';
    const cooling = p.cancellableUntil
      ? `\nFirst payment to this supplier: cancellable until ${p.cancellableUntil} (imprest cooloff-cancel ${p.paymentId}).`
      : '';
    return { ok: true, text: `${verb} ${p.paymentId}: ${describe(p)}.${cooling}` };
  });
}

export function runCooloffCancel(o: ActionOptions & { id: string }): CommandResult {
  return withLedger(o.home, (ledger) => {
    const p = cancelCoolingOff(ledger, o.id, o);
    return { ok: true, text: `Cancelled ${p.paymentId}: ${describe(p)}.` };
  });
}

export function runFreeze(
  o: ActionOptions & { config: string; agent?: string | undefined; all: boolean; frozen: boolean },
): CommandResult {
  const word = o.frozen ? 'frozen' : 'unfrozen';
  if (o.all === (o.agent !== undefined)) {
    throw new ActionError('Name one agent, or pass --all for the kill switch (not both).');
  }
  if (o.all) {
    return withLedger(o.home, (ledger) => {
      const changed = setKillSwitch(ledger, o.frozen, o);
      const state = o.frozen
        ? 'ON: every payment by every agent is declined'
        : 'OFF (agents frozen one by one stay frozen)';
      return {
        ok: true,
        text: `${changed ? 'Kill switch is now' : 'Kill switch was already'} ${state}.`,
      };
    });
  }
  const agent = o.agent ?? '';
  const config = parseConfig(readFileSync(o.config, 'utf8'));
  if (!config.agents[agent]) throw new ConfigError(`Agent "${agent}" is not in ${o.config}.`);
  return withLedger(o.home, (ledger) => {
    const changed = setAgentFrozen(ledger, agent, o.frozen, o);
    let text = changed
      ? `Agent "${agent}" is now ${word}.`
      : `Agent "${agent}" was already ${word}.`;
    if (!o.frozen && config.agents[agent]?.status !== 'active') {
      text += ` Note: mandate.yaml still sets it to "${config.agents[agent]?.status ?? ''}".`;
    }
    return { ok: true, text };
  });
}

export function runExport(o: { home: string; out?: string | undefined }): CommandResult {
  const ledger = Ledger.openReadOnly(join(o.home, 'ledger.db'));
  try {
    const csv = exportCsv(ledger);
    if (o.out === undefined) return { ok: true, text: csv.trimEnd() };
    writeFileSync(o.out, csv);
    return { ok: true, text: `Wrote ${String(ledger.entries().length)} entries to ${o.out}.` };
  } finally {
    ledger.close();
  }
}
