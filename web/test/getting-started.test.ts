import { describe, expect, it } from 'vitest';
import { gettingStarted, type ChecklistInput, type StepId } from '@/server/getting-started';

const BASE = '/app/acme';

function input(over: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    base: BASE,
    role: 'owner',
    agents: [],
    payments: 0,
    entryTypes: ['org.created'],
    referencePrices: undefined,
    members: [{ role: 'owner' }],
    invitations: [],
    ...over,
  };
}

const done = (c: ReturnType<typeof gettingStarted>) =>
  Object.fromEntries(c.steps.map((s) => [s.id, s.done])) as Record<StepId, boolean>;
const href = (c: ReturnType<typeof gettingStarted>, id: StepId) =>
  c.steps.find((s) => s.id === id)?.href;

describe('the getting-started checklist', () => {
  it('has the six steps in order, nothing done, linked to where each is done', () => {
    const c = gettingStarted(input());
    expect(c.steps.map((s) => s.id)).toEqual([
      'agent',
      'mandate',
      'prices',
      'connect',
      'request',
      'approver',
    ]);
    expect(c).toMatchObject({ complete: false, doneCount: 0, total: 6 });
    expect(Object.values(done(c)).every((d) => !d)).toBe(true);
    expect(href(c, 'agent')).toBe(`${BASE}/agents`);
    expect(href(c, 'mandate')).toBe(`${BASE}/mandate`);
    expect(href(c, 'prices')).toBe(`${BASE}/mandate`);
    expect(href(c, 'connect')).toBeNull(); // no agent to connect yet
    expect(href(c, 'request')).toBeNull();
    expect(href(c, 'approver')).toBe(`${BASE}/members`);
    // Each step says when it counts as done.
    expect(c.steps.every((s) => s.doneWhen.startsWith('Done '))).toBe(true);
  });

  it('create an agent: done when there is one', () => {
    const c = gettingStarted(input({ agents: [{ id: 'buyer', keys: [] }] }));
    expect(done(c).agent).toBe(true);
    expect(href(c, 'connect')).toBe(`${BASE}/agents/buyer#connect`);
  });

  it('set the mandate: done once a change was saved, not by creating an agent', () => {
    expect(done(gettingStarted(input({ entryTypes: ['agent.created'] }))).mandate).toBe(false);
    expect(
      done(gettingStarted(input({ entryTypes: ['agent.created', 'config.updated'] }))).mandate,
    ).toBe(true);
  });

  it('upload a price list: done when the mandate has usual prices', () => {
    expect(done(gettingStarted(input({ referencePrices: [] }))).prices).toBe(false);
    expect(done(gettingStarted(input({ referencePrices: 'nonsense' }))).prices).toBe(false);
    expect(done(gettingStarted(input({ referencePrices: [{ item: 'x' }] }))).prices).toBe(true);
  });

  it('connect the agent: done when a key was used or a request arrived', () => {
    const unused = { id: 'ops', keys: [{ lastUsedAt: null }] };
    expect(done(gettingStarted(input({ agents: [unused] }))).connect).toBe(false);
    const used = { id: 'ops', keys: [{ lastUsedAt: '2026-10-27T10:00:00Z' }] };
    expect(done(gettingStarted(input({ agents: [used] }))).connect).toBe(true);
    expect(done(gettingStarted(input({ agents: [unused], payments: 1 }))).connect).toBe(true);
    // The link goes to the agent that has a key.
    const c = gettingStarted(input({ agents: [{ id: 'buyer', keys: [] }, unused] }));
    expect(href(c, 'connect')).toBe(`${BASE}/agents/ops#connect`);
  });

  it('first test request: done when a payment exists', () => {
    expect(done(gettingStarted(input({ payments: 0 }))).request).toBe(false);
    expect(done(gettingStarted(input({ payments: 1 }))).request).toBe(true);
  });

  it('invite an approver: another owner or approver, or a pending invitation for one', () => {
    const approver = (over: Partial<ChecklistInput>) => done(gettingStarted(input(over))).approver;
    expect(approver({ members: [{ role: 'owner' }, { role: 'viewer' }] })).toBe(false);
    expect(approver({ members: [{ role: 'owner' }, { role: 'approver' }] })).toBe(true);
    expect(approver({ members: [{ role: 'owner' }, { role: 'owner' }] })).toBe(true);
    expect(approver({ invitations: [{ role: 'approver', status: 'pending' }] })).toBe(true);
    expect(approver({ invitations: [{ role: 'viewer', status: 'pending' }] })).toBe(false);
    expect(approver({ invitations: [{ role: 'approver', status: 'expired' }] })).toBe(false);
  });

  it('is complete, and hidden, only when all six are done', () => {
    const all = input({
      agents: [{ id: 'ops', keys: [{ lastUsedAt: '2026-10-27T10:00:00Z' }] }],
      entryTypes: ['config.updated'],
      referencePrices: [{ item: 'x' }],
      payments: 1,
      members: [{ role: 'owner' }, { role: 'approver' }],
    });
    expect(gettingStarted(all)).toMatchObject({ complete: true, doneCount: 6 });
    expect(gettingStarted({ ...all, referencePrices: [] })).toMatchObject({
      complete: false,
      doneCount: 5,
    });
  });

  it('gives approvers and viewers no links they cannot use', () => {
    const agents = [{ id: 'ops', keys: [{ lastUsedAt: null }] }];
    for (const role of ['approver', 'viewer'] as const) {
      const c = gettingStarted(input({ role, agents }));
      expect(c.steps.every((s) => s.href === null)).toBe(true);
      expect(done(c)).toMatchObject({ agent: true });
    }
  });

  it('encodes the agent id in links', () => {
    const c = gettingStarted(input({ agents: [{ id: 'a b', keys: [] }] }));
    expect(href(c, 'connect')).toBe(`${BASE}/agents/a%20b#connect`);
  });
});
