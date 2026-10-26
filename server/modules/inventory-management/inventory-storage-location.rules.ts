import { BadRequestException } from '@nestjs/common';
import type {
  WarehouseBuilding,
  WarehouseStorageLocation,
  WarehouseStorageLocationCategory,
  WarehouseStorageLocationCreateRequest,
  WarehouseStorageLocationQuery,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import {
  extractDisplayText,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

const STORAGE_LOCATION_CATEGORIES = ['库内', '库外'] as const;
const DEFAULT_STORAGE_LOCATION_LIMIT = 50;
const MAX_STORAGE_LOCATION_LIMIT = 100;
const MAX_STORAGE_LOCATION_NAME_LENGTH = 120;
const STORAGE_LOCATION_COLLATOR = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});

export function normalizeStorageLocationName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/gu, ' ');
}

export function parseStorageLocationRecord(
  record: BitableRecordItem,
): WarehouseStorageLocation | null {
  if (!record || typeof record !== 'object') return null;
  const fields = record.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return null;
  }

  const recordId = getRecordId(record).trim();
  const building = warehouseBuilding(extractDisplayText(fields['楼栋']));
  const company = normalizeStorageLocationName(
    extractDisplayText(fields['所属公司']),
  );
  const category = storageLocationCategory(
    extractDisplayText(fields['存放位置分类']),
  );
  const name = normalizeStorageLocationName(
    extractDisplayText(fields['存放位置']),
  );

  if (
    !recordId ||
    !building ||
    !company ||
    !category ||
    !name ||
    name.length > MAX_STORAGE_LOCATION_NAME_LENGTH
  ) {
    return null;
  }

  return { recordId, building, company, category, name };
}

export function filterStorageLocations(
  items: readonly WarehouseStorageLocation[],
  query: WarehouseStorageLocationQuery,
): WarehouseStorageLocation[] {
  const search = normalizeStorageLocationName(
    query.query ?? '',
  ).toLocaleLowerCase('zh-CN');
  const seen = new Set<string>();
  const filtered: Array<{ item: WarehouseStorageLocation; index: number }> = [];

  items.forEach((item, index) => {
    if (item.building !== query.building) return;
    const name = normalizeStorageLocationName(item.name);
    if (!name) return;
    if (search && !name.toLocaleLowerCase('zh-CN').includes(search)) return;

    const key = storageLocationKey(item.building, name);
    if (seen.has(key)) return;
    seen.add(key);
    filtered.push({ item: { ...item, name }, index });
  });

  const limit = storageLocationLimit(query.limit);
  return filtered
    .sort(
      (left, right) =>
        STORAGE_LOCATION_COLLATOR.compare(left.item.name, right.item.name) ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map(({ item }) => item);
}

export function validateStorageLocationCreateRequest(
  request: WarehouseStorageLocationCreateRequest,
): WarehouseStorageLocationCreateRequest {
  const building = warehouseBuilding(request?.building);
  if (!building) {
    throw new BadRequestException('请选择有效楼栋');
  }
  const category = storageLocationCategory(request?.category);
  if (!category) {
    throw new BadRequestException('请选择有效存放位置分类');
  }

  const name = normalizeStorageLocationName(
    typeof request?.name === 'string' ? request.name : '',
  );
  if (!name) {
    throw new BadRequestException('请填写存放位置');
  }
  if (name.length > MAX_STORAGE_LOCATION_NAME_LENGTH) {
    throw new BadRequestException('存放位置不能超过 120 个字符');
  }
  if (
    typeof request?.clientMutationId !== 'string' ||
    !request.clientMutationId.trim()
  ) {
    throw new BadRequestException('请求标识不能为空');
  }
  return {
    building,
    category,
    name,
    clientMutationId: request.clientMutationId.trim(),
  };
}

export function storageLocationKey(
  building: WarehouseBuilding,
  name: string,
): string {
  return JSON.stringify([
    building,
    normalizeStorageLocationName(name).toLocaleLowerCase('zh-CN'),
  ]);
}

function warehouseBuilding(value: unknown): WarehouseBuilding | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return (
    WAREHOUSE_BUILDINGS.find((building) => building === normalized) ?? null
  );
}

function storageLocationCategory(
  value: unknown,
): WarehouseStorageLocationCategory | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return (
    STORAGE_LOCATION_CATEGORIES.find((category) => category === normalized) ??
    null
  );
}

function storageLocationLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_STORAGE_LOCATION_LIMIT;
  }
  return Math.min(MAX_STORAGE_LOCATION_LIMIT, Math.max(1, Math.trunc(value)));
}
