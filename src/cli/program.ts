import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { ConfigError, parseConfig } from '../config/schema.js';
import { formatMoney } from '../engine/money.js';
import { CredentialError } from '../kya/credential.js';
import { KeyStoreError } from '../kya/store.js';
import { LedgerError } from '../ledger/ledger.js';
import { ReceiptError } from '../ledger/receipt.js';
import { DEFAULT_SCOPE, runAgentAdd, runInit } from './kya-commands.js';
import { runAudit, runReceipt, runVerify, type CommandResult } from './ledger-commands.js';
import { serveStdio } from '../mcp/stdio.js';
import { DEFAULT_PANEL_PORT, PanelError, startPanel } from '../panel/server.js';
import { ActionError } from '../control/actions.js';
import { DemoError, demoServeCommand, setupDemo } from '../demo/setup.js';
import { demoInstructions } from './demo-command.js';
import {
  defaultActor,
  runCooloffCancel,
  runExport,
  runFreeze,
  runResolve,
} from './control-commands.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

interface GlobalOptions {
  home: string;
  config: string;
}

/** Print expected errors plainly and set a failing exit code. None of them carry key material. */
function report(err: unknown): void {
  const known =
    err instanceof ConfigError ||
    err instanceof KeyStoreError ||
    err instanceof CredentialError ||
    err instanceof LedgerError ||
    err instanceof ReceiptError ||
    err instanceof ActionError ||
    err instanceof PanelError ||
    err instanceof DemoError;
  process.stderr.write(`${known ? err.message : `Unexpected error: ${(err as Error).message}`}\n`);
  process.exitCode = 1;
}

/** Print a command's result; a failed check exits 1. */
function emit(run: () => CommandResult): void {
  try {
    const result = run();
    (result.ok ? process.stdout : process.stderr).write(result.text + '\n');
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    report(err);
  }
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Use a whole number above 0.');
  return n;
}

