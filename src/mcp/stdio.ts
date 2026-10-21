import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMandateServer, type MandateServerOptions } from './server.js';

/** Serve one agent over stdio. stdout carries the protocol, so every log line goes to stderr. */
export async function serveStdio(o: MandateServerOptions): Promise<void> {
  const mandate = createMandateServer(o);
  const transport = new StdioServerTransport();
  const shutdown = () => {
    mandate.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  transport.onclose = () => {
    mandate.close();
  };
  await mandate.server.connect(transport);
  process.stderr.write(
    `imprest: serving agent "${o.agentId}" (issuer ${mandate.issuerId}) on stdio\n`,
  );
}
