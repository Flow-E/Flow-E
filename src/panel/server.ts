import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { loadSigningIssuer } from '../kya/store.js';
import { Ledger } from '../ledger/ledger.js';
import { createPanelApp, newPanelToken } from './app.js';

export const DEFAULT_PANEL_PORT = 4848;

export class PanelError extends Error {
  override name = 'PanelError';
}

export interface RunningPanel {
  /** Open this in a browser; the token travels in the fragment, which is never sent to servers. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Start the panel on the loopback interface only. Port 0 picks a free port. */
export async function startPanel(o: {
  home: string;
  configPath: string;
  port: number;
  actor: string;
  clock?: () => number;
}): Promise<RunningPanel> {
  const issuer = loadSigningIssuer(o.home);
  const ledger = Ledger.open(join(o.home, 'ledger.db'), {
    issuer: issuer.id,
    privateKey: issuer.privateKey,
  });
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    ledger.close();
    const code = (err as NodeJS.ErrnoException).code;
    throw new PanelError(
      code === 'EADDRINUSE'
        ? `Port ${String(o.port)} is in use. Is another panel running? Try --port.`
        : `Could not start the panel: ${(err as Error).message}`,
      { cause: err },
    );
  }
  // The Host check needs the real port, so the app is built once the server is listening.
  const port = (server.address() as AddressInfo).port;
  const token = newPanelToken();
  const app = createPanelApp({
    configPath: o.configPath,
    ledger,
    publicKey: issuer.publicKey,
    token,
    port,
    actor: o.actor,
    ...(o.clock ? { clock: o.clock } : {}),
  });
  const listener = getRequestListener(app.fetch);
  server.on('request', (req, res) => {
    void listener(req, res);
  });
  return {
    url: `http://127.0.0.1:${String(port)}/#token=${token}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          ledger.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
