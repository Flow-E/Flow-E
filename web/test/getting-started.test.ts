import { describe, expect, it } from 'vitest';
import { gettingStarted, type ChecklistInput, type StepId } from '@/server/getting-started';

const BASE = '/app/acme';

function input(over: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    base: BASE,
    role: 'owner',
    agents: [],
    payments: 0,
    referencePrices: undefined,
    members: 1,
    pendingInvitations: 0,
    ...over,
  };
}

const done = (c: ReturnType<typeof gettingStarted>) =>
  Object.fromEntries(c.steps.map((s) => [s.id, s.done])) as Record<StepId, boolean>;
const href = (c: ReturnType<typeof gettingStarted>, id: StepId) =>
  c.steps.find((s) => s.id === id)?.href;

describe('the getting-started checklist', () => {
  it('starts with nothing done, and links only what can be done next', () => {
    const c = gettingStarted(input());
    expect(c.complete).toBe(false);
    expect(c.doneCount).toBe(0);
    expect(c.required).toBe(4);
    expect(Object.values(done(c)).every((d) => !d)).toBe(true);
    expect(href(c, 'agent')).toBe(`${BASE}/agents`);
    expect(href(c, 'key')).toBeNull();
    expect(href(c, 'connect')).toBeNull();
    expect(href(c, 'request')).toBeNull();
    expect(href(c, 'prices')).toBe(`${BASE}/mandate`);
    expect(href(c, 'approver')).toBe(`${BASE}/members`);
  });

  it('follows the data: agent, key, use of the key', () => {
    const agent = { id: 'buyer', keys: [] };
    let c = gettingStarted(input({ agents: [agent] }));
    expect(done(c)).toMatchObject({ agent: true, key: false });
    expect(href(c, 'key')).toBe(`${BASE}/agents/buyer`);

    const second = { id: 'ops', keys: [{ lastUsedAt: null }] };
    c = gettingStarted(input({ agents: [agent, second] }));
    expect(done(c)).toMatchObject({ key: true, connect: false });
    // The connect link goes to the agent that has the key.
    expect(href(c, 'connect')).toBe(`${BASE}/agents/ops#connect`);

    c = gettingStarted(input({ agents: [{ id: 'ops', keys: [{ lastUsedAt: '2026-10-27' }] }] }));
    expect(done(c)).toMatchObject({ connect: true, request: false });
    expect(c.complete).toBe(false);
    expect(c.doneCount).toBe(3);
  });

  it('is complete once the first request arrived, optional steps or not', () => {
    const c = gettingStarted(
      input({ agents: [{ id: 'ops', keys: [{ lastUsedAt: null }] }], payments: 1 }),
    );
    // A request proves the client is connected, even before the key's last use is recorded.
    expect(done(c)).toMatchObject({ connect: true, request: true, prices: false, approver: false });
    expect(c.complete).toBe(true);
  });

  it('counts usual prices and colleagues (or an open invitation) for the optional steps', () => {
    expect(done(gettingStarted(input({ referencePrices: [] }))).prices).toBe(false);
    expect(done(gettingStarted(input({ referencePrices: [{ item: 'x' }] }))).prices).toBe(true);
    expect(done(gettingStarted(input({ referencePrices: 'nonsense' }))).prices).toBe(false);
    expect(done(gettingStarted(input({ members: 2 }))).approver).toBe(true);
    expect(done(gettingStarted(input({ pendingInvitations: 1 }))).approver).toBe(true);
  });

  it('gives approvers and viewers no links they cannot use', () => {
    const agents = [{ id: 'ops', keys: [{ lastUsedAt: null }] }];
    for (const role of ['approver', 'viewer'] as const) {
      const c = gettingStarted(input({ role, agents }));
      expect(c.steps.every((s) => s.href === null)).toBe(true);
      expect(done(c)).toMatchObject({ agent: true, key: true });
    }
  });

  it('encodes the agent id in links', () => {
    const c = gettingStarted(input({ agents: [{ id: 'a b', keys: [] }] }));
    expect(href(c, 'key')).toBe(`${BASE}/agents/a%20b`);
  });
});
