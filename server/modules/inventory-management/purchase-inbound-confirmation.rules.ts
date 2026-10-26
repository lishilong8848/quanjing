import { BadRequestException } from '@nestjs/common';
import type {
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundConfirmRequest,
  PurchaseInboundPreparedCategory,
  PurchasePendingInboundItem,
  WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';

export interface PurchaseInboundSourceRecord {
  id?: string;
  record_id?: string;
  fields?: Record<string, unknown>;
}

export function buildPendingPurchaseInbounds(input: {
  submissions: PurchaseInboundSourceRecord[];
  executions: PurchaseInboundSourceRecord[];
  catalog?: PurchaseInboundSourceRecord[];
}): PurchasePendingInboundItem[] {
  const submissions = new Map<string, PurchaseInboundSourceRecord[]>();
  for (const submission of input.submissions) {
    const code = fieldText(submission.fields, ['采购编码']);
    if (!code) continue;
    const matches = submissions.get(code);
    if (matches) matches.push(submission);
    else submissions.set(code, [submission]);
  }
  const preparedCatalogRecords = new Map<
    string,
    PurchaseInboundSourceRecord[]
  >();
  for (const catalogRecord of input.catalog || []) {
    const sourceKey = fieldText(catalogRecord.fields, ['入库创建标识']);
    if (!sourceKey.startsWith('采购:')) continue;
    const executionRecordId = sourceKey.slice('采购:'.length).trim();
    if (!executionRecordId) continue;
    const records = preparedCatalogRecords.get(executionRecordId);
    if (records) records.push(catalogRecord);
    else preparedCatalogRecords.set(executionRecordId, [catalogRecord]);
  }

  return input.executions
    .map((execution): PurchasePendingInboundItem | null => {
      const fields = execution.fields || {};
      const executionRecordId = getRecordId(execution);
      const requestCode = fieldText(fields, ['采购编码']);
      const quantity = fieldNumber(fields, ['实际采购数量', '采购申请数量']);
      const signed = fieldChecked(
        fieldValue(fields, [
          '到货签收确认（签收内容填写完成后点击）',
          '到货签收确认',
        ]),
      );
      const workflowStatuses = [
        fieldText(fields, ['采购流程']),
        fieldText(fields, ['程序采购状态']),
      ].filter(Boolean);
      const inboundCompleted =
        fieldChecked(fields['是否已入库']) ||
        workflowStatuses.some((status) =>
          ['采购完成（已入库）', '物品签收已入库'].includes(status),
        );
      const receiptCompleted =
        inboundCompleted ||
        workflowStatuses.some((status) =>
          ['到货已签收（待入库）', '物品签收（待入库）'].includes(status),
        ) ||
        (workflowStatuses.length === 0 && signed);
      const rejected = displayValues(fields['1️⃣物品采购方式']).includes('驳回');
      if (
        !executionRecordId ||
        !requestCode ||
        !receiptCompleted ||
        rejected ||
        inboundCompleted ||
        quantity <= 0
      ) {
        return null;
      }

      const submissionMatches = submissions.get(requestCode) || [];
      const submission =
        submissionMatches.length === 1 ? submissionMatches[0] : undefined;
      const submissionFields = submission?.fields || {};
      const building = fieldBuilding(fields, [
        '申请楼栋',
        '申请楼栋（多楼请选E楼，备注里填写详情）',
        '申请楼栋（多楼请选H楼，备注里填写详情）',
      ]);
      if (!building) return null;

      const preparedRecords =
        preparedCatalogRecords.get(executionRecordId) || [];
      if (preparedRecords.length > 1) {
        throw new BadRequestException(
          '同一采购执行存在重复的预备物品类别，请联系管理员处理',
        );
      }
      const preparedCategory = preparedRecords[0]
        ? parsePreparedCategory(preparedRecords[0], executionRecordId)
        : undefined;

      const sku = fieldText(fields, [
        '物品类别码（库房）',
        '物品类别码',
        '物品类别号',
      ]);
      return {
        executionRecordId,
        specialty: fieldText(fields, ['专业']),
        submissionRecordId: getRecordId(submission),
        requestCode,
        mode: null,
        sku,
        itemName:
          fieldText(fields, ['物品名称', '名称']) ||
          fieldText(submissionFields, ['新增物品名称']) ||
          fieldText(submissionFields, ['非新增物品名称']) ||
          '',
        specification:
          fieldText(fields, ['物品规格型号、设备序列号']) ||
          fieldText(submissionFields, ['规格型号', '物品规格型号、设备序列号']),
        brand:
          fieldText(fields, ['物品品牌']) ||
          fieldText(submissionFields, ['品牌', '物品品牌']),
        primaryCategory:
          fieldText(fields, ['一级分类']) ||
          fieldText(submissionFields, ['一级分类']),
        secondaryCategory:
          fieldText(fields, ['二级分类']) ||
          fieldText(submissionFields, ['二级分类']),
        building,
        quantity,
        unit:
          fieldText(fields, ['计数单位', '单位']) ||
          fieldText(submissionFields, ['单位', '计数单位']),
        signedAt: fieldDate(fields, ['签收时间']),
        action: 'needs_selection',
        catalogRecordId: '',
        actionReason: '请在确认入库时选择新增或已有',
        ...(preparedCategory ? { preparedCategory } : {}),
      };
    })
    .filter((item): item is PurchasePendingInboundItem => Boolean(item));
}

export function validatePurchaseInboundConfirmation(
  request: PurchaseInboundConfirmRequest,
  pending: PurchasePendingInboundItem | undefined,
  catalog: PurchaseInboundSourceRecord[],
): void {
  if (
    !pending ||
    pending.executionRecordId !== clean(request.executionRecordId)
  ) {
    throw new BadRequestException('采购记录不存在或已完成入库');
  }
  const strictRequest = hasStrictPurchaseSignal(request);
  if (!strictRequest) {
    throw new BadRequestException('请刷新页面后提供目标楼栋和请求标识');
  }
  if (!isWarehouseBuilding(request.building)) {
    throw new BadRequestException('请选择目标楼栋');
  }
  if (!clean(request.clientMutationId)) {
    throw new BadRequestException('请求标识不能为空');
  }
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
    throw new BadRequestException('确认入库数量必须为正整数');
  }
  if (request.quantity > pending.quantity) {
    throw new BadRequestException(
      `确认入库数量不能超过实际签收数量（${pending.quantity}）`,
    );
  }
  if (!Number.isFinite(Date.parse(request.occurredAt))) {
    throw new BadRequestException('请选择有效入库时间');
  }

  if (request.mode === 'existing') {
    const normalizedSku = normalizeSku(request.sku);
    if (!normalizedSku) throw new BadRequestException('请选择库存物品类别');
    const selected = catalog.find(
      (record) => getRecordId(record) === clean(request.catalogRecordId),
    );
    const targetBuilding = strictRequest ? request.building : pending.building;
    if (
      !selected ||
      normalizeSku(
        fieldText(selected.fields, ['物品类别号', '物品类别号（单选）']),
      ) !== normalizedSku ||
      fieldBuilding(selected.fields, ['楼栋']) !== targetBuilding
    ) {
      throw new BadRequestException('所选库存物品类别与目标楼栋不匹配');
    }
    return;
  }

  if (Object.prototype.hasOwnProperty.call(request, 'sku')) {
    throw new BadRequestException('新增物品类别号由服务端生成，请勿手工填写');
  }
  validatePurchaseNewItem(request.newItem);
  if (
    !clean(request.preparedCatalogRecordId) ||
    !normalizeSku(request.generatedSku)
  ) {
    throw new BadRequestException('请先生成新的物品类别号');
  }
}

