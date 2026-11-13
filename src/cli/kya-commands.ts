import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { ConfigError, parseConfig } from '../config/schema.js';
import { issueCredential, PAYMENT_SCOPE } from '../kya/credential.js';
import { initIssuer, loadSigningIssuer, writeCredential } from '../kya/store.js';

/** Command bodies, kept apart from commander so tests can call them directly. Return the output. */

const EXAMPLE_CONFIG = new URL('../../mandate.example.yaml', import.meta.url);

export function runInit(o: { home: string; config: string }): string {
  const issuer = initIssuer(o.home);
  const lines = [
    `Created issuer ${issuer.id}`,
    `  private key: ${o.home}/issuer.key (keep secret; never share or commit)`,
    `  public key:  ${o.home}/issuer.pub`,
  ];
  if (existsSync(o.config)) {
    lines.push(`Kept your existing ${o.config}.`);
  } else {
    copyFileSync(EXAMPLE_CONFIG, o.config);
    lines.push(`Wrote a starter ${o.config} (fictional example; edit it for your agents).`);
  }
  lines.push('Next: mandate agent add <id>');
  return lines.join('\n');
}

export interface AgentAddOptions {
  home: string;
  config: string;
  id: string;
  name?: string | undefined;
  org?: string | undefined;
  days: number;
  scope: string[];
  force: boolean;
  now: number;
}

export function runAgentAdd(o: AgentAddOptions): string {
  const config = parseConfig(readFileSync(o.config, 'utf8'));
  const agent = config.agents[o.id];
  if (!agent) {
    const known = Object.keys(config.agents).join(', ') || 'none';
    throw new ConfigError(
      `Agent "${o.id}" is not in ${o.config} (agents: ${known}). Add its mandate there first.`,
    );
  }
  const organisation = o.org ?? config.organisation;
  if (!organisation) {
    throw new ConfigError(`Set "organisation" in ${o.config} or pass --org.`);
  }
  const issuer = loadSigningIssuer(o.home);
  const credential = issueCredential({
    privateKey: issuer.privateKey,
    publicKey: issuer.publicKey,
    agentId: o.id,
    agentName: o.name ?? o.id,
    owner: agent.owner,
    organisation,
    scope: o.scope,
    now: o.now,
    validDays: o.days,
  });
  const path = writeCredential(o.home, credential, o.force);
  const c = credential.claims;
  return [
    `Issued credential for agent "${c.agent_id}" → ${path}`,
    `  issuer:  ${c.issuer}`,
    `  owner:   ${c.owner} (${c.organisation})`,
    `  scope:   ${c.scope.join(', ')}`,
    `  valid:   ${c.issued_at} → ${c.expires_at}`,
    'Treat the file like a password: whoever holds it can act as this agent.',
  ].join('\n');
}

export const DEFAULT_SCOPE = [PAYMENT_SCOPE];
