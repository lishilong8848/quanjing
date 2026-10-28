import { ForbiddenException } from '@nestjs/common';
import { extractDisplayText, type BitableRecordItem } from '../feishu/bitable-direct-read';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { canManageProfessionalRecord } from '../../../shared/professional-access';
import { businessBuildingLabels, isProfessionalBusinessPrincipal, normalizedBusinessBuildings } from '../../../shared/business-permissions';

export function assertProfessionalRecordScope(principal: AccessPrincipal | undefined, specialty: unknown, building?: unknown): void {
  if (isProfessionalBusinessPrincipal(principal) && !canManageProfessionalRecord(principal!, specialty, building))
    throw new ForbiddenException('当前操作超出授权的专业或楼栋范围；归属未维护时请联系管理员');
}

export function recordProfessionalSpecialty(record?: BitableRecordItem): string {
  const fields = record?.fields || {};
  return extractDisplayText(fields['专业'] ?? fields['专业类别'] ?? fields['问题归属'] ?? fields['专业标识'] ?? fields['系统名称']);
}
export function assertProfessionalBitableRecord(principal: AccessPrincipal | undefined, record: BitableRecordItem | undefined): void {
  assertProfessionalRecordScope(principal, recordProfessionalSpecialty(record), businessRecordBuilding(record));
}

export function scopeProfessionalBitableRecords(principal: AccessPrincipal | undefined, records: BitableRecordItem[]): BitableRecordItem[] {
  return filterProfessionalRecords(principal, records, recordProfessionalSpecialty);
}

export function businessRecordBuilding(record: unknown): unknown {
  if (!record || typeof record !== 'object') return undefined;
  const item = record as Record<string, unknown>;
  if (item.inventory) return businessRecordBuilding(item.inventory);
  const fields = item.fields && typeof item.fields === 'object' ? item.fields as Record<string, unknown> : {};
  for (const value of [item.building, item.buildings, fields['楼栋'], fields['园区楼栋'], fields['机楼'], fields['所属楼栋'], fields['归属楼栋'], fields['机楼/专业']]) {
    const normalized = normalizedBusinessBuildings(Array.isArray(value) && value.every(part => typeof part === 'string') ? value : extractDisplayText(value, '、'));
    if (normalized.length) return normalized;
  }
  return businessBuildingLabels(extractDisplayText(fields['对应楼栋设备'])) || undefined;
}
export function filterProfessionalRecords<T>(principal: AccessPrincipal | undefined, records: T[], specialty: (record: T) => unknown, building: (record: T) => unknown = businessRecordBuilding): T[] {
  return isProfessionalBusinessPrincipal(principal) ? records.filter(record => canManageProfessionalRecord(principal!, specialty(record), building(record), { module: principal!.permissionContext?.module || 'equipment_ledger', action: principal!.permissionContext?.action || 'read' })) : records;
}
