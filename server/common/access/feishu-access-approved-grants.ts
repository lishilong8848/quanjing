import { createHash } from 'node:crypto';
import type { PrivilegedAccessPrincipal } from '../../../shared/access-control.interface';

export const APPROVED_FEISHU_APP_ID = 'cli_0831564613853b26';

export const APPROVED_FEISHU_GRANTS = [
  {
    identityHash:
      '88d66ada4301968d99369cb7fb3bd32d797e75b73a5c46eae5d1681b7f1747bc',
    role: 'admin',
    purchaseBuilding: null,
  },
  {
    identityHash:
      'fbae4855ebfba28080a12f431891f33a60d1335a9362009609422b38acc4fda5',
    role: 'admin',
    purchaseBuilding: null,
  },
  {
    identityHash:
      '91bd47ed7d18acfa3ee8f1ed74fe39e43e45e54c98e0060894925fd761f27c35',
    role: 'admin',
    purchaseBuilding: null,
  },
  {
    identityHash:
      'e7ce66e934650e6b5f1c9a6bfdbc71317cf8ec402a04f5173785f1fbcfe9ff61',
    role: 'purchase_admin',
    purchaseBuilding: null,
  },
  {
    identityHash:
      '0a7bab0c6e7b98e7fe5a6df95831fcc87a699fd146b772976165d0e7872b3be5',
    role: 'building_admin',
    purchaseBuilding: 'A楼',
  },
  {
    identityHash:
      '6a28a8caaa5ce1052b7665dfec2d74b048dd15e4c529b2ace81b36cf13a5f8cc',
    role: 'building_admin',
    purchaseBuilding: 'B楼',
  },
  {
    identityHash:
      'bab4d7a4b8d75a5c725edcad5978a0fe910c067862623e804d39781808e4128a',
    role: 'building_admin',
    purchaseBuilding: 'C楼',
  },
  {
    identityHash:
      '672a6eb2933bc86d3ba5e79a7d46c92a23894f79e909ccfcfb19cea1bc4004a4',
    role: 'building_admin',
    purchaseBuilding: 'D楼',
  },
  {
    identityHash:
      'b4adfd9f97d36b62eed9a77ba0babf375dfb16ba8969664fffd6f5c310862643',
    role: 'building_admin',
    purchaseBuilding: 'E楼',
  },
  {
    identityHash:
      '51642767580a07e2fd3cfea5d00f3880fe051563009902d48876c28254680122',
    role: 'building_admin',
    purchaseBuilding: 'H楼',
  },
  {
    identityHash:
      '658556e578cb0035248d0ab05efc8812de07900bf8ab2194037caa12a2dd0403',
    role: 'inventory_admin',
    purchaseBuilding: 'C楼',
  },
  {
    identityHash:
      '9640ecb4739288b2be7e6ecf514f9d703eebdca2e1668a3847535f0bfd879415',
    role: 'inventory_admin',
    purchaseBuilding: 'B楼',
  },
  {
    identityHash:
      '3d4a560bc4f2e56a416b7045f49c50b2d13b0aa39e5c7bc45a98fe4c49a02d34',
    role: 'inventory_admin',
    purchaseBuilding: 'H楼',
  },
  {
    identityHash:
      'f1da3a1fe0d0beea33896bd171a8b7a7b1fd8a26db3a607f1ed662bfa793ae83',
    role: 'inventory_admin',
    purchaseBuilding: 'E楼',
  },
  {
    identityHash:
      'f623ae4aab2221afacb61d92556d0fbf5eaa01ba7c3d7b61bf91465041b363af',
    role: 'inventory_admin',
    purchaseBuilding: 'A楼',
  },
  {
    identityHash:
      '7007f647f9f2a74a32e05b44d8048da21bec459725699878646be4f11c56d385',
    role: 'inventory_admin',
    purchaseBuilding: 'E楼',
  },
  {
    identityHash:
      '5bbc8de19e7eec392b57e22940639bd9933b13e40e5d7a0a806845fe3a957b21',
    role: 'editor',
    purchaseBuilding: null,
  },
] as const satisfies readonly (PrivilegedAccessPrincipal & {
  identityHash: string;
})[];

export function feishuIdentityFingerprint(
  appId: string,
  openId: string,
): string {
  return createHash('sha256')
    .update(appId + '\0' + openId)
    .digest('hex');
}

export function resolveApprovedFeishuPrincipal(
  appId: string,
  identityHash: string,
): PrivilegedAccessPrincipal | null {
  if (appId !== APPROVED_FEISHU_APP_ID) return null;
  const grant = APPROVED_FEISHU_GRANTS.find(
    (item) => item.identityHash === identityHash,
  );
  return grant
    ? { role: grant.role, purchaseBuilding: grant.purchaseBuilding }
    : null;
}
