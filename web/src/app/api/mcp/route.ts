import { handleMcp, newLimiter } from '@/server/mcp-endpoint';
import { getOrgStore } from '@/server/runtime';

/**
 * The remote MCP endpoint for agents: POST /api/mcp with `Authorization: Bearer flowe_ak_…`.
 * The only path the site password gate lets through (agents cannot type a password); the key is
 * the authentication. See src/server/mcp-endpoint.ts.
 */

export const dynamic = 'force-dynamic';

const limiter = newLimiter();

function origin(request: Request): string {
  return process.env.FLOWE_SITE_URL?.replace(/\/+$/, '') ?? new URL(request.url).origin;
}

async function handle(request: Request): Promise<Response> {
  return handleMcp(request, { store: await getOrgStore(), limiter, origin: origin(request) });
}

export { handle as POST, handle as GET, handle as DELETE };