export function validatePurchaseInboundCategoryPreparation(
  request: PurchaseInboundCategoryPrepareRequest,
  pending: PurchasePendingInboundItem | undefined,
): void {
  if (
    !pending ||
    pending.executionRecordId !== clean(request.executionRecordId)
  ) {
    throw new BadRequestException('采购记录不存在或已完成入库');
  }
  if (!isWarehouseBuilding(request.building)) {
    throw new BadRequestException('请选择目标楼栋');
  }
  if (!clean(request.clientMutationId)) {
    throw new BadRequestException('请求标识不能为空');
  }
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
    throw new BadRequestException('确认入库数量必须为正整数');
  }
  if (request.quantity > pending.quantity) {
    throw new BadRequestException(
      `确认入库数量不能超过实际签收数量（${pending.quantity}）`,
    );
  }
  if (!Number.isFinite(Date.parse(request.occurredAt))) {
    throw new BadRequestException('请选择有效入库时间');
  }
  validatePurchaseNewItem(request.newItem);
  if (!clean(request.newItem?.locationRecordId)) {
    throw new BadRequestException('请选择底表中的存放位置');
  }
}

function validatePurchaseNewItem(
  item: PurchaseInboundCategoryPrepareRequest['newItem'] | undefined,
): void {
  if (!item) throw new BadRequestException('请补全库存新品类别信息');
  if (!clean(item.name)) throw new BadRequestException('请填写物品名称');
  if (!clean(item.primaryCategory) || !clean(item.secondaryCategory)) {
    throw new BadRequestException('请选择完整物品分类');
  }
  if (!clean(item.specification)) {
    throw new BadRequestException('请填写规格型号');
  }
  if (!clean(item.location)) throw new BadRequestException('请填写目标库位');
  if (
    item.minimumQuantity !== undefined &&
    (!Number.isFinite(item.minimumQuantity) || item.minimumQuantity < 0)
  ) {
    throw new BadRequestException('最小库存量不得为负数');
  }
}

