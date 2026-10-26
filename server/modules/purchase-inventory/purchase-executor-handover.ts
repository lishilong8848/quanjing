import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type { PurchaseManagerApprovalBatchItemEntry } from './purchase-workflow.store';
import { normalizePurchaseAuthorityTarget, type PurchaseAuthorityTarget } from './purchase-authority-target';

export interface PurchaseExecutorHandoverInput {
  approvalBatchId: string;
  recordId: string;
  mutationId: string;
  expectedVersion: string;
  sourceOpenId: string;
  sourcePersonRecordId: string;
  targetOpenId: string;
  targetPersonRecordId: string;
  targetName: string;
  choice: 'comprehensive' | 'building_self';
  scope: PurchaseAuthorityTarget;
}

export interface PurchaseExecutorHandover extends Omit<PurchaseExecutorHandoverInput, 'expectedVersion'> {
  sourceVersion: string;
  appId: string;
  notificationKey: string;
  targetNotificationKey: string;
  refreshNotificationKey: string;
  supersededMessageIds: string[];
  ready: boolean;
}

export function purchaseExecutorVersion(batchId: string, item: PurchaseManagerApprovalBatchItemEntry, scope: PurchaseAuthorityTarget): string {
  return digest([batchId, item.executionRecordId, item.status, item.choice, item.purchaserOpenId,
    item.purchaserName, item.authorityTarget, item.paymentAttachmentTokens, item.executorHandover?.mutationId, scope]);
}

export function purchaseExecutorReceiptVersion(marker: PurchaseExecutorHandover): string {
  const { ready: _ready, ...identity } = marker;
  return digest(identity);
}

export function normalizePurchaseExecutorHandover(value: unknown): PurchaseExecutorHandover {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  const keys = ['approvalBatchId', 'recordId', 'mutationId', 'sourceVersion', 'sourceOpenId', 'sourcePersonRecordId',
    'targetOpenId', 'targetPersonRecordId', 'targetName', 'choice', 'scope', 'appId', 'notificationKey', 'targetNotificationKey',
    'refreshNotificationKey', 'supersededMessageIds', 'ready'];
  if (Object.keys(row).sort().join(',') !== keys.sort().join(',') ||
    !text(row.approvalBatchId, /^[A-Za-z0-9_-]{8,160}$/) || !text(row.appId, /^cli_[A-Za-z0-9_-]+$/) ||
    !text(row.mutationId, /^handover-[a-f0-9]{64}$/) || !text(row.sourceVersion, /^[a-f0-9]{64}$/) ||
    ![row.recordId, row.sourcePersonRecordId, row.targetPersonRecordId].every(id => text(id, /^rec[A-Za-z0-9_]{1,97}$/)) ||
    ![row.sourceOpenId, row.targetOpenId].every(id => text(id, /^ou_[A-Za-z0-9_-]{1,124}$/)) || row.sourceOpenId === row.targetOpenId ||
    !['comprehensive', 'building_self'].includes(String(row.choice)) || typeof row.targetName !== 'string' || !row.targetName.trim() || row.targetName.length > 200 || /[\u0000-\u001f\u007f]/u.test(row.targetName) ||
    ![row.notificationKey, row.targetNotificationKey, row.refreshNotificationKey].every(key => typeof key === 'string' && key.length > 0 && key.length <= 768 && !/[\u0000-\u001f\u007f]/u.test(key)) ||
    new Set([row.notificationKey, row.targetNotificationKey, row.refreshNotificationKey]).size !== 3 || typeof row.ready !== 'boolean' ||
    !Array.isArray(row.supersededMessageIds) || row.supersededMessageIds.length > 1000 ||
    !row.supersededMessageIds.every(id => text(id, /^om_[A-Za-z0-9_-]{1,252}$/)) || new Set(row.supersededMessageIds).size !== row.supersededMessageIds.length) throw invalid();
  const scope = normalizePurchaseAuthorityTarget(row.scope); if (!scope) throw invalid();
  return { ...structuredClone(value as PurchaseExecutorHandover), scope };
}

function text(value: unknown, pattern: RegExp): value is string { return typeof value === 'string' && pattern.test(value); }
function invalid(): ServiceUnavailableException { return new ServiceUnavailableException('采购原执行职责交接标记无效'); }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
