import { describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  PERMISSIONS,
  ROLES,
  assertCan,
  can,
  type Permission,
  type Role,
} from '@/server/permissions';

/**
 * The matrix, written out by hand so a change to permissions.ts has to be made twice on
 * purpose. o = owner, a = approver, v = viewer.
 */
const EXPECTED: Record<Permission, string> = {
  'org.read': 'oav',
  'payment.resolve': 'oa',
  'payment.cancel': 'oa',
  'payment.fulfil': 'oa',
  'invoice.record': 'oa',
  'agent.freeze': 'oa',
  'killswitch.set': 'oa',
  'reorder.manage': 'oa',
  'reorder.run': 'oa',
  'mandate.update': 'o',
  'agent.create': 'o',
  'agent.keys': 'o',
  'member.invite': 'o',
  'member.manage': 'o',
  'org.settings': 'o',
};

const letter: Record<Role, string> = { owner: 'o', approver: 'a', viewer: 'v' };

describe('permission matrix', () => {
  it('covers exactly the expected permissions', () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const permission of Object.keys(EXPECTED) as Permission[]) {
    for (const role of ROLES) {
      const allowed = EXPECTED[permission].includes(letter[role]);
      it(`${role} ${allowed ? 'may' : 'may not'} ${permission}`, () => {
        expect(can(role, permission)).toBe(allowed);
        if (allowed)
          expect(() => {
            assertCan(role, permission);
          }).not.toThrow();
        else
          expect(() => {
            assertCan(role, permission);
          }).toThrow(ForbiddenError);
      });
    }
    it(`a non-member may not ${permission}`, () => {
      expect(can(null, permission)).toBe(false);
      expect(() => {
        assertCan(null, permission);
      }).toThrow(ForbiddenError);
    });
  }
});
