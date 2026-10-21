import { readFileSync } from 'node:fs';
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

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** Commands from later build steps are listed now so `--help` shows the whole surface. */
function planned(step: number) {
  return () => {
    process.stderr.write(`Not implemented yet (build step ${step}).\n`);
    process.exitCode = 1;
  };
}

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
    err instanceof ReceiptError;
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
  program.command('approve <id>').description('approve a payment in review').action(planned(6));
  program.command('decline <id>').description('decline a payment in review').action(planned(6));
  program
    .command('freeze [agent]')
    .description('freeze one agent, or all with --all (kill switch)')
    .option('--all', 'freeze every agent')
    .action(planned(6));
  program
    .command('unfreeze [agent]')
    .description('unfreeze one agent, or all with --all')
    .option('--all', 'unfreeze every agent')
    .action(planned(6));
  program
    .command('cooloff-cancel <id>')
    .description('cancel a payment still inside its cooling-off window')
    .action(planned(6));
  program
    .command('panel')
    .description('open the local control panel on localhost:4848')
    .action(planned(6));
  program.command('export').description('export the ledger as CSV').action(planned(6));
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
    .description('run with fictional demo agents and suppliers')
    .action(planned(7));

  return program;
}
