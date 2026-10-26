import { BadRequestException } from '@nestjs/common';
import type {
  InventoryExistingInboundMovementCreateRequest,
  InventoryMovementCreateRequest,
  InventoryMovementCreateLegacyRequest,
  InventoryMovementOptionItem,
  InventoryOutboundMovementCreateRequest,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import { getWarehouseInventoryLocationReadFieldNames } from '../../common/config/warehouse-inventory-location.config';

interface MovementSourceRecord {
  id?: string;
  record_id?: string;
  fields?: Record<string, unknown>;
}

export function buildMovementOptions(input: {
  catalog: MovementSourceRecord[];
  inventory: MovementSourceRecord[];
  type: InventoryMovementCreateRequest['type'];
  building: InventoryMovementCreateRequest['building'];
  query?: string;
  limit?: number;
}): InventoryMovementOptionItem[] {
  const inventoryByKey = new Map<
    string,
    {
      recordId: string;
      quantity: number;
      location: string;
      stockConsistencyError?: string;
    }
  >();
  for (const record of input.inventory) {
    const fields = record.fields || {};
    const sku = fieldText(fields, ['物品类别号']);
    const building = fieldBuilding(fields, ['楼栋']);
    if (!sku || !building) continue;
    const key = optionKey(sku, building);
    const current = inventoryByKey.get(key);
    const recordId = getRecordId(record);
    if (current && (!recordId || current.recordId !== recordId)) {
      inventoryByKey.set(key, {
        recordId: '',
        quantity: 0,
        location: '',
        stockConsistencyError:
          '当前楼栋存在重复库存台账，请先合并或清理后再办理库存操作',
      });
      continue;
    }
    if (current) continue;
    inventoryByKey.set(key, {
      recordId,
      quantity: numberValue(fieldValue(fields, ['剩余库存'])),
      location: firstNonEmptyFieldText(
        fields,
        getWarehouseInventoryLocationReadFieldNames(),
      ),
    });
  }

  const query = String(input.query || '')
    .trim()
    .toLowerCase();
  const requestedLimit = Number.isFinite(input.limit)
    ? Math.trunc(input.limit as number)
    : 30;
  const limit =
    requestedLimit === 0
      ? null
      : Math.min(10_000, Math.max(1, requestedLimit));
  const items = input.catalog
    .map((record): InventoryMovementOptionItem | null => {
      const fields = record.fields || {};
      const sku = fieldText(fields, ['物品类别号', '物品类别号（单选）']);
      const building = fieldBuilding(fields, ['楼栋']);
      const catalogRecordId = getRecordId(record);
      if (
        !sku ||
        !building ||
        !catalogRecordId ||
        building !== input.building
      ) {
        return null;
      }
      const inventory = inventoryByKey.get(optionKey(sku, building));
      return {
        catalogRecordId,
        specialty: fieldText(fields, ['专业']),        inventoryRecordId: inventory?.recordId || '',
        sku,
        name: fieldText(fields, ['名称']) || '未命名物品',
        specification: fieldText(fields, ['规格型号、设备序列号']),
        brand: fieldText(fields, ['品牌']),
        primaryCategory: fieldText(fields, ['一级分类']),
        secondaryCategory: fieldText(fields, ['二级分类']),
        building,
        location: inventory?.location || '',
        unit: fieldText(fields, ['计数单位']),
        availableQuantity: inventory?.quantity || 0,
        ...(inventory?.stockConsistencyError
          ? { stockConsistencyError: inventory.stockConsistencyError }
          : {}),
      };
    })
    .filter((item): item is InventoryMovementOptionItem => {
      if (!item) return false;
      if (input.type === 'borrow' && item.availableQuantity <= 0) return false;
      if (!query) return true;
      return [
        item.sku,
        item.name,
        item.specification,
        item.brand,
        item.primaryCategory,
        item.secondaryCategory,
        item.location,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    })
    .sort((left, right) =>
      left.sku.localeCompare(right.sku, 'zh-CN', { numeric: true }),
    );
  return limit === null ? items : items.slice(0, limit);
}

export function validateMovementCreateRequest(
  request: InventoryMovementCreateRequest,
  option: InventoryMovementOptionItem | undefined,
  now = new Date(),
): void {
  if (!isRecord(request)) {
    throw new BadRequestException('库存业务请求格式不正确');
  }
  if (!['inbound', 'outbound', 'borrow'].includes(request.type)) {
    throw new BadRequestException('未知库存业务类型');
  }
  if (
    request.type === 'outbound' &&
    Object.prototype.hasOwnProperty.call(request, 'destinationBuilding')
  ) {
    throw new BadRequestException('出库申请不允许包含去向楼栋');
  }
  if (!WAREHOUSE_BUILDINGS.includes(request.building)) {
    throw new BadRequestException('请选择有效楼栋');
  }
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
    throw new BadRequestException('数量必须为正整数');
  }
  if (!Number.isSafeInteger(request.quantity)) {
    throw new BadRequestException('数量必须为安全的正整数');
  }
  const occurredAt = parseIsoDateTime(request.occurredAt);
  if (occurredAt === null) {
    throw new BadRequestException('请选择有效 ISO 8601 业务时间');
  }

  const strictInbound =
    request.type === 'inbound' &&
    (request.mode === 'existing' || request.mode === 'new');
  if (request.type === 'outbound' && !clean(request.clientMutationId)) {
    throw new BadRequestException('请求标识不能为空');
  }
  if (strictInbound && !clean(request.clientMutationId)) {
    throw new BadRequestException('请求标识不能为空');
  }
  if (request.type === 'inbound' && request.mode === 'new') {
    if (!isRecord(request.newItem)) {
      throw new BadRequestException('新增物品信息格式不正确');
    }
    const item = request.newItem;
    if (!clean(item.primaryCategory) || !clean(item.secondaryCategory)) {
      throw new BadRequestException('请选择完整物品分类');
    }
    if (!clean(item.name)) {
      throw new BadRequestException('请填写物品名称');
    }
    if (!clean(item.specification)) {
      throw new BadRequestException('请填写规格型号');
    }
    if (!clean(item.location)) {
      throw new BadRequestException('请配置存放位置');
    }
    return;
  }

  const catalogRecordId = clean(request.catalogRecordId);
  const sku = clean(request.sku);
  if (!catalogRecordId || !sku || !option) {
    throw new BadRequestException('请选择有效物品');
  }
  if (
    option.catalogRecordId !== catalogRecordId ||
    option.sku.trim().toUpperCase() !== sku.toUpperCase() ||
    option.building !== request.building
  ) {
    throw new BadRequestException('所选物品不属于当前楼栋，请重新选择');
  }
  if (option.stockConsistencyError) {
    throw new BadRequestException(option.stockConsistencyError);
  }
  if (request.type === 'inbound' && request.mode === 'existing') {
    if (!option.inventoryRecordId) {
      throw new BadRequestException('当前楼栋未配置库存台账，请先配置库位');
    }
    if (!option.location.trim()) {
      throw new BadRequestException(
        '当前楼栋库存台账缺少存放位置，请先配置库位',
      );
    }
  }

  if (request.type === 'outbound' && !option.location.trim()) {
    throw new BadRequestException('当前楼栋库存台账缺少存放位置，请先配置库位');
  }

  if (request.type === 'outbound' || request.type === 'borrow') {
    if (!clean(request.applicantOpenId)) {
      throw new BadRequestException('请选择物品申请人');
    }
    if (!clean(request.reason)) {
      throw new BadRequestException(
        request.type === 'outbound'
          ? '请填写出库原因或使用地点'
          : '请填写借调原因',
      );
    }
    if (request.quantity > option.availableQuantity) {
      const unit = option.unit ? ` ${option.unit}` : '';
      throw new BadRequestException(
        `当前可用库存为 ${formatQuantity(option.availableQuantity)}${unit}，不能办理 ${formatQuantity(request.quantity)}${unit}`,
      );
    }
  }

  if (
    request.type === 'borrow' &&
    request.destinationBuilding &&
    !WAREHOUSE_BUILDINGS.includes(request.destinationBuilding)
  ) {
    throw new BadRequestException('请选择有效去向楼栋');
  }

  if (request.type === 'borrow') {
    if (!clean(request.operatorOpenId)) {
      throw new BadRequestException('请选择经办人');
    }
    const expectedReturnAt = parseIsoDateTime(request.expectedReturnAt);
    if (expectedReturnAt === null) {
      throw new BadRequestException('请选择有效 ISO 8601 预计归还时间');
    }
    if (expectedReturnAt <= now.getTime()) {
      throw new BadRequestException('预计归还时间必须晚于当前时间');
    }
    if (expectedReturnAt <= occurredAt) {
      throw new BadRequestException('预计归还时间必须晚于借调时间');
    }
  }
}

type InventoryNonOutboundMovementFieldsRequest =
  | InventoryExistingInboundMovementCreateRequest
  | InventoryMovementCreateLegacyRequest;

export function buildMovementCreateFields(
  request: InventoryOutboundMovementCreateRequest,
  option: InventoryMovementOptionItem,
  outboundFingerprint: string,
): Record<string, unknown>;
export function buildMovementCreateFields(
  request: InventoryNonOutboundMovementFieldsRequest,
  option: InventoryMovementOptionItem,
): Record<string, unknown>;
export function buildMovementCreateFields(
  request: InventoryMovementCreateRequest,
  option: InventoryMovementOptionItem,
  outboundFingerprint?: string,
): Record<string, unknown> {
  const occurredAt = Date.parse(request.occurredAt);
  if (request.type === 'inbound') {
    return {
      物品类别号: option.sku,
      入库数量: request.quantity,
      楼栋: request.building,
      入库日期: occurredAt,
    };
  }

  if (request.type === 'outbound') {
    const fingerprint = clean(outboundFingerprint);
    if (!fingerprint) {
      throw new BadRequestException('出库请求指纹不能为空');
    }
    return {
      物品类别号: [option.catalogRecordId],
      物品申请人: [{ id: request.applicantOpenId }],
      楼栋: request.building,
      '出库原因/出库后使用地点': clean(request.reason),
      程序出库状态: '待审批',
      出库工作流状态: '待路由',
      程序出库申请数量: request.quantity,
      程序出库申请时间: new Date(request.occurredAt).toISOString(),
      出库创建标识: request.clientMutationId,
      出库请求指纹: fingerprint,
    };
  }

  return {
    物品类别号: [option.catalogRecordId],
    物品申请人: [{ id: request.applicantOpenId }],
    经办人: [{ id: request.operatorOpenId }],
    借调数量: request.quantity,
    借出楼栋: request.building,
    借调时间: occurredAt,
    预期归还时间: Date.parse(request.expectedReturnAt || ''),
    借调原因: clean(request.reason),
    物品状态: '借调中',
  };
}

function formatQuantity(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(
    value,
  );
}

function fieldText(fields: Record<string, unknown>, names: string[]): string {
  return displayValues(fieldValue(fields, names)).join('、').trim();
}

function firstNonEmptyFieldText(
  fields: Record<string, unknown>,
  names: string[],
): string {
  for (const name of names) {
    const value = fieldText(fields, [name]);
    if (value) return value;
  }
  return '';
}

function fieldBuilding(
  fields: Record<string, unknown>,
  names: string[],
): InventoryMovementCreateRequest['building'] | null {
  const value = fieldText(fields, names);
  return WAREHOUSE_BUILDINGS.find((building) => building === value) || null;
}

function optionKey(sku: string, building: string): string {
  return `${building}|${sku.trim().toUpperCase()}`;
}

function getRecordId(record: MovementSourceRecord): string {
  return String(record.record_id || record.id || '').trim();
}

function fieldValue(fields: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  }
  return undefined;
}

function displayValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(displayValues);
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text ? [text] : [];
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['text', 'name', 'value']) {
      const values = displayValues(object[key]);
      if (values.length) return values;
    }
  }
  return [];
}

function numberValue(value: unknown): number {
  const parsed = Number(displayValues(value).join(''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIsoDateTime(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_DATE_TIME_PATTERN.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
