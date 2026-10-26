import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  AccessLoginAccountType,
  AccessPrincipal,
  PurchaseAccessBuilding,
} from '../../shared/access-control.interface';

type ReauthenticationLoginDefaults = {
  accountType: AccessLoginAccountType | '';
  purchaseBuilding: PurchaseAccessBuilding | '';
};

type ReauthenticationDefaultsResolver = (
  principal: AccessPrincipal,
) => ReauthenticationLoginDefaults;

const accessPolicy = require('../../client/src/access/access-policy') as {
  getReauthenticationLoginDefaults?: ReauthenticationDefaultsResolver;
};

function resolveDefaults(
  principal: AccessPrincipal,
): ReauthenticationLoginDefaults {
  expect(accessPolicy.getReauthenticationLoginDefaults).toEqual(
    expect.any(Function),
  );
  return accessPolicy.getReauthenticationLoginDefaults!(principal);
}

describe('unified access reauthentication defaults', () => {
  it.each(['admin', 'editor', 'purchase_admin', 'construction_admin'] as const)(
    'restores local password identity %s after expiry',
    (role) => {
      expect(resolveDefaults({ role, purchaseBuilding: null })).toEqual({
        accountType: role,
        purchaseBuilding: '',
      });
    },
  );

  it.each(['inventory_admin', 'purchase_applicant'] as const)(
    'restores building for scoped identity %s after expiry',
    (role) => {
      expect(resolveDefaults({ role, purchaseBuilding: 'E楼' })).toEqual({
        accountType: role,
        purchaseBuilding: 'E楼',
      });
    },
  );

  it.each(['guest', 'duty_editor', 'supply_chain_admin'] as const)(
    'does not misrepresent non-local identity %s as a password account',
    (role) => {
      expect(resolveDefaults({ role, purchaseBuilding: null })).toEqual({
        accountType: '',
        purchaseBuilding: '',
      });
    },
  );

  it('remembers the previous identity without auto-opening a dialog on session loss', () => {
    const source = readFileSync(
      resolve('client/src/access/AccessProvider.tsx'),
      'utf8',
    );

    expect(source).toContain('lastReauthenticationLoginRef');
    expect(source).toContain('rememberReauthenticationLogin');
    expect(source).toContain('markReauthenticationPending');
    expect(source).toContain('markSessionExpired');
    expect(source).toContain('initialPurchaseBuilding=');
    expect(source).toContain('setPurchaseBuilding(initialPurchaseBuilding);');
    expect(source).not.toContain('shouldRequestLoginAfterInvalidation');
    expect(source).not.toContain('requestReauthentication');
    expect(source).toMatch(/remainingMs <= 0[\s\S]*?markSessionExpired\(\)/);
    expect(source).toMatch(
      /window\.setTimeout\(\(\) => \{[\s\S]*?markSessionExpired\(\)/,
    );
  });
});
