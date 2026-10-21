import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultActor,
  runCooloffCancel,
  runExport,
  runFreeze,
  runResolve,
} from '../../src/cli/control-commands.js';
import { runInit } from '../../src/cli/kya-commands.js';
import { buildProgram } from '../../src/cli/program.js';
import { ActionError } from '../../src/control/actions.js';
import { loadSigningIssuer } from '../../src/kya/store.js';
import { Ledger } from '../../src/ledger/ledger.js';
import { MINUTE, NOW } from '../engine/fixtures.js';
import { pay } from '../ledger/helpers.js';

let dir: string;
let home: string;
let config: string;
let review: string;
let approved: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mandate-cli-'));
  home = join(dir, '.imprest');
  config = join(dir, 'mandate.yaml');
  runInit({ home, config });
  const issuer = loadSigningIssuer(home);
  const ledger = Ledger.open(join(home, 'ledger.db'), {
    issuer: issuer.id,
    privateKey: issuer.privateKey,
  });
  review = pay(ledger, { amount: 600_000 }, NOW - 2 * MINUTE).entry.data.payment_id as string;
  approved = pay(ledger, { merchant: 'Basel Labware AG' }, NOW - MINUTE).entry.data
    .payment_id as string;
  ledger.close();
});

const who = { by: 'M. Keller (cli)', now: NOW };

describe('imprest approve / decline', () => {
  it('approves and mentions the cooling-off window', () => {
    const out = runResolve({ home, ...who, id: review, status: 'approved', note: 'ok' });
    expect(out.text).toBe(
      `Approved ${review}: CHF 6000.00 to Alpine Reagents AG (agent lab-procurement).\n` +
        `First payment to this supplier: cancellable until 2026-10-21T10:10:00.000Z (imprest cooloff-cancel ${review}).`,
    );
  });
  it('declines', () => {
    expect(runResolve({ home, ...who, id: review, status: 'declined' }).text).toMatch(/^Declined/);
  });
  it('refuses a payment not in review', () => {
    expect(() => runResolve({ home, ...who, id: approved, status: 'approved' })).toThrow(
      ActionError,
    );
  });
});

describe('imprest cooloff-cancel', () => {
  it('cancels inside the window', () => {
    expect(runCooloffCancel({ home, ...who, id: approved }).text).toBe(
      `Cancelled ${approved}: CHF 1200.00 to Basel Labware AG (agent lab-procurement).`,
    );
  });
});

describe('imprest freeze / unfreeze', () => {
  const freeze = (o: { agent?: string; all?: boolean; frozen?: boolean }) =>
    runFreeze({
      home,
      config,
      ...who,
      all: o.all ?? false,
      frozen: o.frozen ?? true,
      agent: o.agent,
    });

  it('freezes one agent, and says when nothing changed', () => {
    expect(freeze({ agent: 'lab-procurement' }).text).toBe(
      'Agent "lab-procurement" is now frozen.',
    );
    expect(freeze({ agent: 'lab-procurement' }).text).toBe(
      'Agent "lab-procurement" was already frozen.',
    );
    expect(freeze({ agent: 'lab-procurement', frozen: false }).text).toBe(
      'Agent "lab-procurement" is now unfrozen.',
    );
  });

  it('warns when mandate.yaml keeps the agent inactive', () => {
    writeFileSync(config, readFileSync(config, 'utf8').replace('status: active', 'status: paused'));
    expect(freeze({ agent: 'lab-procurement', frozen: false }).text).toMatch(
      /still sets it to "paused"/,
    );
  });

  it('runs the kill switch with --all', () => {
    expect(freeze({ all: true }).text).toBe(
      'Kill switch is now ON: every payment by every agent is declined.',
    );
    expect(freeze({ all: true, frozen: false }).text).toMatch(/^Kill switch is now OFF/);
  });

  it('needs exactly one of an agent or --all', () => {
    expect(() => freeze({})).toThrow(/Name one agent, or pass --all/);
    expect(() => freeze({ agent: 'lab-procurement', all: true })).toThrow(/not both/);
  });

  it('refuses an agent that is not in mandate.yaml', () => {
    expect(() => freeze({ agent: 'ghost' })).toThrow(/"ghost" is not in/);
  });
});

describe('imprest export', () => {
  it('prints CSV, or writes it to a file', () => {
    expect(runExport({ home }).text.split('\r\n')).toHaveLength(3);
    const out = join(dir, 'ledger.csv');
    expect(runExport({ home, out }).text).toBe(`Wrote 2 entries to ${out}.`);
    expect(readFileSync(out, 'utf8')).toMatch(/^"seq","created_at"/);
  });
});

describe('CLI surface', () => {
  it('records who acted, defaulting to the OS user', () => {
    expect(defaultActor()).toMatch(/\(cli\)$|^cli$/);
  });
  it('documents --by and --note on every action', () => {
    const program = buildProgram();
    for (const name of ['approve', 'decline', 'freeze', 'unfreeze', 'cooloff-cancel']) {
      const help = program.commands.find((c) => c.name() === name)?.helpInformation() ?? '';
      expect(help).toContain('--by <name>');
      expect(help).toContain('--note <text>');
    }
  });
});