export function buildNewCatalogFields(
  request: PurchaseInboundConfirmRequest,
  pending: PurchasePendingInboundItem,
  generatedSku: string,
): Record<string, unknown> {
  const item = request.newItem!;
  return {
    物品类别号: normalizeSku(generatedSku),
    名称: clean(item.name),
    楼栋: targetBuilding(request, pending),
    一级分类: clean(item.primaryCategory),
    二级分类: clean(item.secondaryCategory),
    '规格型号、设备序列号': clean(item.specification),
    品牌: clean(item.brand),
    计数单位: clean(item.unit),
    最小库存量: item.minimumQuantity,
  };
}

export function buildPurchaseInboundFields(
  request: PurchaseInboundConfirmRequest,
  pending: PurchasePendingInboundItem,
  generatedSku: string,
): Record<string, unknown> {
  return {
    物品类别号: normalizeSku(generatedSku),
    入库数量: request.quantity,
    楼栋: targetBuilding(request, pending),
    入库日期: Date.parse(request.occurredAt),
    入库来源: `采购:${pending.executionRecordId}`,
  };
}

export function buildPurchaseInboundCompletionFields(input: {
  sku: string;
  quantity: number;
}): Record<string, unknown> {
  return {
    物品类别码: normalizeSku(input.sku),
    实际采购数量: input.quantity,
    是否已入库: true,
    采购流程: '采购完成（已入库）',
    程序采购状态: '物品签收已入库',
  };
}

function getRecordId(record?: PurchaseInboundSourceRecord): string {
  return clean(record?.record_id || record?.id);
}

