import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../src/core.js';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every module reachable from src/core.ts through value imports (type-only imports are erased). */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const text = readFileSync(file, 'utf8');
    const specs: string[] = [];
    const re = /^(?:import|export)\s+(?!type\b)[^'"]*?from\s+'([^']+)'/gm;
    for (const m of text.matchAll(re)) if (m[1]) specs.push(m[1]);
    seen.set(file, specs);
    for (const s of specs) {
      if (s.startsWith('.')) visit(join(dirname(file), s.replace(/\.js$/, '.ts')));
    }
  };
  visit(entry);
  return seen;
}

describe('@flow-e/mcp/core', () => {
  it('pulls in no file system, SQLite, process, network or CLI code', () => {
    const forbidden =
      /^(better-sqlite3|commander|hono|@hono\/|@modelcontextprotocol\/|node:(fs|child_process|http|net|os|path)$)/;
    const offenders: string[] = [];
    for (const [file, specs] of reachable(join(srcDir, 'core.ts'))) {
      for (const s of specs) if (forbidden.test(s)) offenders.push(`${file}: ${s}`);
      if (/[\\/](mcp|panel|cli)[\\/]|store\.ts$|setup\.ts$|ledger\.ts$/.test(file)) {
        offenders.push(`${file} is not pure`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exports what other hosts need', () => {
    for (const name of [
      'evaluate',
      'parseConfigObject',
      'buildEntry',
      'foldPayments',
      'foldControls',
      'auditEntries',
      'decisionData',
      'planResolve',
      'planCancel',
      'planFreeze',
      'planKillSwitch',
      'csvFromEntries',
      'verifyReceipt',
      'issueCredential',
      'DEMO_CONFIG_YAML',
      'DEMO_STORY_STEPS',
      'AGENT_TOOLS',
      'AGENT_INSTRUCTIONS',
      'mandateSummary',
      'toPaymentRequest',
      'paymentAnswer',
      'publicPayment',
    ]) {
      expect(core).toHaveProperty(name);
    }
  });
});
