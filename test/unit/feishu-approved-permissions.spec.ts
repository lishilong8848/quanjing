import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import {
  APPROVED_FEISHU_APP_ID,
  APPROVED_FEISHU_GRANTS,
  feishuIdentityFingerprint,
  resolveApprovedFeishuPrincipal,
} from '../../server/common/access/feishu-access-approved-grants';
import { FeishuAccessService } from '../../server/common/access/feishu-access.service';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { assertInventoryMovementDeletionScope } from '../../server/modules/inventory-management/inventory-access-policy';
import { PurchaseAccessPolicyService } from '../../server/modules/purchase-inventory/purchase-access-policy.service';
import { canAccessPage } from '../../client/src/access/access-policy';

describe('approved application-bound Feishu permissions', () => {
  const previousSecret = process.env.LOCAL_ACCESS_SESSION_SECRET;
  beforeEach(() => {
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 29).toString(
      'base64',
    );
  });
  afterAll(() => {
    if (previousSecret === undefined)
      delete process.env.LOCAL_ACCESS_SESSION_SECRET;
    else process.env.LOCAL_ACCESS_SESSION_SECRET = previousSecret;
  });

  it('contains only unique identity fingerprints and the approved role counts', () => {
    expect(APPROVED_FEISHU_GRANTS).toHaveLength(17);
    expect(
      new Set(APPROVED_FEISHU_GRANTS.map((g) => g.identityHash)).size,
    ).toBe(17);
    for (const grant of APPROVED_FEISHU_GRANTS)
      expect(grant.identityHash).toMatch(/^[a-f0-9]{64}$/);
    const counts = Object.fromEntries(
      [
        'admin',
        'editor',
        'purchase_admin',
        'building_admin',
        'inventory_admin',
      ].map((role) => [
        role,
        APPROVED_FEISHU_GRANTS.filter((g) => g.role === role).length,
      ]),
    );
    expect(counts).toEqual({
      admin: 3,
      editor: 1,
      purchase_admin: 1,
      building_admin: 6,
      inventory_admin: 6,
    });
  });

  it('binds fingerprints to both the application and the exact verified Open ID', () => {
    const hash = feishuIdentityFingerprint(
      APPROVED_FEISHU_APP_ID,
      'ou_test_verified_person',
    );
    expect(hash).not.toBe(
      feishuIdentityFingerprint(
        'cli_other_application',
        'ou_test_verified_person',
      ),
    );
    expect(hash).not.toBe(
      feishuIdentityFingerprint(APPROVED_FEISHU_APP_ID, 'ou_test_other_person'),
    );
    expect(
      resolveApprovedFeishuPrincipal(APPROVED_FEISHU_APP_ID, hash),
    ).toBeNull();
  });

  it.each(APPROVED_FEISHU_GRANTS)(
    'roundtrips a signed $role / $purchaseBuilding session',
    (grant) => {
      const principal = resolveApprovedFeishuPrincipal(
        APPROVED_FEISHU_APP_ID,
        grant.identityHash,
      )!;
      expect(principal).toEqual({
        role: grant.role,
        purchaseBuilding: grant.purchaseBuilding,
      });
      expect(
        resolveApprovedFeishuPrincipal(
          'cli_other_application',
          grant.identityHash,
        ),
      ).toBeNull();
      const access = new UnifiedAccessService();
      const login = access.issueTrustedSession(principal);
      expect(access.readSession(login.token).principal).toEqual(principal);
      expect(access.readSession(login.token + 'tampered').principal.role).toBe(
        'guest',
      );
    },
  );

  it.each(APPROVED_FEISHU_GRANTS.filter((g) => g.purchaseBuilding !== null))(
    'restricts $role / $purchaseBuilding to its own warehouse',
    (grant) => {
      const principal = resolveApprovedFeishuPrincipal(
        APPROVED_FEISHU_APP_ID,
        grant.identityHash,
      )!;
      expect(
        assertInventoryMovementDeletionScope(principal, grant.purchaseBuilding),
      ).toBe(grant.purchaseBuilding);
      const otherBuilding = grant.purchaseBuilding === 'A楼' ? 'B楼' : 'A楼';
      expect(() =>
        assertInventoryMovementDeletionScope(principal, otherBuilding),
      ).toThrow(ForbiddenException);
      expect(canAccessPage(principal.role, '/contract-management')).toBe(false);
      if (principal.role === 'building_admin') {
        const purchase = new PurchaseAccessPolicyService({} as never);
        expect(
          purchase.assertRequestedBuilding(principal, grant.purchaseBuilding),
        ).toBe(grant.purchaseBuilding);
        expect(() =>
          purchase.assertRequestedBuilding(principal, otherBuilding),
        ).toThrow(ForbiddenException);
        expect(
          canAccessPage(principal.role, '/purchase-inventory-management'),
        ).toBe(true);
      } else {
        expect(
          canAccessPage(principal.role, '/purchase-inventory-management'),
        ).toBe(false);
      }
    },
  );

  it('gives the purchase role contracts without full system administration', () => {
    expect(canAccessPage('purchase_admin', '/contract-management')).toBe(true);
    expect(
      canAccessPage('purchase_admin', '/purchase-inventory-management'),
    ).toBe(true);
    expect(canAccessPage('purchase_admin', '/inventory-management')).toBe(
      false,
    );
  });

  it.each(['invalid', true, 1])(
    'rejects malformed approved-grants switch %p',
    (enabled) => {
      expect(
        () =>
          new FeishuAccessService(
            new ConfigService({
              FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: enabled,
            }),
            {} as never,
          ),
      ).toThrow('FEISHU_ACCESS_APPROVED_GRANTS_ENABLED');
    },
  );
});
