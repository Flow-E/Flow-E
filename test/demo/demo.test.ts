import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { demoInstructions } from '../../src/cli/demo-command.js';
import { parseConfig } from '../../src/config/schema.js';
import { resolvePayment } from '../../src/control/actions.js';
import { CATALOG, DEMO_CONFIG_YAML, demoPrompt } from '../../src/demo/content.js';
import {
  DEMO_MARKER,
  claudeCodeCommand,
  claudeDesktopJson,
  cliLauncher,
  demoServeCommand,
  shellQuote,
  setupDemo,
} from '../../src/demo/setup.js';
import { readCredential } from '../../src/kya/store.js';
import { createMandateServer } from '../../src/mcp/server.js';
import { NOW } from '../engine/fixtures.js';

const DAY = 86_400_000;
let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flow-e-demo-'));
  dir = join(root, 'flow-e-demo');
});

describe('demo content is fictional and labelled', () => {
  it('uses only "Example …" supplier names', () => {
    for (const c of CATALOG) expect(c.supplier).toMatch(/^Example /);
    const { policy, agents } = parseConfig(DEMO_CONFIG_YAML);
    for (const s of [
      ...policy.blockedSuppliers,
      ...Object.values(agents).flatMap((a) => a.mandate.suppliers.allow),
    ]) {
      expect(s).toMatch(/^Example /);
    }
  });
  it('says so in the config, the prompt and the catalog', () => {
    expect(DEMO_CONFIG_YAML).toMatch(/^# DEMO MANDATE\. Every organisation.*fictional/);
    expect(DEMO_CONFIG_YAML).toMatch(/NOT sanctions screening/);
    expect(demoPrompt()).toMatch(/This is a demo: the company, suppliers and prices are fictional/);
    for (const owner of Object.values(parseConfig(DEMO_CONFIG_YAML).agents).map((a) => a.owner)) {
      expect(owner).toMatch(/\(fictional\)$/);
    }
  });
});

describe('setupDemo', () => {
  it('creates a complete, marked demo folder', () => {
    const s = setupDemo({ dir, reset: false, now: NOW });
    expect(s.created).toBe(true);
    expect(s.agents).toEqual(['lab-procurement', 'office-supplies']);
    for (const f of [
      DEMO_MARKER,
      'mandate.yaml',
      'catalog.md',
      'prompt.md',
      '.flow-e/issuer.key',
    ]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(readFileSync(join(dir, 'prompt.md'), 'utf8')).toContain('Example Chem Trading LLC');
    expect(readCredential(s.home, 'lab-procurement').claims).toMatchObject({
      issuer: s.issuerId,
      owner: 'Dr. A. Muster, Head of Lab (fictional)',
      organisation: 'Example Labs AG (fictional)',
      expires_at: new Date(NOW + 30 * DAY).toISOString(),
    });
  });

  it('reuses an existing demo folder, keeping keys and edits', () => {
    const first = setupDemo({ dir, reset: false, now: NOW });
    writeFileSync(
      first.configPath,
      readFileSync(first.configPath, 'utf8').replace('20000', '15000'),
    );
    const second = setupDemo({ dir, reset: false, now: NOW + DAY });
    expect(second.created).toBe(false);
    expect(second.issuerId).toBe(first.issuerId);
    expect(readFileSync(second.configPath, 'utf8')).toContain('daily_budget: 15000');
  });

  it('reissues credentials that are about to expire', () => {
    const s = setupDemo({ dir, reset: false, now: NOW });
    setupDemo({ dir, reset: false, now: NOW + 29.5 * DAY });
    expect(readCredential(s.home, 'lab-procurement').claims.issued_at).toBe(
      new Date(NOW + 29.5 * DAY).toISOString(),
    );
  });

  it('starts over with --reset: new keys, empty ledger', () => {
    const first = setupDemo({ dir, reset: false, now: NOW });
    writeFileSync(join(dir, '.flow-e', 'ledger.db'), '');
    const again = setupDemo({ dir, reset: true, now: NOW });
    expect(again.created).toBe(true);
    expect(again.issuerId).not.toBe(first.issuerId);
    expect(existsSync(join(dir, '.flow-e', 'ledger.db'))).toBe(false);
  });

  it('refuses a folder it did not create, even with --reset, and deletes nothing', () => {
    mkdirSync(dir);
    writeFileSync(join(dir, 'thesis.docx'), 'precious');
    for (const reset of [false, true]) {
      expect(() => setupDemo({ dir, reset, now: NOW })).toThrow(/was not created by "flow-e demo"/);
    }
    expect(readFileSync(join(dir, 'thesis.docx'), 'utf8')).toBe('precious');
  });

  it('accepts an existing empty folder', () => {
    mkdirSync(dir);
    expect(setupDemo({ dir, reset: false, now: NOW }).created).toBe(true);
  });
});

describe('connection instructions', () => {
  const s = () => setupDemo({ dir, reset: false, now: NOW });
  const local = {
    cliPath: '/repo/dist/cli/index.js',
    nodePath: '/usr/bin/node',
    packageName: 'some-mandate-pkg',
    version: '0.1.0',
  };

  it('points a checkout at this exact CLI file', () => {
    const cmd = demoServeCommand(s(), { ...local, platform: 'linux' });
    expect(cmd).toMatchObject({
      command: '/usr/bin/node',
      args: ['/repo/dist/cli/index.js', 'serve', '--agent', 'lab-procurement'],
    });
    expect(cmd.env.FLOWE_HOME).toBe(join(dir, '.flow-e'));
  });

  it('points an npx run at the published version, with cmd /c on Windows', () => {
    const npx = {
      ...local,
      cliPath: '/home/u/.npm/_npx/abc/node_modules/@flow-e/mcp/dist/cli/index.js',
    };
    expect(demoServeCommand(s(), { ...npx, platform: 'darwin' })).toMatchObject({
      command: 'npx',
      args: ['-y', 'some-mandate-pkg@0.1.0', 'serve', '--agent', 'lab-procurement'],
    });
    expect(demoServeCommand(s(), { ...npx, platform: 'win32' })).toMatchObject({
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'some-mandate-pkg@0.1.0', 'serve', '--agent', 'lab-procurement'],
    });
  });

  it('quotes paths with spaces for the shell, and emits valid Desktop JSON', () => {
    const cmd = {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\x\\cli.js', 'serve'],
      env: { FLOWE_HOME: 'C:\\My Demo\\.flow-e' },
    };
    expect(claudeCodeCommand(cmd)).toBe(
      'claude mcp add flow-e-demo -e "FLOWE_HOME=C:\\My Demo\\.flow-e" -- "C:\\Program Files\\nodejs\\node.exe" "C:\\x\\cli.js" serve',
    );
    expect(JSON.parse(claudeDesktopJson(cmd))).toEqual({ mcpServers: { 'flow-e-demo': cmd } });
  });

  it('builds a launcher hint that matches how the CLI was started', () => {
    expect(
      cliLauncher({
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['C:\\x\\cli.js', 'serve'],
        env: {},
      }),
    ).toBe('node "C:\\x\\cli.js"');
    expect(
      cliLauncher({ command: '/usr/bin/node', args: ['/opt/m/cli.js', 'serve'], env: {} }),
    ).toBe('node /opt/m/cli.js');
    expect(cliLauncher({ command: '/opt/my bun', args: ['/opt/m/cli.js', 'serve'], env: {} })).toBe(
      '"/opt/my bun" /opt/m/cli.js',
    );
    expect(
      cliLauncher({
        command: 'cmd',
        args: ['/c', 'npx', '-y', '@scope/pkg@1.2.3', 'serve'],
        env: {},
      }),
    ).toBe('npx @scope/pkg');
    expect(shellQuote('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('prints the snippets, the panel link, the prompt and what to expect', () => {
    const setup = s();
    const text = demoInstructions(
      setup,
      demoServeCommand(setup, { ...local, platform: 'linux' }),
      'http://127.0.0.1:4848/#token=abc',
    );
    expect(text).toContain('claude mcp add flow-e-demo');
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('http://127.0.0.1:4848/#token=abc');
    expect(text).toContain(demoPrompt());
    expect(text).toMatch(/Centrifuge, CHF 6500: sent to you for review/);
    expect(text).toMatch(/No money moves/);
  });
});

describe('the demo story, played through the MCP tools', () => {
  it('produces every outcome the demo promises', async () => {
    const setup = setupDemo({ dir, reset: false, now: NOW });
    const now = NOW;
    const server = createMandateServer({
      home: setup.home,
      configPath: setup.configPath,
      agentId: 'lab-procurement',
      clock: () => now,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.server.connect(serverSide);
    const client = new Client({ name: 'demo-agent', version: '1.0.0' });
    await client.connect(clientSide);

    const buy = async (item: string, supplier: string, amount?: string) => {
      const c = CATALOG.find((x) => x.item === item && x.supplier === supplier);
      if (!c) throw new Error(`no catalog entry ${item} / ${supplier}`);
      const r = (await client.callTool({
        name: 'request_payment',
        arguments: {
          merchant: c.supplier,
          amount: amount ?? c.price,
          currency: c.currency,
          category: c.category,
          country: c.country,
          memo: c.item,
        },
      })) as { content: { text: string }[] };
      return JSON.parse(r.content[0]?.text ?? '') as {
        decision: string;
        rule: string | null;
        payment_id: string;
        cancellable_until: string | null;
      };
    };

    const buffer = 'Phosphate buffer solution, 10 L';
    expect(await buy(buffer, 'Example Chem Trading LLC')).toMatchObject({
      decision: 'declined',
      rule: 'SUPPLIER',
    });
    expect(await buy(buffer, 'Example Reagents AG')).toMatchObject({
      decision: 'approved',
      cancellable_until: expect.any(String) as unknown,
    });
    const centrifuge = await buy('Benchtop centrifuge', 'Example Labware AG');
    expect(centrifuge).toMatchObject({ decision: 'review', rule: 'APPROVAL_THRESHOLD' });
    expect(await buy('HPLC column set (10 columns)', 'Example Labware AG')).toMatchObject({
      decision: 'declined',
      rule: 'PER_PAYMENT_LIMIT',
    });
    // An agent that tries to split the declined payment is caught and a person decides. Here
    // even the first half is, because the pending CHF 6500 centrifuge counts towards the sum.
    expect(
      await buy('HPLC column set (10 columns)', 'Example Labware AG', '4500.00'),
    ).toMatchObject({ decision: 'review', rule: 'SPLIT_DETECTION' });
    expect(
      await buy('HPLC column set (10 columns)', 'Example Labware AG', '4500.00'),
    ).toMatchObject({ decision: 'review', rule: 'SPLIT_DETECTION' });
    expect(await buy('Borosilicate glassware kit', 'Example Glass GmbH')).toMatchObject({
      decision: 'declined',
      rule: 'SUPPLIER',
    });
    expect(await buy('Nitrile gloves, 10 boxes', 'Example Labware AG')).toMatchObject({
      decision: 'approved',
    });
    // Overpriced: 55% above the usual CHF 310, so a person decides.
    expect(await buy('Pipette tips, 20 racks', 'Example Labware AG')).toMatchObject({
      decision: 'review',
      rule: 'FAIR_PRICE',
    });

    resolvePayment(server.ledger, centrifuge.payment_id, 'approved', {
      by: 'demo owner (panel)',
      now,
    });
    const after = (await client.callTool({
      name: 'get_payment',
      arguments: { id: centrifuge.payment_id },
    })) as { content: { text: string }[] };
    expect(JSON.parse(after.content[0]?.text ?? '')).toMatchObject({ status: 'approved' });

    await client.close();
    server.close();
  });
});
