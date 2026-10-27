import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ConfigError,
  parseConfig,
  type AgentConfig,
  type MandateConfig,
} from '../config/schema.js';
import { evaluate } from '../engine/evaluate.js';
import { dailySpend } from '../engine/rules.js';
import type { Credential, PaymentRequest } from '../engine/types.js';
import { PAYMENT_SCOPE, signatureCheck, type CredentialFile } from '../kya/credential.js';
import { loadSigningIssuer, readCredential, type SigningIssuer } from '../kya/store.js';
import { toEngineViews } from '../ledger/fold.js';
import { Ledger, newId } from '../ledger/ledger.js';
import { effectiveStatus } from '../control/actions.js';
import {
  AGENT_INSTRUCTIONS,
  AGENT_TOOLS,
  budgetState,
  agentErrorText,
  invalidAmountText,
  mandateSummary,
  paymentAnswer,
  publicPayment,
  toPaymentRequest,
} from '../tools/agent-tools.js';
import { join } from 'node:path';

/**
 * The agent-facing MCP server. One server per agent, started with that agent's credential.
 *
 * The agent can read its mandate and its own payments, and ask for a payment. Nothing here can
 * approve, change policy, unfreeze or read another agent's data: those tools do not exist.
 * Keys and credentials never appear in tool output. Tool names, schemas and answers come from
 * src/tools/agent-tools.ts, shared with the website's remote endpoint.
 */

export interface MandateServerOptions {
  home: string;
  configPath: string;
  agentId: string;
  /** Epoch milliseconds; injectable for tests. */
  clock?: () => number;
}

export interface MandateServer {
  server: McpServer;
  ledger: Ledger;
  issuerId: string;
  close(): void;
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Load-time checks: fail loudly at start rather than at the first request. */
function startupCheck(o: MandateServerOptions): { issuer: SigningIssuer } {
  const issuer = loadSigningIssuer(o.home);
  const config = parseConfig(readFileSync(o.configPath, 'utf8'));
  if (!config.agents[o.agentId]) {
    throw new ConfigError(`Agent "${o.agentId}" is not in ${o.configPath}.`);
  }
  readCredential(o.home, o.agentId);
  return { issuer };
}

export function createMandateServer(o: MandateServerOptions): MandateServer {
  const clock = o.clock ?? Date.now;
  const { issuer } = startupCheck(o);
  const ledger = Ledger.open(join(o.home, 'ledger.db'), {
    issuer: issuer.id,
    privateKey: issuer.privateKey,
  });
  const verifySignature = signatureCheck(issuer.publicKey);

  /**
   * Re-read the mandate and credential on every call, so an owner's edit (a lower budget, a
   * frozen status, a reissued credential) applies at once. Unreadable means no authority.
   */
  function current(): { config: MandateConfig; agent: AgentConfig; credential: Credential | null } {
    const config = parseConfig(readFileSync(o.configPath, 'utf8'));
    const agent = config.agents[o.agentId];
    if (!agent) throw new ConfigError(`Agent "${o.agentId}" no longer has a mandate.`);
    let credential: CredentialFile | null;
    try {
      credential = readCredential(o.home, o.agentId);
    } catch {
      credential = null;
    }
    return { config, agent, credential };
  }

  /** Currency decimal overrides for display; a broken config must not hide the agent's history. */
  function decimals(): Readonly<Record<string, number>> | undefined {
    try {
      return current().config.policy.currencyDecimals;
    } catch {
      return undefined;
    }
  }

  const server = new McpServer(
    { name: 'flow-e', version: '0.1.0' },
    { instructions: AGENT_INSTRUCTIONS },
  );

  server.registerTool('check_mandate', AGENT_TOOLS.check_mandate, () => {
    try {
      const { config, agent, credential } = current();
      return text(
        mandateSummary({
          config,
          agent,
          controls: ledger.controls(),
          credential,
          spend: dailySpend(
            ledger.paymentViews(agent.id),
            clock(),
            config.policy.timezone,
            agent.mandate.dailyBudget,
          ),
          budgets: budgetState({
            config,
            agent,
            views: ledger.paymentViews(agent.id),
            organisationViews: toEngineViews(ledger.payments()),
            now: clock(),
          }),
        }),
      );
    } catch (err) {
      return toolError(agentErrorText(err));
    }
  });

  server.registerTool('request_payment', AGENT_TOOLS.request_payment, (args) => {
    try {
      const { config, agent, credential } = current();
      const { policy } = config;
      let request: PaymentRequest;
      try {
        request = toPaymentRequest(args, policy.currencyDecimals);
      } catch (err) {
        return toolError(invalidAmountText(err));
      }
      const now = clock();
      const paymentId = newId('pay');
      const { receipt, result } = ledger.decide(agent.id, (views) => {
        // Read inside the write transaction: a freeze that lands first always wins.
        const controls = ledger.controls();
        return {
          paymentId,
          request,
          baseCurrency: policy.baseCurrency,
          now,
          result: evaluate(
            {
              id: agent.id,
              status: effectiveStatus(agent.status, controls, agent.id),
              credential,
            },
            agent.mandate,
            request,
            {
              now,
              killSwitch: controls.killSwitch?.on === true,
              ledger: views,
              organisationLedger: toEngineViews(ledger.payments()),
              policy,
              kya: { issuer: issuer.id, requiredScope: PAYMENT_SCOPE, verifySignature },
            },
          ),
        };
      });
      return text(
        paymentAnswer({
          paymentId,
          receiptId: receipt.entry.id,
          request,
          result,
          baseCurrency: policy.baseCurrency,
          currencyDecimals: policy.currencyDecimals,
        }),
      );
    } catch (err) {
      return toolError(
        `${agentErrorText(err)} The payment is NOT authorized; treat it as declined.`,
      );
    }
  });

  server.registerTool('get_payment', AGENT_TOOLS.get_payment, ({ id }) => {
    try {
      const payment = ledger.payment(o.agentId, id);
      return payment
        ? text(publicPayment(payment, decimals()))
        : toolError(`You have no payment "${id}".`);
    } catch (err) {
      return toolError(agentErrorText(err));
    }
  });

  server.registerTool('list_payments', AGENT_TOOLS.list_payments, ({ limit }) => {
    try {
      const payments = ledger.payments(o.agentId).reverse().slice(0, limit);
      const d = decimals();
      return text({ payments: payments.map((p) => publicPayment(p, d)) });
    } catch (err) {
      return toolError(agentErrorText(err));
    }
  });

  return {
    server,
    ledger,
    issuerId: issuer.id,
    close: () => {
      ledger.close();
    },
  };
}
