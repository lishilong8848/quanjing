import type { AccessPrincipal } from '@shared/access-control.interface';
import { businessAuthorizationSnapshot, businessPermissionScopeKey } from '@shared/business-permissions';

export function purchaseUiPrincipal(access: AccessPrincipal & {principalFingerprint?:string|null}) {
  return {...businessAuthorizationSnapshot(access),principalFingerprint:access.principalFingerprint};
}
export function purchaseUiPrincipalKey(access: AccessPrincipal & {principalFingerprint?:string|null}): string {
  return `${businessPermissionScopeKey(access)}:${access.principalFingerprint || ''}`;
}