function parsePreparedCategory(
  record: PurchaseInboundSourceRecord,
  executionRecordId: string,
): PurchaseInboundPreparedCategory {
  const fields = record.fields || {};
  const sourceKey = fieldText(fields, ['入库创建标识']);
  const fingerprint = fieldText(fields, ['入库请求指纹']);
  const rawPayload = fieldText(fields, ['采购入库准备参数']);
  if (
    sourceKey !== `采购:${executionRecordId}` ||
    !/^[a-f0-9]{64}$/i.test(fingerprint) ||
    !rawPayload
  ) {
    throw new BadRequestException('采购预备物品类别标识或指纹无效');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    throw new BadRequestException('采购预备物品类别准备参数无效');
  }
  if (!isRecord(payload) || payload.version !== 1) {
    throw new BadRequestException('采购预备物品类别准备参数版本无效');
  }
  const request = payload.request;
  if (
    !isRecord(request) ||
    request.type !== 'inbound' ||
    request.mode !== 'new' ||
    !isWarehouseBuilding(request.building) ||
    !Number.isInteger(request.quantity) ||
    Number(request.quantity) <= 0 ||
    !Number.isFinite(Date.parse(clean(request.occurredAt))) ||
    !clean(request.clientMutationId) ||
    !isRecord(request.newItem)
  ) {
    throw new BadRequestException('采购预备物品类别请求参数无效');
  }

  const preparedTimestamp = Date.parse(clean(payload.preparedAt));
  const item = request.newItem;
  const minimumQuantity = item.minimumQuantity;
  if (
    !clean(item.primaryCategory) ||
    !clean(item.secondaryCategory) ||
    !clean(item.name) ||
    !clean(item.specification) ||
    !clean(item.location) ||
    (minimumQuantity !== undefined &&
      (!Number.isFinite(minimumQuantity) || Number(minimumQuantity) < 0)) ||
    !Number.isFinite(preparedTimestamp)
  ) {
    throw new BadRequestException('采购预备物品类别新品资料无效');
  }

  const catalogRecordId = getRecordId(record);
  const sku = normalizeSku(
    fieldText(fields, ['物品类别号', '物品类别号（单选）']),
  );
  if (!catalogRecordId || !sku) {
    throw new BadRequestException('采购预备物品类别记录或类别号缺失');
  }
  const persistedMinimum = optionalFiniteNumber(
    fieldValue(fields, ['最小库存量']),
  );
  const expectedMinimum =
    minimumQuantity === undefined ? null : Number(minimumQuantity);
  if (
    fieldBuilding(fields, ['楼栋']) !== request.building ||
    fieldText(fields, ['一级分类']) !== clean(item.primaryCategory) ||
    fieldText(fields, ['二级分类']) !== clean(item.secondaryCategory) ||
    fieldText(fields, ['名称']) !== clean(item.name) ||
    fieldText(fields, ['规格型号、设备序列号']) !== clean(item.specification) ||
    (item.brand !== undefined &&
      fieldText(fields, ['品牌']) !== clean(item.brand)) ||
    (item.unit !== undefined &&
      fieldText(fields, ['计数单位']) !== clean(item.unit)) ||
    (minimumQuantity !== undefined && persistedMinimum !== expectedMinimum)
  ) {
    throw new BadRequestException('采购预备物品类别与准备参数不一致');
  }

  return {
    catalogRecordId,
    sku,
    preparedAt: new Date(preparedTimestamp).toISOString(),
    clientMutationId: clean(request.clientMutationId),
    building: request.building,
    quantity: Number(request.quantity),
    occurredAt: new Date(Date.parse(clean(request.occurredAt))).toISOString(),
    newItem: {
      primaryCategory: clean(item.primaryCategory),
      secondaryCategory: clean(item.secondaryCategory),
      name: clean(item.name),
      specification: clean(item.specification),
      location: clean(item.location),
      ...(clean(item.locationRecordId)
        ? { locationRecordId: clean(item.locationRecordId) }
        : {}),
      ...(item.brand !== undefined ? { brand: clean(item.brand) } : {}),
      ...(item.unit !== undefined ? { unit: clean(item.unit) } : {}),
      ...(minimumQuantity !== undefined
        ? { minimumQuantity: Number(minimumQuantity) }
        : {}),
    },
  };
}

function fieldValue(fields: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  }
  return undefined;
}

function fieldText(
  fields: Record<string, unknown> | undefined,
  names: string[],
): string {
  return displayValues(fieldValue(fields || {}, names))
    .join('、')
    .trim();
}

function fieldNumber(fields: Record<string, unknown>, names: string[]): number {
  const value = fieldValue(fields, names);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(displayValues(value).join(''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fieldBuilding(
  fields: Record<string, unknown> | undefined,
  names: string[],
): WarehouseBuilding | null {
  const values = displayValues(fieldValue(fields || {}, names));
  return (
    WAREHOUSE_BUILDINGS.find((building) => values.includes(building)) || null
  );
}

function fieldDate(
  fields: Record<string, unknown>,
  names: string[],
): string | null {
  const value = fieldValue(fields, names);
  const timestamp =
    typeof value === 'number' ? value : Date.parse(fieldText(fields, names));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function optionalFiniteNumber(value: unknown): number | null {
  if (
    value === undefined ||
    value === null ||
    displayValues(value).length === 0
  ) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(displayValues(value).join(''));
  return Number.isFinite(parsed) ? parsed : null;
}

function fieldChecked(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = displayValues(value).join('').trim().toLowerCase();
  return text === 'true' || text === '是' || text === '1' || text === '已确认';
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

function normalizeSku(value: unknown): string {
  return clean(value).toUpperCase();
}

function hasStrictPurchaseSignal(
  request: PurchaseInboundConfirmRequest,
): request is Exclude<
  PurchaseInboundConfirmRequest,
  { building?: never; clientMutationId?: never }
> {
  return (
    Object.prototype.hasOwnProperty.call(request, 'building') ||
    Object.prototype.hasOwnProperty.call(request, 'clientMutationId')
  );
}

function targetBuilding(
  request: PurchaseInboundConfirmRequest,
  pending: PurchasePendingInboundItem,
): WarehouseBuilding {
  return hasStrictPurchaseSignal(request) &&
    isWarehouseBuilding(request.building)
    ? request.building
    : pending.building;
}

function isWarehouseBuilding(value: unknown): value is WarehouseBuilding {
  return (
    typeof value === 'string' &&
    WAREHOUSE_BUILDINGS.includes(value as WarehouseBuilding)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
