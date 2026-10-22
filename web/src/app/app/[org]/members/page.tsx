import type { Metadata } from 'next';
import { Panel, Pill } from '@/components/ui';
import { dateTime } from '@/lib/format';
import { ROLES, ROLE_LABEL, ROLE_SUMMARY, can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { ActionButton } from '../../../sandbox/client';
import {
  changeRoleAction,
  inviteAction,
  removeMemberAction,
  revokeInvitationAction,
} from '../../actions';
import { InviteForm, RoleForm } from '../../client';

export const metadata: Metadata = { title: 'Members' };

export default async function MembersPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const { user, view } = await orgView(org);
  const manage = can(view.role, 'member.manage');
  const invite = can(view.role, 'member.invite');
  const pending = view.invitations.filter((i) => i.status === 'pending');
  const owners = view.members.filter((m) => m.role === 'owner').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="mt-1 max-w-[70ch] text-ink-2">
          Who can see and act on this organisation. Every change is recorded in the ledger.
        </p>
      </div>

      <Panel title={`People (${String(view.members.length)})`}>
        <ul className="divide-y divide-rule">
          {view.members.map((m) => {
            const lastOwner = m.role === 'owner' && owners <= 1;
            return (
              <li
                key={m.userId}
                className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">
                    {m.email}
                    {m.userId === user.userId ? <span className="text-ink-3"> (you)</span> : null}
                  </p>
                  <p className="text-xs text-ink-3">Since {dateTime(m.addedAt, view.timezone)}</p>
                </div>
                {manage && !lastOwner ? (
                  <>
                    <RoleForm
                      action={changeRoleAction}
                      org={view.id}
                      memberId={m.userId}
                      role={m.role}
                      who={m.email}
                    />
                    <ActionButton
                      action={removeMemberAction}
                      fields={{ org: view.id, memberId: m.userId }}
                      label={m.userId === user.userId ? 'Leave' : 'Remove'}
                      confirm="Click again to remove"
                      variant="quiet"
                    />
                  </>
                ) : (
                  <Pill tone={m.role === 'viewer' ? 'neutral' : 'accent'}>
                    {ROLE_LABEL[m.role]}
                  </Pill>
                )}
                {manage && lastOwner ? (
                  <p className="w-full text-xs text-ink-3">
                    The only owner: make someone else owner first to change this.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Panel>

      {invite ? (
        <Panel
          title="Invite someone"
          description="They get an email with a one-time link, valid for 7 days. They must sign in with this address to accept."
        >
          <InviteForm action={inviteAction} org={view.id} />
        </Panel>
      ) : null}

      {pending.length > 0 ? (
        <Panel title="Open invitations">
          <ul className="divide-y divide-rule">
            {pending.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ink">
                    {i.email} <span className="text-ink-3">as {ROLE_LABEL[i.role]}</span>
                  </p>
                  <p className="text-xs text-ink-3">
                    By {i.invitedBy} · expires {dateTime(i.expiresAt, view.timezone)}
                  </p>
                </div>
                {invite ? (
                  <ActionButton
                    action={revokeInvitationAction}
                    fields={{ org: view.id, invitationId: i.id }}
                    label="Revoke"
                    variant="quiet"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Roles">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
          {ROLES.map((r) => (
            <div key={r} className="contents">
              <dt className="font-medium text-ink">{ROLE_LABEL[r]}</dt>
              <dd className="text-ink-2">{ROLE_SUMMARY[r]}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}
