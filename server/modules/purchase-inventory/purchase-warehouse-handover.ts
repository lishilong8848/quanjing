import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface WarehouseInboundHandoverInput {
  recordId: string;
  expectedGeneration: number;
  mutationId: string;
  dutyRecordId: string;
  sourcePersonRecordId: string;
  sourceOpenId: string;
  target: { personRecordId: string; openId: string; name: string };
}
export interface WarehouseInboundHandover extends WarehouseInboundHandoverInput {
  targetGeneration: number;
  fingerprint: string;
  oldMessageIds: string[];
  patchedMessageIds: string[];
  notificationKey: string;
  acceptedAt: string;
  updatedAt: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  claimToken: string;
  leaseUntil: string;
  nextAttemptAt: string;
  lastError: string;
  completedAt: string;
  deliveredMessageId: string;
  deliveryConfirmedAt: string;
  deliveryDisposition: '' | 'delivered' | 'business_completed' | 'business_terminated';
}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const rec = (value: unknown): value is string => typeof value === 'string' && /^rec[A-Za-z0-9_]{1,97}$/.test(value);
const oid = (value: unknown): value is string => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{1,124}$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const message = (value: unknown): value is string => typeof value === 'string' && /^om_[A-Za-z0-9_-]{1,252}$/.test(value);
export function normalizeWarehouseInboundHandoverInput(value: WarehouseInboundHandoverInput): WarehouseInboundHandoverInput {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'dutyRecordId,expectedGeneration,mutationId,recordId,sourceOpenId,sourcePersonRecordId,target' ||
    !rec(value.recordId) || !rec(value.dutyRecordId) || !rec(value.sourcePersonRecordId) || !oid(value.sourceOpenId) ||
    !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 1 || value.expectedGeneration >= Number.MAX_SAFE_INTEGER ||
    typeof value.mutationId !== 'string' || !/^handover-[a-f0-9]{64}$/.test(value.mutationId) || !plain(value.target) ||
    Object.keys(value.target).sort().join(',') !== 'name,openId,personRecordId' || !rec(value.target.personRecordId) || !oid(value.target.openId) ||
    value.target.openId === value.sourceOpenId || value.target.personRecordId === value.sourcePersonRecordId || typeof value.target.name !== 'string' ||
    !value.target.name.trim() || value.target.name.trim().length > 128 || /[\u0000-\u001f\u007f]/u.test(value.target.name)) throw new BadRequestException('待入库提醒交接身份或代际无效');
  return { recordId: value.recordId, expectedGeneration: value.expectedGeneration, mutationId: value.mutationId, dutyRecordId: value.dutyRecordId,
    sourcePersonRecordId: value.sourcePersonRecordId, sourceOpenId: value.sourceOpenId,
    target: { personRecordId: value.target.personRecordId, openId: value.target.openId, name: value.target.name.trim() } };
}
export const warehouseInboundHandoverFingerprint = (input: WarehouseInboundHandoverInput): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function resolveWarehouseInboundRecipient(jobs: readonly WarehouseInboundHandover[], recordId: string, openId: string): string {
  let result = openId;
  for (const job of jobs) if (job.recordId === recordId && job.sourceOpenId === result) result = job.target.openId;
  return result;
}
export function normalizeWarehouseInboundHandovers(value: unknown): WarehouseInboundHandover[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2000) throw new ServiceUnavailableException('待入库提醒交接台账无效或容量已满');
  const result: WarehouseInboundHandover[] = [], mutations = new Set<string>();
  for (const raw of value) {
    if (!plain(raw) || Object.keys(raw).sort().join(',') !== 'acceptedAt,attempts,claimToken,completedAt,deliveredMessageId,deliveryConfirmedAt,deliveryDisposition,dutyRecordId,expectedGeneration,fingerprint,lastError,leaseUntil,mutationId,nextAttemptAt,notificationKey,oldMessageIds,patchedMessageIds,recordId,sourceOpenId,sourcePersonRecordId,status,target,targetGeneration,updatedAt') throw new ServiceUnavailableException('待入库提醒交接记录结构无效');
    const input = normalizeWarehouseInboundHandoverInput({ recordId: raw.recordId, expectedGeneration: raw.expectedGeneration, mutationId: raw.mutationId,
      dutyRecordId: raw.dutyRecordId, sourcePersonRecordId: raw.sourcePersonRecordId, sourceOpenId: raw.sourceOpenId, target: raw.target } as WarehouseInboundHandoverInput);
    const old = raw.oldMessageIds, patched = raw.patchedMessageIds;
    if (mutations.has(input.mutationId) || input.expectedGeneration !== result.filter(job => job.recordId === input.recordId).length + 1 ||
      resolveWarehouseInboundRecipient(result, input.recordId, input.sourceOpenId) !== input.sourceOpenId || raw.targetGeneration !== input.expectedGeneration + 1 ||
      raw.fingerprint !== warehouseInboundHandoverFingerprint(input) || !Array.isArray(old) || old.length > 1000 || !old.every(message) || new Set(old).size !== old.length ||
      !Array.isArray(patched) || !patched.every(id => message(id) && old.includes(id)) || new Set(patched).size !== patched.length ||
      typeof raw.notificationKey !== 'string' || raw.notificationKey !== `warehouse-inbound:${input.recordId}:${input.recordId}:${input.target.openId}` ||
      !date(raw.acceptedAt) || !date(raw.updatedAt) || !date(raw.nextAttemptAt) || !['pending','processing','completed','failed'].includes(String(raw.status)) ||
      !Number.isSafeInteger(raw.attempts) || Number(raw.attempts) < 0 || typeof raw.lastError !== 'string' || raw.lastError.length > 500 ||
      (raw.status === 'processing' ? typeof raw.claimToken !== 'string' || !/^[a-f0-9-]{36}$/i.test(raw.claimToken) || !date(raw.leaseUntil) : raw.claimToken !== '' || raw.leaseUntil !== '') ||
      (raw.status === 'completed' ? !date(raw.completedAt) || patched.length !== old.length : raw.completedAt !== '') ||
      !['', 'delivered', 'business_completed', 'business_terminated'].includes(String(raw.deliveryDisposition)) ||
      (raw.deliveryDisposition === '' ? raw.deliveredMessageId !== '' || raw.deliveryConfirmedAt !== '' :
        !date(raw.deliveryConfirmedAt) || (raw.deliveryDisposition === 'delivered' ? !message(raw.deliveredMessageId) : raw.deliveredMessageId !== ''))) throw new ServiceUnavailableException('待入库提醒交接回执或进度无效');
    mutations.add(input.mutationId); result.push({ ...raw, ...input } as unknown as WarehouseInboundHandover);
  }
  return result;
}
