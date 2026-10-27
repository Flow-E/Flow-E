import { can, type Permission, type Role } from './permissions';

/**
 * The getting-started checklist of a new organisation: six steps, each done from the
 * organisation's own data, so the list is the same for everyone who opens it and goes away for
 * all of them once every step is done. Pure, so it is easy to test.
 */

export type StepId = 'agent' | 'mandate' | 'prices' | 'connect' | 'request' | 'approver';

export interface ChecklistStep {
  id: StepId;
  label: string;
  /** What to do, in a sentence, for a step that is not done yet. */
  hint: string;
  /** When the step counts as done, in plain words. */
  doneWhen: string;
  done: boolean;
  /** Where to do it, or null when there is nothing to click (or this role cannot do it). */
  href: string | null;
}

export interface Checklist {
  steps: ChecklistStep[];
  /** Every step is done: hide the panel. */
  complete: boolean;
  doneCount: number;
  total: number;
}

/** The slice of an organisation view the checklist reads. */
export interface ChecklistInput {
  base: string;
  role: Role;
  agents: readonly { id: string; keys: readonly { lastUsedAt: string | null }[] }[];
  /** Payments in the ledger (any status). */
  payments: number;
  /** Ledger entry types, e.g. from `view.entries`. */
  entryTypes: readonly string[];
  /** `view.raw.reference_prices`: the mandate's usual prices, as stored. */
  referencePrices: unknown;
  members: readonly { role: Role }[];
  invitations: readonly { role: Role; status: string }[];
}

const decides = (role: Role) => role === 'owner' || role === 'approver';

export function gettingStarted(input: ChecklistInput): Checklist {
  const { base, role, agents } = input;
  // Keys are shown once and then only by prefix; the connect link goes to an agent with a key.
  const keyed = agents.find((a) => a.keys.length > 0) ?? agents[0];
  const agentPage = (a: { id: string } | undefined) =>
    a ? `${base}/agents/${encodeURIComponent(a.id)}` : `${base}/agents`;
  const link = (permission: Permission, href: string) => (can(role, permission) ? href : null);

  const hasAgent = agents.length > 0;
  const hasRequest = input.payments > 0;
  // A key that was used, or a request that arrived, proves a client is connected.
  const connected = hasRequest || agents.some((a) => a.keys.some((k) => k.lastUsedAt !== null));
  const prices = Array.isArray(input.referencePrices) && input.referencePrices.length > 0;
  // Creating an agent writes its starting limits; only a saved change on the Mandate page counts.
  const mandateSet = input.entryTypes.includes('config.updated');
  // Someone besides the first owner who can approve, or an invitation for one.
  const approver =
    input.members.filter((m) => decides(m.role)).length > 1 ||
    input.invitations.some((i) => i.status === 'pending' && decides(i.role));

  const steps: ChecklistStep[] = [
    {
      id: 'agent',
      label: 'Create an agent',
      hint: 'Give it a name, a responsible owner and starting limits.',
      doneWhen: 'Done when the organisation has an agent.',
      done: hasAgent,
      href: link('agent.create', `${base}/agents`),
    },
    {
      id: 'mandate',
      label: 'Set the mandate',
      hint: 'Check the budgets, suppliers, categories and approval threshold, then save.',
      doneWhen: 'Done once a change to the mandate has been saved.',
      done: mandateSet,
      href: link('mandate.update', `${base}/mandate`),
    },
    {
      id: 'prices',
      label: 'Upload a price list',
      hint: 'Usual prices let Flow-E flag offers far above or below them.',
      doneWhen: 'Done when the mandate has at least one usual price.',
      done: prices,
      href: link('mandate.update', `${base}/mandate`),
    },
    {
      id: 'connect',
      label: 'Connect the agent',
      hint: 'Create an API key and add it with the Flow-E endpoint to Claude or another MCP client.',
      doneWhen: 'Done when a key has been used or a request has arrived.',
      done: connected,
      href: hasAgent ? link('agent.keys', `${agentPage(keyed)}#connect`) : null,
    },
    {
      id: 'request',
      label: 'Make a first test request',
      hint: 'Ask the agent to buy something small. Its request shows up on the dashboard.',
      doneWhen: 'Done when the first payment request is in the ledger.',
      done: hasRequest,
      href: null,
    },
    {
      id: 'approver',
      label: 'Invite an approver',
      hint: 'So someone else can approve when you are away.',
      doneWhen: 'Done when a second owner or approver has joined or been invited.',
      done: approver,
      href: link('member.invite', `${base}/members`),
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, complete: doneCount === steps.length, doneCount, total: steps.length };
}
