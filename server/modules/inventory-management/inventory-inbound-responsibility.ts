import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface InboundResponsiblePerson {
  personRecordId: string;
  openId: string;
  name: string;
  accountIds: string[];
}
export interface InboundResponsibilityHandoverInput {
  recordId: string;
  expectedGeneration: number;
  recordFingerprint: string;
  mutationId: string;
  dutyRecordId: string;
  source: InboundResponsiblePerson;
  target: InboundResponsiblePerson;
}
export interface InboundResponsibilityHandover extends InboundResponsibilityHandoverInput {
  fingerprint: string;
  acceptedAt: string;
}
export interface InboundResponsibility {
  recordId: string;
  generation: number;
  recordFingerprint: string;
  target: InboundResponsiblePerson;
  handovers: InboundResponsibilityHandover[];
}
const recordId = (value: unknown): value is string => typeof value === 'string' && /^rec[A-Za-z0-9_]{1,97}$/.test(value);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: object, expected: string) => Object.keys(value).sort().join(',') === expected;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function person(value: unknown): InboundResponsiblePerson {
  if (!plain(value) || !keys(value, 'accountIds,name,openId,personRecordId') || !recordId(value.personRecordId) ||
    typeof value.openId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/.test(value.openId) ||
    typeof value.name !== 'string' || !value.name.trim() || value.name !== value.name.trim() || value.name.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.name) ||
    !Array.isArray(value.accountIds) || !value.accountIds.length || value.accountIds.length > 10 || new Set(value.accountIds).size !== value.accountIds.length ||
    value.accountIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id))) throw new BadRequestException('入库示例人员019身份无效');
  return { personRecordId: value.personRecordId, openId: value.openId, name: value.name, accountIds: [...value.accountIds].sort() };
}
export function normalizeInboundResponsibilityHandover(value: InboundResponsibilityHandoverInput): InboundResponsibilityHandoverInput {
  if (!plain(value) || !keys(value, 'dutyRecordId,expectedGeneration,mutationId,recordFingerprint,recordId,source,target') ||
    !recordId(value.recordId) || !recordId(value.dutyRecordId) || !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 1 || value.expectedGeneration >= Number.MAX_SAFE_INTEGER ||
    typeof value.recordFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.recordFingerprint) || typeof value.mutationId !== 'string' || !/^handover-[a-f0-9]{64}$/.test(value.mutationId)) throw new BadRequestException('入库责任交接参数无效');
  const source = person(value.source), target = person(value.target);
  if (source.personRecordId === target.personRecordId || source.openId === target.openId || source.accountIds.some(id => target.accountIds.includes(id))) throw new BadRequestException('入库交接人员必须不同');
  return { recordId: value.recordId, expectedGeneration: value.expectedGeneration, recordFingerprint: value.recordFingerprint,
    mutationId: value.mutationId, dutyRecordId: value.dutyRecordId, source, target };
}
export const inboundResponsibilityFingerprint = (value: InboundResponsibilityHandoverInput): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function inboundResponsibilities(extensions: Record<string, unknown> | undefined): Record<string, InboundResponsibility> {
  if (extensions === undefined) return {};
  if (!plain(extensions)) throw new ServiceUnavailableException('入库任务扩展台账无效');
  const stored = extensions.purchaseInboundResponsibilities;
  if (stored === undefined) return {};
  if (!plain(stored) || Object.keys(stored).length > 5000) throw new ServiceUnavailableException('入库责任台账无效或容量已满');
  for (const [id, value] of Object.entries(stored)) {
    if (!recordId(id) || !plain(value) || !keys(value, 'generation,handovers,recordFingerprint,recordId,target') || value.recordId !== id ||
      !Array.isArray(value.handovers) || !value.handovers.length || value.handovers.length > 100) throw new ServiceUnavailableException('入库责任台账结构无效');
    let previous: InboundResponsiblePerson | undefined;
    const mutations = new Set<string>();
    for (let index = 0; index < value.handovers.length; index++) {
      const row: unknown = value.handovers[index];
      if (!plain(row) || !keys(row, 'acceptedAt,dutyRecordId,expectedGeneration,fingerprint,mutationId,recordFingerprint,recordId,source,target')) throw new ServiceUnavailableException('入库责任历史无效');
      const { fingerprint, acceptedAt, ...candidate } = row;
      const input = normalizeInboundResponsibilityHandover(candidate as unknown as InboundResponsibilityHandoverInput);
      if (input.recordId !== id || input.expectedGeneration !== index + 1 || fingerprint !== inboundResponsibilityFingerprint(input) ||
        typeof acceptedAt !== 'string' || !Number.isFinite(Date.parse(acceptedAt)) || mutations.has(input.mutationId) ||
        previous && JSON.stringify(input.source) !== JSON.stringify(previous)) throw new ServiceUnavailableException('入库责任历史身份或代际不一致');
      mutations.add(input.mutationId); previous = input.target;
    }
    if (value.generation !== value.handovers.length + 1 || JSON.stringify(person(value.target)) !== JSON.stringify(previous) ||
      value.recordFingerprint !== value.handovers.at(-1).recordFingerprint) throw new ServiceUnavailableException('入库当前责任与历史不一致');
  }
  return copy(stored as unknown as Record<string, InboundResponsibility>);
}
export function assertInboundResponsibilitySource(plan: InboundResponsibility | undefined, input: InboundResponsibilityHandoverInput): void {
  if ((plan?.generation || 1) !== input.expectedGeneration || plan && JSON.stringify(plan.target) !== JSON.stringify(input.source)) {
    throw new ConflictException('入库示例人员019或代际已变化，请重新预览');
  }
}
