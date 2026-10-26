import { BadRequestException } from '@nestjs/common';
import type { PersonnelRecoveryAudit, PersonnelRecoveryRequest } from '../../../shared/personnel-task-recovery.interface';

export function assertRecoveryRequest(input: PersonnelRecoveryRequest): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['clientMutationId','expectedVersion','module','taskId','selections'].includes(key)) ||
    !['purchase','contracts'].includes(input.module) || typeof input.taskId !== 'string' || !input.taskId || input.taskId.length > 180 ||
    !/^[a-f0-9]{64}$/.test(input.expectedVersion) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.clientMutationId) ||
    (input.selections !== undefined && !validRecoveryRecordIds(input.selections))) throw new BadRequestException('恢复请求内容无效');
}

export function validRecoveryAudits(value: unknown): value is PersonnelRecoveryAudit[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 20 || new Set(value.map(row => row?.clientMutationId)).size !== value.length) return false;
  return value.every(row => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).sort().join(',') === `actorId,actorName,authorizationVersion,clientMutationId,${row.evidence === undefined ? '' : 'evidence,'}previousVersion,requestedAt` &&
    /^[a-f0-9-]{36}$/i.test(row.clientMutationId) && /^[a-f0-9]{64}$/.test(row.previousVersion) && typeof row.actorId === 'string' && /^[A-Za-z0-9:_-]{1,180}$/.test(row.actorId) &&
    typeof row.actorName === 'string' && row.actorName.length > 0 && row.actorName.length <= 200 && Number.isSafeInteger(row.authorizationVersion) && row.authorizationVersion >= 1 &&
    typeof row.requestedAt === 'string' && Number.isFinite(Date.parse(row.requestedAt)) &&
    (row.evidence === undefined || (row.evidence && typeof row.evidence === 'object' && Object.keys(row.evidence).sort().join(',') === 'hash,recordIds' && /^[a-f0-9]{64}$/.test(row.evidence.hash) && validRecoveryRecordIds(row.evidence.recordIds))));
}

function validRecoveryRecordIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 200 && value.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) && new Set(value).size === value.length;
}
