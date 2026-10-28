import { businessAuthorizationSnapshot, isProfessionalBusinessPrincipal, validScopedBusinessPrincipal } from '../../../shared/business-permissions';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AccessPrincipal,
  AccessRole,
} from '../../../shared/access-control.interface';
import { readEnv } from '../../common/config/external-services.config';
import type { PurchaseWorkflowSession } from './purchase-workflow.service';

const OPERATOR_OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;
const OPERATOR_ENV: Partial<Record<AccessRole, string>> = {
  admin: 'PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID',
  editor: 'PURCHASE_WORKFLOW_EDITOR_OPERATOR_OPEN_ID',
  purchase_admin: 'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID',
  purchase_applicant: 'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID',
  building_admin: 'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID',
  supply_chain_admin: 'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID',
};

export interface ResolvePurchaseWorkflowSessionInput {
  principal: AccessPrincipal;
  getTenantAccessToken: () => Promise<string>;
  professionalOpenId?: string;
}

export async function resolvePurchaseWorkflowSession(
  input: ResolvePurchaseWorkflowSessionInput,
): Promise<PurchaseWorkflowSession> {
  if (isProfessionalBusinessPrincipal(input.principal)) {
    if (!validScopedBusinessPrincipal(input.principal)) throw new UnauthorizedException('业务授权身份无效');
    const openId = resolveWorkflowActorOpenId(input);
    if (!OPERATOR_OPEN_ID_PATTERN.test(openId)) throw new UnauthorizedException('当前人员未关联采购操作身份');
    return { accessToken: await input.getTenantAccessToken(), openId, userName: input.principal.displayName || '',
      accessRole: input.principal.role, specialties: input.principal.specialties ? [...input.principal.specialties] : undefined,
      purchaseBuilding: input.principal.purchaseBuilding, purchaseBuildings: input.principal.buildings ? [...input.principal.buildings] : undefined,
      permissionPrincipal: businessAuthorizationSnapshot(input.principal), authenticationMode: 'delegated-app' };
  }
  const role = input.principal.role;
  const operatorEnvironmentName = OPERATOR_ENV[role];
  if (!operatorEnvironmentName) {
    throw new UnauthorizedException('采购工作流权限不足');
  }
  const openId = resolveWorkflowActorOpenId(input);
  if (!OPERATOR_OPEN_ID_PATTERN.test(openId)) {
    throw new ServiceUnavailableException(
      `采购工作流未配置有效操作人：${operatorEnvironmentName}`,
    );
  }

  return {
    accessToken: await input.getTenantAccessToken(),
    openId,
    userName: '',
    accessRole: role,
    ...(input.principal.accountId ? { permissionPrincipal: businessAuthorizationSnapshot(input.principal) } : {}),
    ...(role === 'purchase_applicant' || role === 'building_admin'
      ? { purchaseBuilding: input.principal.purchaseBuilding, ...(input.principal.buildings ? { purchaseBuildings: [...input.principal.buildings] } : {}) }
      : {}),
    authenticationMode: 'delegated-app',
  };
}

export async function resolvePurchaseWorkflowReadSession(
  input: ResolvePurchaseWorkflowSessionInput,
): Promise<PurchaseWorkflowSession> {
  if (isProfessionalBusinessPrincipal(input.principal)) {
    if (!validScopedBusinessPrincipal(input.principal)) throw new UnauthorizedException('业务授权身份无效');
    const openId = resolveWorkflowActorOpenId(input);
    return { accessToken: await input.getTenantAccessToken(), openId, userName: input.principal.displayName || '',
      accessRole: input.principal.role, specialties: input.principal.specialties ? [...input.principal.specialties] : undefined,
      purchaseBuilding: input.principal.purchaseBuilding, purchaseBuildings: input.principal.buildings ? [...input.principal.buildings] : undefined,
      permissionPrincipal: businessAuthorizationSnapshot(input.principal), authenticationMode: 'delegated-app' };
  }
  const role = input.principal.role;
  const operatorEnvironmentName = OPERATOR_ENV[role];
  if (!operatorEnvironmentName) {
    throw new UnauthorizedException('采购工作流权限不足');
  }
  const configuredOpenId = resolveWorkflowActorOpenId(input);

  return {
    accessToken: await input.getTenantAccessToken(),
    openId: OPERATOR_OPEN_ID_PATTERN.test(configuredOpenId)
      ? configuredOpenId
      : '',
    userName: '',
    accessRole: role,
    ...(input.principal.accountId ? { permissionPrincipal: businessAuthorizationSnapshot(input.principal) } : {}),
    ...(role === 'purchase_applicant' || role === 'building_admin'
      ? { purchaseBuilding: input.principal.purchaseBuilding, ...(input.principal.buildings ? { purchaseBuildings: [...input.principal.buildings] } : {}) }
      : {}),
    authenticationMode: 'delegated-app',
  };
}

function resolveWorkflowActorOpenId(input: ResolvePurchaseWorkflowSessionInput): string {
  if (OPERATOR_OPEN_ID_PATTERN.test(input.professionalOpenId || '')) return input.professionalOpenId!;
  const id = input.principal.accountId;
  if (!id) return resolveConfiguredOperatorOpenId(input.principal.role); // Original trusted shared contexts only.
  // A personal account must never borrow the configured purchaser's duties. Fixed
  // shared password entrances retain only their original, explicit delegation.
  const shared = /^local-(admin|editor|purchase_admin)-all$/.exec(id) || /^local-(purchase_applicant|building_admin)-(?:[ABCDEH]|110)$/.exec(id);
  return shared ? resolveConfiguredOperatorOpenId(shared[1] as AccessRole) : '';
}

function resolveConfiguredOperatorOpenId(role: AccessRole): string {
  const environmentNames =
    role === 'admin'
      ? [
          'PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID',
          'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID',
        ]
      : [OPERATOR_ENV[role]];

  for (const environmentName of environmentNames) {
    if (!environmentName) continue;
    const openId = readEnv(environmentName);
    if (OPERATOR_OPEN_ID_PATTERN.test(openId)) return openId;
  }
  return '';
}
