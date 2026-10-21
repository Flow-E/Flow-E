import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { runAgentAdd, runInit } from '../../src/cli/kya-commands.js';
import { loadIssuer } from '../../src/kya/store.js';
import { Ledger } from '../../src/ledger/ledger.js';
import { verifyReceipt } from '../../src/ledger/receipt.js';

/** End to end: the built CLI, a real stdio process, a real ledger file. */

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'dist', 'cli', 'index.js');

beforeAll(() => {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], {
    stdio: 'inherit',
  });
}, 120_000);

describe('imprest serve over stdio', () => {
  it('answers request_payment and writes a verifiable ledger entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-stdio-'));
    const home = join(dir, '.imprest');
    const config = join(dir, 'mandate.yaml');
    runInit({ home, config });
    runAgentAdd({
      home,
      config,
      id: 'lab-procurement',
      days: 90,
      scope: ['payments:request'],
      force: false,
      now: Date.now(),
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, '--home', home, '--config', config, 'serve', '--agent', 'lab-procurement'],
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);

    const result = (await client.callTool({
      name: 'request_payment',
      arguments: {
        merchant: 'Basel Labware AG',
        amount: '480.00',
        currency: 'CHF',
        category: '5047',
        country: 'CH',
        memo: 'Pipette tips (fictional demo order)',
      },
    })) as { content: { text: string }[] };
    const body = JSON.parse(result.content[0]?.text ?? '') as {
      decision: string;
      payment_id: string;
      receipt_id: string;
    };
    expect(body.decision).toBe('approved');
    await client.close();

    expect(stderr).toMatch(/serving agent "lab-procurement"/);
    const ledger = Ledger.openReadOnly(join(home, 'ledger.db'));
    try {
      const entries = ledger.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        seq: 1,
        id: body.receipt_id,
        type: 'payment.decision',
        agent_id: 'lab-procurement',
        data: {
          payment_id: body.payment_id,
          decision: 'approved',
          amount_base: 48_000,
          request: { merchant: 'Basel Labware AG', amount: 48_000, currency: 'CHF' },
        },
      });
      const publicKey = loadIssuer(home).publicKey;
      expect(ledger.audit(publicKey)).toMatchObject({ ok: true, entries: 1 });
      const receipt = ledger.receipt(body.payment_id);
      expect(receipt && verifyReceipt(receipt, publicKey).valid).toBe(true);
    } finally {
      ledger.close();
    }
  }, 60_000);

  it('exits with a clear error when the agent has no credential', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-stdio-'));
    const home = join(dir, '.imprest');
    const config = join(dir, 'mandate.yaml');
    runInit({ home, config });
    let failure: { status: number | null; stderr: string } | undefined;
    try {
      execFileSync(
        process.execPath,
        [cli, '--home', home, '--config', config, 'serve', '--agent', 'lab-procurement'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20_000,
        },
      );
    } catch (err) {
      const e = err as { status: number | null; stderr: Buffer };
      failure = { status: e.status, stderr: e.stderr.toString() };
    }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toMatch(/has no credential\. Run "imprest agent add lab-procurement"/);
  });
});