export function buildProgram(): Command {
  const program = new Command('mandate')
    .description(
      'Give AI agents a mandate: identity, budgets and rules, human approval, a kill switch and ' +
        'signed receipts. Authorizes payments only; never moves real money.',
    )
    .version(pkg.version)
    .option(
      '--home <dir>',
      'state directory (keys, credentials)',
      process.env.MANDATE_HOME ?? '.mandate',
    )
    .option('--config <file>', 'mandate file', process.env.MANDATE_CONFIG ?? 'mandate.yaml');

  program
    .command('init')
    .description('create the local issuer key pair and a starter mandate.yaml')
    .action((_opts: unknown, cmd: Command) => {
      try {
        process.stdout.write(runInit(cmd.optsWithGlobals<GlobalOptions>()) + '\n');
      } catch (err) {
        report(err);
      }
    });

  const agent = program.command('agent').description('manage agents and their credentials');
  agent
    .command('add <id>')
    .description('issue a signed Know Your Agent credential for an agent in mandate.yaml')
    .option('--name <name>', 'display name of the agent (default: its id)')
    .option('--org <organisation>', 'organisation (default: "organisation" in mandate.yaml)')
    .option('--days <n>', 'days until the credential expires', positiveInt, 90)
    .option('--scope <scope...>', 'granted scopes', DEFAULT_SCOPE)
    .option('--force', 'reissue, replacing an existing credential', false)
    .action((id: string, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<
        GlobalOptions & {
          name?: string;
          org?: string;
          days: number;
          scope: string[];
          force: boolean;
        }
      >();
      try {
        process.stdout.write(runAgentAdd({ ...o, id, now: Date.now() }) + '\n');
      } catch (err) {
        report(err);
      }
    });

  program
    .command('check [file]')
    .description('validate mandate.yaml and print each agent’s mandate')
    .action((file: string | undefined, _opts: unknown, cmd: Command) => {
      const path = file ?? cmd.optsWithGlobals<GlobalOptions>().config;
      try {
        const { policy, agents } = parseConfig(readFileSync(path, 'utf8'));
        const fmt = (n: number) => formatMoney(n, policy.baseCurrency, policy.currencyDecimals);
        process.stdout.write(`${path} is valid. Base currency ${policy.baseCurrency}.\n`);
        for (const a of Object.values(agents)) {
          const m = a.mandate;
          process.stdout.write(
            `  ${a.id} (${a.status}, owner ${a.owner}): daily ${fmt(m.dailyBudget)}, ` +
              `per payment ${fmt(m.perPaymentLimit)}, review above ` +
              `${m.approvalAbove === null ? 'never' : fmt(m.approvalAbove)}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `${err instanceof ConfigError ? err.message : `Cannot read ${path}: ${(err as Error).message}`}\n`,
        );
        process.exitCode = 1;
      }
    });

  program
    .command('serve')
    .description('start the MCP server (stdio) for one agent')
    .requiredOption('--agent <id>', 'agent to serve; needs a mandate and a credential')
    .action(async (_opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<GlobalOptions & { agent: string }>();
      try {
        await serveStdio({ home: o.home, configPath: o.config, agentId: o.agent });
      } catch (err) {
        report(err);
      }
    });
  type ActOptions = GlobalOptions & { by: string; note?: string };
  const actorOptions = (c: Command) =>
    c
      .option('--by <name>', 'who is acting, recorded in the ledger', defaultActor())
      .option('--note <text>', 'note recorded with the action');

  for (const [name, status] of [
    ['approve', 'approved'],
    ['decline', 'declined'],
  ] as const) {
    actorOptions(
      program.command(`${name} <payment-id>`).description(`${name} a payment waiting for review`),
    ).action((id: string, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<ActOptions>();
      emit(() => runResolve({ ...o, id, status, now: Date.now() }));
    });
  }
  for (const [name, frozen] of [
    ['freeze', true],
    ['unfreeze', false],
  ] as const) {
    actorOptions(
      program
        .command(`${name} [agent]`)
        .description(
          frozen
            ? 'freeze one agent, or every agent with --all (kill switch)'
            : 'unfreeze one agent, or release the kill switch with --all',
        )
        .option('--all', frozen ? 'turn the kill switch on' : 'turn the kill switch off', false),
    ).action((agent: string | undefined, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<ActOptions & { all: boolean }>();
      emit(() => runFreeze({ ...o, agent, frozen, now: Date.now() }));
    });
  }
  actorOptions(
    program
      .command('cooloff-cancel <payment-id>')
      .description('cancel an approved payment still inside its 10-minute cooling-off window'),
  ).action((id: string, _opts: unknown, cmd: Command) => {
    emit(() => runCooloffCancel({ ...cmd.optsWithGlobals<ActOptions>(), id, now: Date.now() }));
  });
  program
    .command('panel')
    .description('start the local control panel (127.0.0.1 only, token-protected)')
    .option('--port <n>', 'port', positiveInt, DEFAULT_PANEL_PORT)
    .option(
      '--by <name>',
      'who is acting, recorded in the ledger',
      defaultActor().replace('(cli)', '(panel)'),
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<GlobalOptions & { port: number; by: string }>();
      try {
        const panel = await startPanel({
          home: o.home,
          configPath: o.config,
          port: o.port,
          actor: o.by,
        });
        process.stdout.write(
          `Control panel running. Open this link (it contains your access token; do not share it):

  ${panel.url}

Press Ctrl+C to stop.
`,
        );
        const stop = () => {
          void panel.close().then(() => process.exit(0));
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      } catch (err) {
        report(err);
      }
    });
  program
    .command('export')
    .description('export the whole ledger as CSV (stdout, or --out file)')
    .option('--out <file>', 'write to this file instead of stdout')
    .action((_opts: unknown, cmd: Command) => {
      emit(() => runExport(cmd.optsWithGlobals<GlobalOptions & { out?: string }>()));
    });
  program
    .command('verify <receipt>')
    .description('verify a signed receipt (offline, public key only) and its chain position')
    .option('--pubkey <file>', 'issuer public key (default: <home>/issuer.pub)')
    .option('--ledger <file>', 'ledger to check the position in (default: <home>/ledger.db)')
    .option('--offline', 'check signature and hash only, without a ledger')
    .action((receipt: string, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<
        GlobalOptions & { pubkey?: string; ledger?: string; offline?: boolean }
      >();
      emit(() => runVerify({ ...o, receipt }));
    });
  program
    .command('audit')
    .description('verify the whole ledger: sequence, hash chain and every signature')
    .option('--ledger <file>', 'ledger file (default: <home>/ledger.db)')
    .action((_opts: unknown, cmd: Command) => {
      emit(() => runAudit(cmd.optsWithGlobals<GlobalOptions & { ledger?: string }>()));
    });
  program
    .command('receipt <id>')
    .description('print the signed receipt for a receipt id or payment id')
    .option('--ledger <file>', 'ledger file (default: <home>/ledger.db)')
    .action((id: string, _opts: unknown, cmd: Command) => {
      emit(() => runReceipt({ ...cmd.optsWithGlobals<GlobalOptions & { ledger?: string }>(), id }));
    });
  program
    .command('demo')
    .description('set up a fictional demo, start the panel and print a prompt for Claude')
    .option('--dir <dir>', 'demo folder (created if missing)', 'mandate-demo')
    .option('--port <n>', 'control panel port', positiveInt, DEFAULT_PANEL_PORT)
    .option('--no-panel', 'do not start the control panel')
    .option('--reset', 'delete the demo folder first (only one made by "mandate demo")', false)
    .action(async (_opts: unknown, cmd: Command) => {
      const o = cmd.opts<{ dir: string; port: number; panel: boolean; reset: boolean }>();
      try {
        const setup = setupDemo({ dir: o.dir, reset: o.reset, now: Date.now() });
        const serve = demoServeCommand(setup, {
          cliPath: realpathSync(process.argv[1] ?? fileURLToPath(import.meta.url)),
          nodePath: process.execPath,
          packageName: pkg.name,
          version: pkg.version,
          platform: process.platform,
        });
        const panel = o.panel
          ? await startPanel({
              home: setup.home,
              configPath: setup.configPath,
              port: o.port,
              actor: 'demo owner (panel)',
            })
          : null;
        process.stdout.write(demoInstructions(setup, serve, panel?.url ?? null) + '\n');
        if (panel) {
          process.stdout.write('\nThe panel keeps running. Press Ctrl+C to stop it.\n');
          const stop = () => {
            void panel.close().then(() => process.exit(0));
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        }
      } catch (err) {
        report(err);
      }
    });

  return program;
}
