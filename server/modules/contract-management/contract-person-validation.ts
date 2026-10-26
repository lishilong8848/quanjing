import { BadRequestException } from '@nestjs/common';
import type {
  ContractCreateFieldDefinition,
  ContractCreateValue,
} from '../../../shared/contract-management.interface';

export function assertKnownPersonFieldValues(
  values: Record<string, ContractCreateValue>,
  definition: ContractCreateFieldDefinition[],
  allowedOpenIds: Iterable<string>,
): void {
  const allowed = new Set(allowedOpenIds);
  for (const field of definition) {
    if (
      field.control !== 'user' ||
      !Object.prototype.hasOwnProperty.call(values, field.fieldId)
    ) {
      continue;
    }
    const value = values[field.fieldId];
    if (isEmpty(value)) continue;
    const openIds = normalizeOpenIds(value, field.name);
    if (!field.multiple && openIds.length > 1) {
      throw new BadRequestException(`${field.name}只能选择一人`);
    }
    for (const openId of openIds) {
      assertKnownPersonOpenId(openId, allowed, field.name);
    }
  }
}

export function assertKnownPersonOpenId(
  value: unknown,
  allowedOpenIds: Iterable<string>,
  fieldName = '跟进人',
): string {
  const openId = typeof value === 'string' ? value.trim() : '';
  if (!/^ou_[A-Za-z0-9]+$/.test(openId)) {
    throw new BadRequestException(`${fieldName}人员标识无效`);
  }
  if (!new Set(allowedOpenIds).has(openId)) {
    throw new BadRequestException(`${fieldName}不在当前可选人员中`);
  }
  return openId;
}

export function collectKnownPersonOpenIds(values: unknown[]): Set<string> {
  const result = new Set<string>();
  for (const value of values) collectFromValue(value, result);
  return result;
}

function normalizeOpenIds(
  value: ContractCreateValue,
  fieldName: string,
): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (
    !values.length ||
    values.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new BadRequestException(`${fieldName}人员标识无效`);
  }
  return [...new Set(values.map((item) => String(item).trim()))];
}

function collectFromValue(value: unknown, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, result);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  for (const candidate of [item.id, item.open_id]) {
    if (
      typeof candidate === 'string' &&
      /^ou_[A-Za-z0-9]+$/.test(candidate.trim())
    ) {
      result.add(candidate.trim());
    }
  }
  for (const nested of Object.values(item)) collectFromValue(nested, result);
}

function isEmpty(value: ContractCreateValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  );
}
