import type { AccessPrincipal } from '@shared/access-control.interface';
import type { ContractManagementItem, ContractManagementDashboard, ContractPaymentFollowUpItem } from '@shared/contract-management.interface';
import { hasBusinessPermissionSomewhere, type BusinessAction } from '@shared/business-permissions';
import { canManageProfessionalRecord } from '@shared/professional-access';

export type ContractPermissionScope = Pick<ContractManagementItem, 'specialty' | 'buildings'>;
/** Omitted scope is a page affordance; null means a record whose scope is unknown. */
export function canUseContractAction(principal: AccessPrincipal, action: BusinessAction, scope?: ContractPermissionScope | null): boolean {
  return scope === undefined
    ? hasBusinessPermissionSomewhere(principal, { module:'contracts', action })
    : canManageProfessionalRecord(principal, scope?.specialty, scope?.buildings, { module:'contracts', action });
}
export function contractPaymentPermissions(principal: AccessPrincipal, available: {create:boolean;adjust:boolean;confirm:boolean;noPaymentRequired:boolean}, scope: ContractPermissionScope | null) {
  return {
    create:available.create && canUseContractAction(principal,'create',scope),
    adjust:available.adjust && canUseContractAction(principal,'update',scope),
    confirm:available.confirm && canUseContractAction(principal,'confirm',scope),
    noPaymentRequired:available.noPaymentRequired && canUseContractAction(principal,'update',scope),
  };
}
export function findContractPermissionScope(dashboard: ContractManagementDashboard, recordId: string): ContractManagementItem | null {
  return [...dashboard.contracts,...(dashboard.unsignedContracts || [])].find(item=>item.recordId===recordId) || null;
}
export function canOpenContractPayment(principal:AccessPrincipal,item:ContractPaymentFollowUpItem,scope:ContractPermissionScope|null):boolean {
  return canUseContractAction(principal,'create',scope) || canUseContractAction(principal,'update',scope) ||
    item.unpaidPlanCount>0 && canUseContractAction(principal,'confirm',scope);
}
