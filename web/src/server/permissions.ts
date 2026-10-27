/**
 * Who may do what in an organisation. The only place roles are defined: every server action,
 * route and store method asks `assertCan` with the role read from the database, never from a
 * form or the URL. Pure, so it is easy to test exhaustively.
 */

export const ROLES = ['owner', 'approver', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  /** See the organisation: overview, payments, ledger, agents, members, mandate. */
  'org.read': ['owner', 'approver', 'viewer'],
  /** Approve or decline a payment waiting for review. */
  'payment.resolve': ['owner', 'approver'],
  /** Cancel an approved payment inside its cooling-off window. */
  'payment.cancel': ['owner', 'approver'],
  /** Record that an approved payment was ordered, and match the supplier's invoice. */
  'payment.fulfil': ['owner', 'approver'],
  /** Freeze or unfreeze one agent. */
  'agent.freeze': ['owner', 'approver'],
  /** Turn the organisation's kill switch on or off. */
  'killswitch.set': ['owner', 'approver'],
  /** Change the mandate: limits, suppliers, countries, statuses. */
  'mandate.update': ['owner'],
  /** Create agents. */
  'agent.create': ['owner'],
  /** Create, rotate and revoke agent keys. */
  'agent.keys': ['owner'],
  /** Invite people and revoke invitations. */
  'member.invite': ['owner'],
  /** Change roles and remove members. */
  'member.manage': ['owner'],
  /** Rename the organisation. */
  'org.settings': ['owner'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  approver: 'Approver',
  viewer: 'Viewer',
};

export const ROLE_SUMMARY: Record<Role, string> = {
  owner: 'Everything: agents, keys, mandate, members and settings.',
  approver: 'Approves and declines payments, freezes agents, uses the kill switch.',
  viewer: 'Sees everything, changes nothing.',
};

/** Thrown when a signed-in person lacks the role for an action. Safe to show. */
export class ForbiddenError extends Error {
  override name = 'ForbiddenError';
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function assertCan(role: Role | null | undefined, permission: Permission): void {
  if (!role) throw new ForbiddenError('You are not a member of this organisation.');
  if (!can(role, permission)) {
    const allowed = (PERMISSIONS[permission] as readonly Role[]).map((r) => ROLE_LABEL[r]);
    throw new ForbiddenError(
      `Your role (${ROLE_LABEL[role]}) cannot do this. It needs: ${allowed.join(' or ')}.`,
    );
  }
}
