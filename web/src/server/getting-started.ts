import { can, type Permission, type Role } from './permissions';

/**
 * The getting-started checklist of a new organisation. Every step's "done" comes from the
 * organisation's own data, so the list is the same for everyone who opens it and goes away for
 * all of them once the first request has arrived. Pure, so it is easy to test.
 */

export type StepId = 'agent' | 'key' | 'connect' | 'request' | 'prices' | 'approver';

export interface ChecklistStep {
  id: StepId;
  label: string;
  /** What to do, in a sentence, for a step that is not done yet. */
  hint: string;
  done: boolean;
  optional: boolean;
  /** Where to do it, or null when there is nothing to click (or this role cannot do it). */
  href: string | null;
}

export interface Checklist {
  steps: ChecklistStep[];
  /** The required steps (agent, key, connect, first request) are all done: hide the panel. */
  complete: boolean;
  /** Required steps done, out of `required`. */
  doneCount: number;
  required: number;
}

/** The slice of an organisation view the checklist reads. */
export interface ChecklistInput {
  base: string;
  role: Role;
  agents: readonly { id: string; keys: readonly { lastUsedAt: string | null }[] }[];
  /** Payments in the ledger (any status). */
  payments: number;
  /** `view.raw.reference_prices`: the mandate's usual prices, as stored. */
  referencePrices: unknown;
  members: number;
  /** Invitations still waiting to be accepted. */
  pendingInvitations: number;
}

export function gettingStarted(input: ChecklistInput): Checklist {
  const { base, role, agents } = input;
  const first = agents[0];
  // Keys are shown once and then only by prefix; any key, even a revoked one, means one was made.
  const keyed = agents.find((a) => a.keys.length > 0);
  const agentPage = (a: { id: string } | undefined) =>
    a ? `${base}/agents/${encodeURIComponent(a.id)}` : `${base}/agents`;
  const link = (permission: Permission, href: string) => (can(role, permission) ? href : null);

  const hasAgent = agents.length > 0;
  const hasKey = keyed !== undefined;
  const hasRequest = input.payments > 0;
  // A key that was used, or a request that arrived, proves a client is connected.
  const connected = hasRequest || agents.some((a) => a.keys.some((k) => k.lastUsedAt !== null));
  const prices = Array.isArray(input.referencePrices) && input.referencePrices.length > 0;

  const steps: ChecklistStep[] = [
    {
      id: 'agent',
      label: 'Create an agent',
      hint: 'Give it a name and a starting mandate: limits, suppliers and a daily budget.',
      done: hasAgent,
      optional: false,
      href: link('agent.create', `${base}/agents`),
    },
    {
      id: 'key',
      label: 'Create an API key for it',
      hint: 'The agent signs in to Flow-E with this key.',
      done: hasKey,
      optional: false,
      href: hasAgent ? link('agent.keys', agentPage(first)) : null,
    },
    {
      id: 'connect',
      label: 'Connect Claude or another MCP client',
      hint: 'Add the Flow-E endpoint and the key to the client.',
      done: connected,
      optional: false,
      href: hasKey ? link('agent.keys', `${agentPage(keyed)}#connect`) : null,
    },
    {
      id: 'request',
      label: 'The first request arrives',
      hint: 'Ask the agent to buy something small. Its request shows up here.',
      done: hasRequest,
      optional: false,
      href: null,
    },
    {
      id: 'prices',
      label: 'Add usual prices',
      hint: 'Flow-E then flags offers far above or below them.',
      done: prices,
      optional: true,
      href: link('mandate.update', `${base}/mandate`),
    },
    {
      id: 'approver',
      label: 'Invite a colleague as approver',
      hint: 'So someone else can approve when you are away.',
      done: input.members > 1 || input.pendingInvitations > 0,
      optional: true,
      href: link('member.invite', `${base}/members`),
    },
  ];
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  return { steps, complete: doneCount === required.length, doneCount, required: required.length };
}
