// Pack the package, install the tarball into an empty project, and use it the way a user would:
// CLI, demo, and one real request_payment over MCP stdio. Exits non-zero on any failure.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'mandate-pack-'));
// Run npm without a shell: under `npm run`, npm_execpath points at npm's own CLI script.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this through npm: npm run test:pack');
const npm = (args, cwd) =>
  execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' });

npm(['pack', '--pack-destination', work], root);
const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
if (!tarball) throw new Error('npm pack produced no tarball');
const project = join(work, 'project');
mkdirSync(project);
npm(['init', '-y'], project);
npm(['install', '--no-audit', '--no-fund', join(work, tarball)], project);

const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const cli = join(project, 'node_modules', name, 'dist', 'cli', 'index.js');
const node = (...args) =>
  execFileSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf8' });

console.log('version:', node('--version').trim());
node('demo', '--dir', 'demo', '--no-panel');
console.log(node('check', 'demo/mandate.yaml').split('\n')[0]);

const require = createRequire(join(project, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    cli,
    '--home',
    join(project, 'demo', '.flow-e'),
    '--config',
    join(project, 'demo', 'mandate.yaml'),
    'serve',
    '--agent',
    'lab-procurement',
  ],
});
const client = new Client({ name: 'pack-smoke', version: '1' });
await client.connect(transport);
const result = await client.callTool({
  name: 'request_payment',
  arguments: {
    merchant: 'Example Reagents AG',
    amount: '120.00',
    currency: 'CHF',
    category: '5169',
    country: 'CH',
  },
});
await client.close();
const decision = JSON.parse(result.content[0].text).decision;
if (decision !== 'approved') throw new Error(`expected approved, got ${decision}`);
console.log('request_payment over stdio:', decision);
console.log(node('--home', 'demo/.flow-e', 'audit').trim());
console.log(`pack smoke test passed (${tarball})`);
