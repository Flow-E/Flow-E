import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { catalogList, runSimulate } from '../../src/cli/simulate-command.js';
import { setupDemo } from '../../src/demo/setup.js';
import { loadIssuer } from '../../src/kya/store.js';
import { Ledger } from '../../src/ledger/ledger.js';

/** End to end: the built CLI serves MCP over stdio; simulate talks to it like Claude would. */

const root = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = join(root, 'dist', 'cli', 'index.js');
const nodePath = process.execPath;

let demo: string;

beforeAll(() => {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], {
    stdio: 'inherit',
  });
  demo = join(mkdtempSync(join(tmpdir(), 'flow-e-sim-')), 'demo');
  setupDemo({ dir: demo, reset: false, now: Date.now() });
}, 120_000);

const simulate = (action: string, arg?: string, dir = demo) =>
  runSimulate({ dir, action, arg, cliPath, nodePath });

describe('safety', () => {
  it('refuses a folder that "flow-e demo" did not make', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'flow-e-not-demo-'));
    await expect(simulate('story', undefined, plain)).rejects.toThrow(
      /is not a demo folder made by "flow-e demo"/,
    );
  });

  it('refuses a folder that does not exist', async () => {
    await expect(
      simulate('list', undefined, join(tmpdir(), 'no-such-flow-e-demo')),
    ).rejects.toThrow(/is not a demo folder/);
  });

  it('refuses an unknown action', async () => {
    await expect(simulate('pay-everything')).rejects.toThrow(/Unknown action "pay-everything"/);
  });

  it('exits with an error from the CLI too', () => {
    const plain = mkdtempSync(join(tmpdir(), 'flow-e-not-demo-'));
    let failure: { status: number | null; stderr: string } | undefined;
    try {
      execFileSync(nodePath, [cliPath, 'simulate', '--dir', plain], { stdio: 'pipe' });
    } catch (err) {
      const e = err as { status: number | null; stderr: Buffer };
      failure = { status: e.status, stderr: e.stderr.toString() };
    }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toMatch(/is not a demo folder made by "flow-e demo"/);
  });
});

describe('the fake agent', () => {
  let story = '';

  it('lists the catalog', async () => {
    const out = (await simulate('list')).text;
    expect(out).toBe(catalogList());
    expect(out).toContain('6. Nitrile gloves, 10 boxes from Example Labware AG: CHF 240.00');
  });

  it('plays the demo story with the expected decisions, and the ledger audits clean', async () => {
    story = (await simulate('story')).text;
    const decisions = story
      .split('\n')
      .map((l) => /^(APPROVED|DECLINED|REVIEW)\s/.exec(l)?.[1])
      .filter(Boolean);
    expect(decisions).toEqual([
      'DECLINED',
      'APPROVED',
      'REVIEW',
      'DECLINED',
      'DECLINED',
      'DECLINED',
      'APPROVED',
      'REVIEW',
    ]);
    expect(story).toMatch(/Pipette tips, 20 racks[\s\S]*55% above the usual CHF 310\.00/);
    expect(story).toMatch(/Example Chem Trading LLC" is on the organisation's blocklist/);
    expect(story).toMatch(/above the per-payment limit of CHF 8000\.00/);
    expect(story).toMatch(
      /HPLC column set \(10 columns\), split part: CHF 4500\.00[\s\S]*Looks like a split payment/,
    );
    expect(story).toMatch(/"Example Glass GmbH" is not on this agent's approved supplier list/);
    expect(story).toMatch(/centrifuge is waiting for your approval/);

    const ledger = Ledger.openReadOnly(join(demo, '.flow-e', 'ledger.db'));
    try {
      expect(ledger.audit(loadIssuer(join(demo, '.flow-e')).publicKey)).toMatchObject({
        ok: true,
        entries: 8,
      });
    } finally {
      ledger.close();
    }
  }, 30_000);

  it('buys one catalog item', async () => {
    const out = (await simulate('buy', '6')).text;
    expect(out).toMatch(/^APPROVED Nitrile gloves, 10 boxes {2}CHF 240\.00 {2}pay_[0-9a-f]{20}\n/);
  });

  it('lists the catalog and fails for a wrong item number', async () => {
    for (const arg of ['8', '0', 'x', undefined]) {
      await expect(simulate('buy', arg)).rejects.toThrow(
        /1\. Phosphate[\s\S]*Pick an item number from 1 to 7/,
      );
    }
  });

  it('shows the status of a payment', async () => {
    const centrifuge = /REVIEW\s+Benchtop centrifuge {2}CHF 6500\.00 {2}(pay_[0-9a-f]{20})/.exec(
      story,
    )?.[1];
    expect(centrifuge).toBeDefined();
    const out = (await simulate('status', centrifuge)).text;
    expect(out).toBe(
      `${centrifuge ?? ''}: review (decided by the rules)\n` +
        '  CHF 6500.00 to Example Labware AG: Benchtop centrifuge\n' +
        '  CHF 6500.00 is above the approval threshold of CHF 5000.00; a human must approve.',
    );
    await expect(simulate('status')).rejects.toThrow(/Say which payment/);
    await expect(simulate('status', 'pay_unknown')).rejects.toThrow(/You have no payment/);
  });

  it("shows the agent's mandate and today's budget", async () => {
    const out = (await simulate('mandate')).text;
    expect(out).toContain(
      'Agent lab-procurement (active), owner Dr. A. Muster, Head of Lab (fictional)',
    );
    expect(out).toMatch(
      /approved CHF 1680\.00, pending review CHF 6980\.00, remaining CHF 11340\.00/,
    );
    expect(out).toContain('per payment up to CHF 8000.00; human approval above CHF 5000.00');
    expect(out).toContain('suppliers: Example Reagents AG, Example Labware AG');
  });
});
