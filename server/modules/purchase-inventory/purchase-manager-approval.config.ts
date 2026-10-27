import { ServiceUnavailableException } from '@nestjs/common';
import { readEnv } from '../../common/config/external-services.config';
import { readConfiguredCardMembers } from '../../common/access/access-configuration.service';

const DEFAULT_MANAGER_NAME = '马进宇';
const MAX_OPEN_ID_LENGTH = 128;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENABLED_PATTERN = /^(1|true|yes|on)$/i;

export interface PurchaseManagerApprover {
  openId: string;
  name: string;
}

export interface PurchaseManagerCallbackAuthorization {
  legacyApproverOpenIds: string[];
  managerApproverOpenId: string;
}

export function isPurchaseManagerApprovalEnabled(): boolean {
  return ENABLED_PATTERN.test(
    readEnv('PURCHASE_MANAGER_APPROVAL_CARD_ENABLED'),
  );
}

export function readPurchaseManagerApprover(): PurchaseManagerApprover {
  return readPurchaseManagerApprovers()[0]!;
}

export function readPurchaseManagerApprovers(): PurchaseManagerApprover[] {
  const configured = readConfiguredCardMembers('purchase_manager', null);
  if (configured) {
    const managers = [...new Map(configured.map(person => [person.openId, { ...person }])).values()];
    if (!managers.length) throw new ServiceUnavailableException('采购经理配置不能为空');
    for (const manager of managers) assertOpenId(manager.openId, 'purchase_manager');
    return managers;
  }
  const dedicatedOpenId = clean(readEnv('PURCHASE_MANAGER_APPROVER_OPEN_ID'));
  const openId = dedicatedOpenId || readFallbackManagerOpenId();
  assertOpenId(openId, 'PURCHASE_MANAGER_APPROVER_OPEN_ID');

  return [{
    openId,
    name:
      clean(readEnv('PURCHASE_MANAGER_APPROVER_NAME')) || DEFAULT_MANAGER_NAME,
  }];
}

export function readPurchaseManagerCallbackAuthorization(): PurchaseManagerCallbackAuthorization {
  return {
    legacyApproverOpenIds: readOpenIdList(
      'PURCHASE_WORKFLOW_APPROVER_OPEN_IDS',
    ),
    managerApproverOpenId: readPurchaseManagerApprover().openId,
  };
}

function readFallbackManagerOpenId(): string {
  const legacyApprovers = readOpenIdList('PURCHASE_WORKFLOW_APPROVER_OPEN_IDS');
  const administrators = new Set(
    readOpenIdList('FEISHU_ACCESS_ADMIN_OPEN_IDS'),
  );
  const matches = legacyApprovers.filter((openId) =>
    administrators.has(openId),
  );
  if (matches.length !== 1) {
    throw new ServiceUnavailableException(
      '采购经理 open_id 配置缺失或存在歧义',
    );
  }
  return matches[0];
}

function readOpenIdList(environmentName: string): string[] {
  const values = clean(readEnv(environmentName))
    .split(',')
    .map(clean)
    .filter(Boolean);
  for (const value of values) {
    assertOpenId(value, environmentName);
  }
  return [...new Set(values)];
}

function assertOpenId(value: string, environmentName: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_OPEN_ID_LENGTH ||
    !OPEN_ID_PATTERN.test(value)
  ) {
    throw new ServiceUnavailableException(`${environmentName} 配置无效`);
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
