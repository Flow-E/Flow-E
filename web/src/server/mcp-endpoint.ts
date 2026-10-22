import 'server-only';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AGENT_INSTRUCTIONS,
  AGENT_TOOLS,
  AmountError,
  agentErrorText,
  invalidAmountText,
} from '@flow-e/mcp/core';
import type { AgentAuth, OrgStore } from './org-store';
import { RateLimiter } from './rate-limit';

/**
 * The remote MCP endpoint (/api/mcp): Streamable HTTP, stateless, one McpServer per request.
 * An agent authenticates with `Authorization: Bearer flowe_ak_…`; the key decides the
 * organisation and agent, so a request can never name another agent's data. The tools are the
 * same definitions as the stdio server (src/tools/agent-tools.ts in the core). No cookies are
 * read and no CORS headers are sent: this is for agents, not browsers.
 */

export const MAX_BODY_BYTES = 64 * 1024;
export const RATE_LIMIT_PER_MINUTE = 60;

export interface McpDeps {
  store: OrgStore;
  limiter: RateLimiter;
  /** Site origin for links in approval emails, e.g. https://flow-e.example. */
  origin: string;
}

export function newLimiter(clock?: () => number): RateLimiter {
  return new RateLimiter(RATE_LIMIT_PER_MINUTE, 60_000, clock);
}

function rpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export function unauthorized(message: string): Response {
  return rpcError(401, -32001, message, {
    'www-authenticate': 'Bearer realm="flow-e", error="invalid_token"',
  });
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m?.[1] ?? null;
}

/** Read at most `limit` bytes of the body; null when it is larger. */
async function readBody(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > limit) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function logFailure(tool: string, err: unknown) {
  // The error's name only: messages could echo request content.
  console.error('mcp tool failed', tool, err instanceof Error ? err.name : 'unknown');
}

/** An MCP server bound to one authenticated agent. */
export function agentServer(store: OrgStore, auth: AgentAuth, origin: string): McpServer {
  const server = new McpServer(
    { name: 'flow-e', version: '0.1.0' },
    { instructions: AGENT_INSTRUCTIONS },
  );

  server.registerTool('check_mandate', AGENT_TOOLS.check_mandate, async () => {
    try {
      return json(await store.checkMandate(auth));
    } catch (err) {
      logFailure('check_mandate', err);
      return toolError(agentErrorText(err));
    }
  });

  server.registerTool('request_payment', AGENT_TOOLS.request_payment, async (args) => {
    try {
      return json(await store.requestPayment(auth, args, origin));
    } catch (err) {
      if (err instanceof AmountError) return toolError(invalidAmountText(err));
      logFailure('request_payment', err);
      return toolError(
        `${agentErrorText(err)} The payment is NOT authorized; treat it as declined.`,
      );
    }
  });

  server.registerTool('get_payment', AGENT_TOOLS.get_payment, async ({ id }) => {
    try {
      const payment = await store.agentPayment(auth, id);
      return payment ? json(payment) : toolError(`You have no payment "${id}".`);
    } catch (err) {
      logFailure('get_payment', err);
      return toolError(agentErrorText(err));
    }
  });

  server.registerTool('list_payments', AGENT_TOOLS.list_payments, async ({ limit }) => {
    try {
      return json({ payments: await store.agentPayments(auth, limit) });
    } catch (err) {
      logFailure('list_payments', err);
      return toolError(agentErrorText(err));
    }
  });

  return server;
}

/** Handle one HTTP request to the endpoint. */
export async function handleMcp(req: Request, deps: McpDeps): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  const key = bearer(req);
  if (!key) return unauthorized('Missing agent key. Send Authorization: Bearer flowe_ak_…');
  const auth = await deps.store.authenticateAgent(key);
  if (!auth) return unauthorized('This agent key is not valid, revoked or expired.');

  const rate = deps.limiter.take(auth.keyId);
  if (!rate.ok) {
    return rpcError(429, -32002, 'Too many requests for this key. Slow down.', {
      'retry-after': String(rate.retryAfterS),
    });
  }

  const body = await readBody(req, MAX_BODY_BYTES);
  if (body === null) return rpcError(413, -32600, `Request body over ${MAX_BODY_BYTES} bytes.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return rpcError(400, -32700, 'Parse error: the body is not JSON.');
  }

  const server = agentServer(deps.store, auth, deps.origin);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req, { parsedBody: parsed });
    res.headers.set('cache-control', 'no-store');
    return res;
  } finally {
    await server.close();
  }
}
