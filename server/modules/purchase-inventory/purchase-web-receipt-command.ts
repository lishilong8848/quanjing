import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PurchaseWorkflowReceiptInput, PurchaseWorkflowUser } from '../../../shared/purchase-workflow.interface';
import { normalizePurchaseAuthorityTarget, type PurchaseAuthorityTarget } from './purchase-authority-target';
import type { PersonnelRecoveryAudit } from '../../../shared/personnel-task-recovery.interface';
import { validRecoveryAudits } from '../../common/access/personnel-task-recovery.validation';

export type WebReceiptInput = Omit<PurchaseWorkflowReceiptInput, 'receiptPhotoTokens' | 'invoiceTokens' | 'clientMutationId'>;
export interface WebReceiptFile {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  group: 'receiptPhotos' | 'invoices';
  token: string;
  uploadStartedAt: string;
}
export interface PurchaseWebReceiptCommand {
  recoveries?: PersonnelRecoveryAudit[];
  recordId: string;
  taskId: string;
  ownerId: string;
  appId: string;
  mutationId: string;
  fingerprint: string;
  actor: Pick<PurchaseWorkflowUser, 'openId' | 'name' | 'positions' | 'buildings' | 'accessRole'>;
  scope: PurchaseAuthorityTarget;
  input: WebReceiptInput;
  files: WebReceiptFile[];
  notificationWarnings: string[];
  filesRemoved: boolean;
}

export function webReceiptHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function webReceiptRecoveryVersion(task:{key:string;status:string;attempts:number;updatedAt:string;webReceipt?:PurchaseWebReceiptCommand}):string {
  return webReceiptHash([task.key,task.status,task.attempts,task.updatedAt,task.webReceipt]);
}

export function normalizeWebReceiptCommand(value: unknown): PurchaseWebReceiptCommand {
  const fail = (): never => { throw new ServiceUnavailableException('网页签收任务内容无效'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as PurchaseWebReceiptCommand;
  if (Object.keys(row).filter(key=>key!=='recoveries').sort().join(',') !== 'actor,appId,files,filesRemoved,fingerprint,input,mutationId,notificationWarnings,ownerId,recordId,scope,taskId' || !validRecoveryAudits(row.recoveries) ||
    !/^rec[A-Za-z0-9_-]+$/.test(row.recordId) ||
    !/^purchase-receipt-[a-f0-9]{64}$/.test(row.taskId) || !/^cli_[A-Za-z0-9_-]+$/.test(row.appId) ||
    !/^[A-Za-z0-9:_-]{1,180}$/.test(row.ownerId) || !/^[A-Za-z0-9_-]{1,80}$/.test(row.mutationId) ||
    !/^[a-f0-9]{64}$/.test(row.fingerprint) || typeof row.filesRemoved !== 'boolean') return fail();
  const scope = normalizePurchaseAuthorityTarget(row.scope);
  if (!scope || !row.actor || !/^ou_[A-Za-z0-9_-]+$/.test(row.actor.openId) || typeof row.actor.name !== 'string' || row.actor.name.length > 200 ||
    Object.keys(row.actor).some(key => !['openId', 'name', 'positions', 'buildings', 'accessRole'].includes(key)) ||
    !Array.isArray(row.actor.positions) || !Array.isArray(row.actor.buildings) ||
    [...row.actor.positions, ...row.actor.buildings].some(text => typeof text !== 'string' || text.length > 100) ||
    row.actor.accessRole !== undefined && typeof row.actor.accessRole !== 'string') return fail();
  const input = row.input;
  if (!input || Object.keys(input).sort().join(',') !== 'note,receiptTime,signer,signerOpenId' ||
    typeof input.signer !== 'string' || !input.signer.trim() || input.signer.length > 200 ||
    !/^ou_[A-Za-z0-9_-]+$/.test(input.signerOpenId) || !Number.isFinite(input.receiptTime) || input.receiptTime <= 0 ||
    typeof input.note !== 'string' || input.note.length > 10_000) return fail();
  if (!Array.isArray(row.files) || !row.files.length || row.files.length > 20 || !row.files.some(file => file.group === 'receiptPhotos') ||
    row.files.some(file => !file || Object.keys(file).sort().join(',') !== 'group,mime,name,sha256,size,token,uploadStartedAt' ||
      !['receiptPhotos', 'invoices'].includes(file.group) || typeof file.name !== 'string' || !file.name || file.name.length > 200 ||
      typeof file.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mime) ||
      !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 20 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.token !== 'string' || file.token.length > 512 || typeof file.uploadStartedAt !== 'string' || file.uploadStartedAt !== '' && !Number.isFinite(Date.parse(file.uploadStartedAt))) ||
    row.files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024 ||
    !Array.isArray(row.notificationWarnings) || row.notificationWarnings.length > 30 || row.notificationWarnings.some(text => typeof text !== 'string' || text.length > 1000)) return fail();
  if (webReceiptFingerprint(row) !== row.fingerprint || row.taskId !== `purchase-receipt-${webReceiptHash([row.appId, row.ownerId, row.mutationId])}`) return fail();
  return structuredClone({ ...row, scope });
}

export function webReceiptFingerprint(row: Pick<PurchaseWebReceiptCommand, 'recordId' | 'ownerId' | 'appId' | 'mutationId' | 'actor' | 'scope' | 'input' | 'files'>): string {
  return webReceiptHash([row.recordId, row.ownerId, row.appId, row.mutationId, row.actor, row.scope, row.input,
    row.files.map(({ token: _token, uploadStartedAt: _startedAt, ...file }) => file)]);
}

export function webReceiptInput(row: PurchaseWebReceiptCommand): PurchaseWorkflowReceiptInput {
  if (row.files.some(file => !file.token)) throw new BadRequestException('签收附件尚未完成上传');
  return { ...row.input, receiptPhotoTokens: row.files.filter(file => file.group === 'receiptPhotos').map(file => file.token), invoiceTokens: row.files.filter(file => file.group === 'invoices').map(file => file.token) };
}
