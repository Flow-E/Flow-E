import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseConfig } from '../config/schema.js';
import { issueCredential, PAYMENT_SCOPE } from '../kya/credential.js';
import { initIssuer, loadSigningIssuer, readCredential, writeCredential } from '../kya/store.js';
import { DEMO_CONFIG_YAML, catalogTable, demoPrompt } from './content.js';

/**
 * Creates (or reuses) a self-contained demo folder: issuer keys, a fictional mandate.yaml,
 * credentials for the demo agents, the catalog and the prompt. Never touches a folder it did
 * not create: a marker file proves ownership, and only a marked folder can be reset.
 */

export const DEMO_MARKER = '.flow-e-demo';
const DEMO_CREDENTIAL_DAYS = 30;

export class DemoError extends Error {
  override name = 'DemoError';
}

export interface DemoSetup {
  dir: string;
  home: string;
  configPath: string;
  issuerId: string;
  /** True when this call created the folder. */
  created: boolean;
  agents: string[];
}

export function setupDemo(o: { dir: string; reset: boolean; now: number }): DemoSetup {
  const dir = resolve(o.dir);
  const marker = join(dir, DEMO_MARKER);
  const exists = existsSync(dir);

  if (exists && !existsSync(marker) && readdirSync(dir).length > 0) {
    throw new DemoError(
      `${dir} already exists and was not created by "flow-e demo". Choose another --dir.`,
    );
  }
  if (o.reset && existsSync(marker)) rmSync(dir, { recursive: true, force: true });

  const created = !existsSync(marker);
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, 'Created by "flow-e demo". Everything in this folder is fictional.\n');

  const home = join(dir, '.flow-e');
  const configPath = join(dir, 'mandate.yaml');
  if (!existsSync(configPath)) writeFileSync(configPath, DEMO_CONFIG_YAML);
  if (!existsSync(join(home, 'issuer.key'))) initIssuer(home);

  // Follow the file on disk, so edits to the demo mandate are respected.
  const config = parseConfig(readFileSync(configPath, 'utf8'));
  const issuer = loadSigningIssuer(home);
  const agents = Object.keys(config.agents);
  for (const id of agents) {
    // Reissue a missing or expiring credential so the demo always starts in a working state.
    let valid: boolean;
    try {
      valid = Date.parse(readCredential(home, id).claims.expires_at) > o.now + 86_400_000;
    } catch {
      valid = false;
    }
    if (valid) continue;
    const agent = config.agents[id];
    writeCredential(
      home,
      issueCredential({
        privateKey: issuer.privateKey,
        publicKey: issuer.publicKey,
        agentId: id,
        agentName: `${id} (demo agent)`,
        owner: agent?.owner ?? 'fictional owner',
        organisation: config.organisation ?? 'Example Labs AG (fictional)',
        scope: [PAYMENT_SCOPE],
        now: o.now,
        validDays: DEMO_CREDENTIAL_DAYS,
      }),
      true,
    );
  }

  writeFileSync(
    join(dir, 'catalog.md'),
    `# Supplier catalog (fictional demo data)\n\n${catalogTable()}\n`,
  );
  writeFileSync(join(dir, 'prompt.md'), `${demoPrompt()}\n`);

  return { dir, home, configPath, issuerId: issuer.id, created, agents };
}

export interface ServeCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * How an MCP client should start the demo agent's server. Run through npx, point at the
 * published package; run from a checkout, point at this exact CLI file.
 */
export function demoServeCommand(
  setup: DemoSetup,
  o: {
    cliPath: string;
    nodePath: string;
    /** From package.json, so the printed commands follow a rename. */
    packageName: string;
    version: string;
    platform: NodeJS.Platform;
  },
): ServeCommand {
  const env = { FLOWE_HOME: setup.home, FLOWE_CONFIG: setup.configPath };
  const serve = ['serve', '--agent', 'lab-procurement'];
  const viaNpx = /[\\/]_npx[\\/]/.test(o.cliPath);
  if (!viaNpx) return { command: o.nodePath, args: [o.cliPath, ...serve], env };
  // Pin the exact version that is running, so the client starts the same code.
  const npx = ['-y', `${o.packageName}@${o.version}`, ...serve];
  return o.platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'npx', ...npx], env }
    : { command: 'npx', args: npx, env };
}

/**
 * Quote for bash, PowerShell and cmd alike. Anything beyond plain characters, including a Windows
 * path's backslashes (which bash would eat unquoted), goes in double quotes, where all three
 * shells keep a backslash before a letter as typed.
 */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/** The command line that runs this same CLI, for hints such as "start the panel with …". */
export function cliLauncher(cmd: ServeCommand): string {
  if (cmd.command === 'npx' || cmd.command === 'cmd') {
    const spec = cmd.args[cmd.args.indexOf('-y') + 1] ?? '';
    const at = spec.lastIndexOf('@');
    return `npx ${at > 0 ? spec.slice(0, at) : spec}`;
  }
  const serveAt = cmd.args.indexOf('serve');
  // Plain "node" for a person typing in a shell: a line starting with a quoted path is an error
  // in PowerShell. (MCP configs keep the absolute path; clients may not share your PATH.)
  const node = /(^|[\\/])node(\.exe)?$/i.test(cmd.command) ? 'node' : shellQuote(cmd.command);
  return [node, ...cmd.args.slice(0, serveAt).map(shellQuote)].join(' ');
}

export function claudeCodeCommand(cmd: ServeCommand): string {
  const env = Object.entries(cmd.env).map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`);
  return [
    'claude mcp add flow-e-demo',
    ...env,
    '--',
    shellQuote(cmd.command),
    ...cmd.args.map(shellQuote),
  ].join(' ');
}

export function claudeDesktopJson(cmd: ServeCommand): string {
  return JSON.stringify(
    { mcpServers: { 'flow-e-demo': { command: cmd.command, args: cmd.args, env: cmd.env } } },
    null,
    2,
  );
}
