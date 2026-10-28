import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { accessBuildings, canAccessBuilding } from '../../../shared/building-access';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { filterProfessionalRecords, recordProfessionalSpecialty, scopeProfessionalBitableRecords } from '../../common/access/professional-record-scope';
import { canManageProfessionalRecord, PROFESSIONAL_SPECIALTIES } from '../../../shared/professional-access';
import type {
  InventoryBuildingSummary,
  InventoryCategorySummary,
  InventoryItemsQuery,
  InventoryItemsResponse,
  InventoryManagementDashboard,
  InventoryManagementItem,
  InventoryManagementSourceStatus,
  InventoryMovementCollection,
  InventoryMovementItem,
  InventoryMovementsQuery,
  InventoryMovementsResponse,
  InventoryMovementType,
  InventoryOutboundMovementItem,
  InventoryOutboundStatus,
  InventorySourceKey,
  InventoryStocktakeSummary,
  WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import { getWarehouseInventoryLocationReadFieldNames } from '../../common/config/warehouse-inventory-location.config';
import {
  extractDisplayText,
  extractDisplayValues,
  extractNumberValue,
  getRecordId,
  pickField,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

type RecordFields = Record<string, unknown>;
type CatalogIndex = Map<string, RecordFields>;
type InventoryLocationIndex = Map<string, string>;
type InventoryNonOutboundMovementType = Exclude<
  InventoryMovementType,
  'outbound'
>;

interface NormalizedOutboundState {
  programRecord: boolean;
  status: InventoryOutboundStatus;
}

type InventoryOutboundWorkflowStatus =
  | '待路由'
  | '待审批'
  | '已通过'
  | '已驳回'
  | '同步异常';

const OUTBOUND_PROGRAM_FIELD_NAMES = [
  '出库创建标识',
  '程序出库状态',
  '程序出库申请数量',
  '程序出库申请时间',
  '出库请求指纹',
  '出库确认标识',
  '出库工作流状态',
  '出库当前审批人',
  '出库实际审批人',
  '出库审批时间',
  '出库审批策略版本',
  '出库驳回原因',
  '出库审批动作标识',
  '出库工作流错误',
  '出库审批投递台账',
  '出库审批收尾状态',
  '出库审批结果投递台账',
] as const;

export interface BuildInventorySnapshotInput {
  generatedAt: string;
  sourceUrl: string;
  inventory: BitableRecordItem[];
  catalog: BitableRecordItem[];
  inbound: BitableRecordItem[];
  outbound: BitableRecordItem[];
  borrow: BitableRecordItem[];
  prices: BitableRecordItem[];
  stocktakeSummaries: BitableRecordItem[];
  managers: BitableRecordItem[];
  sectionStatus: Record<InventorySourceKey, InventoryManagementSourceStatus>;
  now?: Date;
  principal?: AccessPrincipal;
}

export interface InventoryManagementSnapshot {
  dashboard: InventoryManagementDashboard;
  items: InventoryManagementItem[];
  movements: InventoryMovementCollection;
}

export function buildInventoryManagementSnapshot(
  input: BuildInventorySnapshotInput,
): InventoryManagementSnapshot {
  const now = input.now ?? new Date();
  const catalog = buildCatalogIndex(input.catalog);
  const locations = buildInventoryLocationIndex(input.inventory);
  let items = filterProfessionalRecords(input.principal, input.inventory.map((record, index) =>
    mapInventoryItem(record, index, catalog),
  ), item => item.specialty);
  const scopedPrincipal = isProfessionalBusinessPrincipal(input.principal);
  const scope = input.principal && !scopedPrincipal ? accessBuildings(input.principal) : null;
  const scopedItems = scope ? items.filter(item => canAccessBuilding(input.principal!, item.building)) : items;
  items = scopedItems;
  const managers = buildManagerIndex(input.managers);
  const visibleBuildings = scopedPrincipal ? WAREHOUSE_BUILDINGS.filter(building => PROFESSIONAL_SPECIALTIES.some(specialty => canManageProfessionalRecord(input.principal!, specialty, building))) : scope;
  const buildings = buildBuildingSummaries(items, managers).filter(item => !visibleBuildings || visibleBuildings.includes(item.building));
  const categories = buildCategorySummaries(items);
  const stocktake = buildStocktakeSummaries(
    scopeProfessionalBitableRecords(input.principal, input.stocktakeSummaries),
    managers,
    now,
  );
  const movements = {
    inbound: buildMovements(input.inbound, 'inbound', now, catalog, locations),
    outbound: buildMovements(
      input.outbound,
      'outbound',
      now,
      catalog,
      locations,
    ),
    borrow: buildMovements(input.borrow, 'borrow', now, catalog, locations),
  } satisfies InventoryMovementCollection;
  movements.inbound = filterProfessionalRecords(input.principal, movements.inbound, item => item.specialty, item => item.destinationBuilding && item.destinationBuilding !== '未配置' ? [item.building, item.destinationBuilding] : item.building);
  movements.outbound = filterProfessionalRecords(input.principal, movements.outbound, item => item.specialty, item => item.destinationBuilding && item.destinationBuilding !== '未配置' ? [item.building, item.destinationBuilding] : item.building);
  movements.borrow = filterProfessionalRecords(input.principal, movements.borrow, item => item.specialty, item => item.destinationBuilding && item.destinationBuilding !== '未配置' ? [item.building, item.destinationBuilding] : item.building);
  if (scope) {
    const filterMovements = <T extends InventoryMovementItem>(rows: T[]): T[] => rows.filter(item => canAccessBuilding(input.principal!, item.building) && (!item.destinationBuilding || item.destinationBuilding === '未配置' || canAccessBuilding(input.principal!, item.destinationBuilding)));
    movements.inbound = filterMovements(movements.inbound);
    movements.outbound = filterMovements(movements.outbound);
    movements.borrow = filterMovements(movements.borrow);
  }
  const alerts = items
    .filter((item) => item.lowStock || item.negativeStock)
    .sort(compareInventoryRisk)
    .slice(0, 100);
  const distinctSkus = new Set(items.map((item) => item.sku || item.recordId))
    .size;

  return {
    items,
    movements,
    dashboard: {
      generatedAt: input.generatedAt,
      sourceUrl: input.sourceUrl,
      summary: {
        inventoryLines: items.length,
        distinctSkus,
        totalQuantity: sum(items, (item) => item.quantity),
        inventoryValue: roundMoney(sum(items, (item) => item.value)),
        lowStockItems: count(items, (item) => item.lowStock),
        negativeStockItems: count(items, (item) => item.negativeStock),
        idleItems: count(items, (item) => item.idle),
        pendingConfirmationItems: count(
          items,
          (item) => item.pendingConfirmation,
        ),
        unassignedInventoryLines: count(
          items,
          (item) => item.building === '未配置',
        ),
      },
      buildings,
      categories,
      alerts,
      movements: {
        inbound: movements.inbound.slice(0, 50),
        outbound: movements.outbound.slice(0, 50),
        borrow: movements.borrow.slice(0, 50),
      } satisfies InventoryMovementCollection,
      stocktake: stocktake.latest,
      stocktakeHistory: stocktake.history,
      sectionStatus: (isProfessionalBusinessPrincipal(input.principal) || scope) ? Object.fromEntries(Object.entries(input.sectionStatus).map(([key, status]) => [key, { ...status, count: key === 'inventory' ? items.length : key === 'inbound' || key === 'outbound' || key === 'borrow' ? movements[key].length : 0 }])) as typeof input.sectionStatus : input.sectionStatus,
    },
  };
}

export function queryInventoryItems(
  items: InventoryManagementItem[],
  query: InventoryItemsQuery,
): InventoryItemsResponse {
  if (query.allowedBuildings) items = items.filter(item => query.allowedBuildings!.includes(item.building as never));
  const building = query.building || 'all';
  const buildingScopedItems =
    building === 'all'
      ? items
      : items.filter((item) => item.building === building);
  const categories = Array.from(
    new Set(
      buildingScopedItems
        .map((item) => String(item.primaryCategory || '').trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const search = String(query.search || '')
    .trim()
    .toLowerCase();
  const category = String(query.category || 'all').trim();
  const risk = query.risk || 'all';
  const sort = query.sort || 'risk';
  const pageSize = clampInteger(query.pageSize, 20, 1, 100);

  const filtered = buildingScopedItems.filter((item) => {
    if (category !== 'all' && item.primaryCategory !== category) return false;
    if (risk === 'low' && !item.lowStock) return false;
    if (risk === 'negative' && !item.negativeStock) return false;
    if (risk === 'idle' && !item.idle) return false;
    if (!search) return true;

    return [
      item.sku,
      item.name,
      item.specification,
      item.brand,
      item.primaryCategory,
      item.secondaryCategory,
      item.building,
      item.location,
      item.storageType,
      item.unit,
      ...item.owners,
    ]
      .join(' ')
      .toLowerCase()
      .includes(search);
  });

  filtered.sort(inventoryComparator(sort));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInteger(query.page, 1, 1, totalPages);
  const start = (page - 1) * pageSize;

  return {
    items: filtered.slice(start, start + pageSize),
    categories,
    total,
    page,
    pageSize,
    totalPages,
  };
}

export function queryInventoryMovements(
  movements: InventoryMovementCollection,
  query: InventoryMovementsQuery,
): InventoryMovementsResponse {
  const search = String(query.search || '')
    .trim()
    .toLowerCase();
  const building = query.building || 'all';
  const status = String(query.status || 'all').trim() || 'all';
  const pageSize = clampInteger(query.pageSize, 20, 1, 100);

  const filtered = (movements[query.type] || []).filter((item) => {
    if (query.allowedBuildings && !query.allowedBuildings.includes(item.building as never)) return false;
    if (building !== 'all' && item.building !== building) return false;
    if (status !== 'all' && item.status !== status) return false;
    if (!search) return true;
    return [
      item.sku,
      item.name,
      item.specification,
      item.building,
      item.destinationBuilding,
      item.location,
      item.reason,
      item.operator,
      item.applicant,
      item.status,
    ]
      .join(' ')
      .toLowerCase()
      .includes(search);
  });

  const statusCounts = new Map<string, number>();
  for (const item of filtered) {
    const itemStatus = item.status || '状态未填写';
    statusCounts.set(itemStatus, (statusCounts.get(itemStatus) || 0) + 1);
  }

  const sorted = [...filtered].sort(
    (left, right) => dateScore(right.occurredAt) - dateScore(left.occurredAt),
  );
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInteger(query.page, 1, 1, totalPages);
  const start = (page - 1) * pageSize;

  return {
    items: sorted.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
    summary: {
      totalRecords: total,
      totalQuantity: sum(filtered, (item) => item.quantity),
      overdueItems: count(filtered, (item) => item.overdue),
      statusCounts: Array.from(statusCounts, ([itemStatus, itemCount]) => ({
        status: itemStatus,
        count: itemCount,
      })),
    },
  };
}

function mapInventoryItem(
  record: BitableRecordItem,
  index: number,
  catalog: CatalogIndex,
): InventoryManagementItem {
  const fields = fieldsOf(record);
  const recordId = getRecordId(record) || `inventory:${index}`;
  const sku = text(fields, ['物品类别号']);
  const inventoryBuilding = building(fields, ['楼栋']);
  const catalogFields = findCatalogFields(catalog, sku, inventoryBuilding);
  const specialty = recordProfessionalSpecialty({ record_id: '', fields: catalogFields }) || recordProfessionalSpecialty(record);
  const quantity = number(fields, ['剩余库存']) ?? 0;
  const minimumQuantity =
    number(fields, ['最小库存量']) ??
    number(catalogFields, ['最小库存量']) ??
    0;
  const reportedDifference = number(fields, ['剩余库存是否满足最小库存量']);
  const difference = reportedDifference ?? quantity - minimumQuantity;
  const riskLabel = text(fields, ['是否达到最小库存']);
  const annualUsage = number(fields, ['年度使用频次']) ?? 0;
  const reportedValue = number(fields, ['现存物品价格']);
  const unitPrice = number(catalogFields, ['物品单价']);

  return {
    recordId,
    ...(specialty ? { specialty } : {}),
    sku,
    name: resolvedText(fields, ['名称'], catalogFields) || '未命名物品',
    specification: resolvedText(
      fields,
      ['规格型号、设备序列号'],
      catalogFields,
    ),
    brand: resolvedText(fields, ['品牌'], catalogFields),
    primaryCategory:
      resolvedText(fields, ['一级分类'], catalogFields) || '未分类',
    secondaryCategory: resolvedText(fields, ['二级分类'], catalogFields),
    building: inventoryBuilding,
    location: text(fields, getWarehouseInventoryLocationReadFieldNames()),
    storageType: text(fields, ['库内外']),
    quantity,
    minimumQuantity,
    difference,
    unit: resolvedText(fields, ['计数单位'], catalogFields),
    annualUsage,
    value: roundMoney(reportedValue ?? (unitPrice ?? 0) * quantity),
    owners: extractDisplayValues(pickField(fields, ['负责人'])),
    lowStock: difference < 0 || /(库存不足|低于|缺货|预警)/.test(riskLabel),
    negativeStock: quantity < 0,
    idle: annualUsage <= 0,
    pendingConfirmation: checked(pickField(fields, ['待确认'])),
  };
}

function buildBuildingSummaries(
  items: InventoryManagementItem[],
  managers: Map<WarehouseBuilding, string[]>,
): InventoryBuildingSummary[] {
  return WAREHOUSE_BUILDINGS.map((buildingName) => {
    const buildingItems = items.filter(
      (item) => item.building === buildingName,
    );
    return {
      building: buildingName,
      inventoryLines: buildingItems.length,
      distinctSkus: new Set(
        buildingItems.map((item) => item.sku || item.recordId),
      ).size,
      totalQuantity: sum(buildingItems, (item) => item.quantity),
      inventoryValue: roundMoney(sum(buildingItems, (item) => item.value)),
      lowStockItems: count(buildingItems, (item) => item.lowStock),
      negativeStockItems: count(buildingItems, (item) => item.negativeStock),
      idleItems: count(buildingItems, (item) => item.idle),
      owners: dedupe([
        ...(managers.get(buildingName) || []),
        ...buildingItems.flatMap((item) => item.owners),
      ]),
    };
  });
}

function buildCategorySummaries(
  items: InventoryManagementItem[],
): InventoryCategorySummary[] {
  const groups = new Map<string, InventoryManagementItem[]>();
  for (const item of items) {
    const group = groups.get(item.primaryCategory) || [];
    group.push(item);
    groups.set(item.primaryCategory, group);
  }

  return [...groups.entries()]
    .map(([category, categoryItems]) => ({
      category,
      inventoryLines: categoryItems.length,
      distinctSkus: new Set(
        categoryItems.map((item) => item.sku || item.recordId),
      ).size,
      totalQuantity: sum(categoryItems, (item) => item.quantity),
      inventoryValue: roundMoney(sum(categoryItems, (item) => item.value)),
      lowStockItems: count(categoryItems, (item) => item.lowStock),
    }))
    .sort((left, right) => right.inventoryLines - left.inventoryLines);
}

function buildManagerIndex(
  records: BitableRecordItem[],
): Map<WarehouseBuilding, string[]> {
  const result = new Map<WarehouseBuilding, string[]>();
  for (const record of records) {
    const fields = fieldsOf(record);
    const buildingName = building(fields, ['楼栋']);
    if (buildingName === '未配置') continue;
    result.set(
      buildingName,
      dedupe(extractDisplayValues(pickField(fields, ['库房责任人员']))),
    );
  }
  return result;
}

function buildCatalogIndex(records: BitableRecordItem[]): CatalogIndex {
  const result: CatalogIndex = new Map();
  for (const record of records) {
    const fields = fieldsOf(record);
    const sku = text(fields, ['物品类别号', '物品类别号（单选）']);
    if (!sku) continue;
    const recordId = getRecordId(record);
    if (recordId) {
      result.set(catalogRecordKey(recordId), fields);
    }
    const catalogBuilding = building(fields, ['楼栋']);
    if (catalogBuilding !== '未配置') {
      result.set(catalogKey(sku, catalogBuilding), fields);
    }
    if (!result.has(catalogKey(sku, '*'))) {
      result.set(catalogKey(sku, '*'), fields);
    }
  }
  return result;
}

function findCatalogFields(
  catalog: CatalogIndex,
  sku: string,
  targetBuilding: WarehouseBuilding | '未配置',
  linkedRecordId = '',
): RecordFields {
  const linkedFields = linkedRecordId
    ? catalog.get(catalogRecordKey(linkedRecordId))
    : undefined;
  if (linkedFields) return linkedFields;
  if (!sku) return {};
  return (
    (targetBuilding !== '未配置'
      ? catalog.get(catalogKey(sku, targetBuilding))
      : undefined) ||
    catalog.get(catalogKey(sku, '*')) ||
    {}
  );
}

function catalogKey(sku: string, catalogBuilding: string): string {
  return `${catalogBuilding}|${sku.trim().toUpperCase()}`;
}

function catalogRecordKey(recordId: string): string {
  return `record:${recordId}`;
}

function buildInventoryLocationIndex(
  records: BitableRecordItem[],
): InventoryLocationIndex {
  const result: InventoryLocationIndex = new Map();
  for (const record of records) {
    const fields = fieldsOf(record);
    const sku = text(fields, ['物品类别号']);
    const itemBuilding = building(fields, ['楼栋']);
    const location = text(
      fields,
      getWarehouseInventoryLocationReadFieldNames(),
    );
    if (
      !sku ||
      itemBuilding === '未配置' ||
      !location ||
      isOptionReference(location)
    ) {
      continue;
    }
    const key = catalogKey(sku, itemBuilding);
    const existing = result.get(key);
    if (existing === undefined) result.set(key, location);
    else if (existing !== location) result.set(key, '');
  }
  return result;
}

function buildMovements(
  records: BitableRecordItem[],
  type: 'outbound',
  now: Date,
  catalog: CatalogIndex,
  locations: InventoryLocationIndex,
): InventoryOutboundMovementItem[];
function buildMovements(
  records: BitableRecordItem[],
  type: InventoryNonOutboundMovementType,
  now: Date,
  catalog: CatalogIndex,
  locations: InventoryLocationIndex,
): InventoryMovementItem[];
function buildMovements(
  records: BitableRecordItem[],
  type: InventoryMovementType,
  now: Date,
  catalog: CatalogIndex,
  locations: InventoryLocationIndex,
): InventoryMovementItem[] {
  return records
    .map((record, index) => {
      const fields = fieldsOf(record);
      const inbound = type === 'inbound';
      const outbound = type === 'outbound';
      const rawSku = text(fields, ['物品类别号', '物品类别号（单选）']);
      const usableSku = rawSku && !isOptionReference(rawSku) ? rawSku : '';
      const linkedCatalogRecordId = extractLinkedRecordId(
        pickField(fields, ['物品类别号']),
      );
      const movementBuilding = building(fields, [
        inbound ? '楼栋' : outbound ? '楼栋' : '借出楼栋',
      ]);
      const catalogFields = findCatalogFields(
        catalog,
        usableSku,
        movementBuilding,
        linkedCatalogRecordId,
      );
      const sku =
        usableSku || text(catalogFields, ['物品类别号', '物品类别号（单选）']);
      const outboundState = outbound ? normalizeOutboundState(fields) : null;
      const status = inbound
        ? text(fields, ['是否添加']) || '已入库'
        : outboundState
          ? outboundState.status
          : text(fields, ['物品状态']) || '状态未填写';
      const occurredAt = outboundState
        ? outboundState.programRecord
          ? outboundState.status !== '已出库'
            ? dateTime(fields, ['程序出库申请时间'])
            : dateTime(fields, ['出库时间'])
          : dateTime(fields, ['出库时间'])
        : dateTime(fields, [inbound ? '入库日期' : '借调时间']);
      const expectedReturnAt =
        type === 'borrow' ? dateTime(fields, ['预期归还时间']) : null;
      const quantity = outboundState
        ? outboundState.programRecord && outboundState.status !== '已出库'
          ? (number(fields, ['程序出库申请数量']) ?? 0)
          : (number(fields, ['出库数量']) ?? 0)
        : (number(fields, [inbound ? '入库数量' : '借调数量']) ?? 0);
      const clientMutationId = outbound ? text(fields, ['出库创建标识']) : '';
      const specialty = recordProfessionalSpecialty({ record_id: '', fields: catalogFields }) || recordProfessionalSpecialty(record);

      return {
        recordId: getRecordId(record) || `${type}:${index}`,
        ...(specialty ? { specialty } : {}),
        ...(clientMutationId ? { clientMutationId } : {}),
        type,
        sku,
        name: resolvedText(fields, ['名称'], catalogFields) || '未命名物品',
        specification: resolvedText(
          fields,
          ['规格型号、设备序列号'],
          catalogFields,
        ),
        quantity,
        unit: resolvedText(fields, ['计数单位'], catalogFields),
        building: movementBuilding,
        destinationBuilding: '',
        location: resolveMovementLocation(
          fields,
          movementBuilding,
          sku,
          locations,
        ),
        reason: inbound
          ? '入库登记'
          : text(fields, [outbound ? '出库原因/出库后使用地点' : '借调原因']),
        ...(outbound
          ? {
              approvalRejectionReason: text(fields, ['出库驳回原因']),
            }
          : {}),
        operator: text(
          fields,
          inbound
            ? ['责任人', '入库责任人', '经办人']
            : outbound && status === '待审批'
              ? ['出库当前审批人', '经办人']
              : ['经办人'],
        ),
        applicant: text(fields, ['物品申请人']),
        status,
        occurredAt,
        expectedReturnAt,
        overdue:
          type === 'borrow' &&
          status.includes('未归还') &&
          Boolean(expectedReturnAt) &&
          Date.parse(expectedReturnAt || '') < now.getTime(),
        ...(inbound
          ? {
              sourceKind: text(fields, ['入库来源']).startsWith('采购:')
                ? ('purchase' as const)
                : ('manual' as const),
            }
          : {}),
      } satisfies InventoryMovementItem;
    })
    .sort(
      (left, right) => dateScore(right.occurredAt) - dateScore(left.occurredAt),
    );
}

function normalizeOutboundState(fields: RecordFields): NormalizedOutboundState {
  const programRecord = OUTBOUND_PROGRAM_FIELD_NAMES.some((fieldName) =>
    Object.prototype.hasOwnProperty.call(fields, fieldName),
  );
  const programStatus = exactOutboundProgramStatus(
    pickField(fields, ['程序出库状态']),
  );
  const workflowStatus = exactOutboundWorkflowStatus(
    pickField(fields, ['出库工作流状态']),
  );
  if (programRecord) {
    return {
      programRecord,
      status:
        programStatus &&
        workflowStatus &&
        outboundStatePairIsConsistent(programStatus, workflowStatus)
          ? programStatus
          : '待路由',
    };
  }
  return {
    programRecord,
    status: checked(pickField(fields, ['是否借出本楼栋']))
      ? '待库房确认'
      : '已出库',
  };
}

function exactOutboundProgramStatus(
  value: unknown,
): InventoryOutboundStatus | null {
  if (
    value === '待路由' ||
    value === '待审批' ||
    value === '待库房确认' ||
    value === '已驳回' ||
    value === '已出库'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length === 1 ? exactOutboundProgramStatus(value[0]) : null;
  }
  if (!value || typeof value !== 'object') return null;

  const object = value as Record<string, unknown>;
  const nestedValues = ['select', 'name', 'text', 'value']
    .filter((key) => Object.prototype.hasOwnProperty.call(object, key))
    .map((key) => object[key]);
  return nestedValues.length === 1
    ? exactOutboundProgramStatus(nestedValues[0])
    : null;
}

function exactOutboundWorkflowStatus(
  value: unknown,
): InventoryOutboundWorkflowStatus | null {
  if (
    value === '待路由' ||
    value === '待审批' ||
    value === '已通过' ||
    value === '已驳回' ||
    value === '同步异常'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length === 1 ? exactOutboundWorkflowStatus(value[0]) : null;
  }
  if (!value || typeof value !== 'object') return null;

  const object = value as Record<string, unknown>;
  const nestedValues = ['select', 'name', 'text', 'value']
    .filter((key) => Object.prototype.hasOwnProperty.call(object, key))
    .map((key) => object[key]);
  return nestedValues.length === 1
    ? exactOutboundWorkflowStatus(nestedValues[0])
    : null;
}

function outboundStatePairIsConsistent(
  programStatus: InventoryOutboundStatus,
  workflowStatus: InventoryOutboundWorkflowStatus,
): boolean {
  return (
    (programStatus === '待路由' && workflowStatus === '待路由') ||
    (programStatus === '待审批' &&
      (workflowStatus === '待路由' || workflowStatus === '待审批')) ||
    (programStatus === '待库房确认' && workflowStatus === '已通过') ||
    (programStatus === '已驳回' && workflowStatus === '已驳回') ||
    (programStatus === '已出库' && workflowStatus === '已通过')
  );
}

function buildStocktakeSummaries(
  records: BitableRecordItem[],
  managers: Map<WarehouseBuilding, string[]>,
  now: Date,
): { latest: InventoryStocktakeSummary; history: InventoryStocktakeSummary[] } {
  const dated = records
    .map((record) => {
      const fields = fieldsOf(record);
      const date = dateTime(fields, ['日期']);
      const timestamp = date ? Date.parse(date) : Number.NaN;
      return {
        fields,
        date,
        timestamp,
        year: Number.isNaN(timestamp)
          ? null
          : new Date(timestamp + 8 * 60 * 60 * 1000).getUTCFullYear(),
        month:
          number(fields, ['盘点月份']) ??
          (Number.isNaN(timestamp)
            ? null
            : new Date(timestamp + 8 * 60 * 60 * 1000).getUTCMonth() + 1),
      };
    })
    .filter(
      (item) =>
        item.year !== null &&
        item.month !== null &&
        item.month >= 1 &&
        item.month <= 12 &&
        item.timestamp <= now.getTime(),
    )
    .sort((a, b) => b.timestamp - a.timestamp);
  const latest = dated.reduce<(typeof dated)[number] | null>(
    (current, item) =>
      !current || item.timestamp > current.timestamp ? item : current,
    null,
  );
  const summarize = (
    year: number | null,
    month: number | null,
  ): InventoryStocktakeSummary => {
    const selected = dated.filter(
      (item) => item.year === year && item.month === month,
    );
    const buildings = WAREHOUSE_BUILDINGS.map((buildingName) => {
      const record = selected.find(
        (item) => building(item.fields, ['楼栋']) === buildingName,
      );
      const total = record ? (number(record.fields, ['盘点总数']) ?? 0) : 0;
      const completed = record
        ? (number(record.fields, ['已盘点数量']) ?? 0)
        : 0;
      return {
        building: buildingName,
        total,
        completed,
        completionRate: percentage(completed, total),
        responsible:
          (record ? text(record.fields, ['责任人']) : '') ||
          (managers.get(buildingName) || []).join('、'),
      };
    });
    const total = sum(buildings, (item) => item.total);
    const completed = sum(buildings, (item) => item.completed);

    return {
      year,
      month,
      total,
      completed,
      completionRate: percentage(completed, total),
      buildings,
    };
  };
  const periods = new Map<string, { year: number; month: number }>();
  for (const item of dated)
    periods.set(`${item.year}-${item.month}`, {
      year: item.year!,
      month: item.month!,
    });
  return {
    latest: summarize(latest?.year ?? null, latest?.month ?? null),
    history: [...periods.values()]
      .sort((a, b) => b.year - a.year || b.month - a.month)
      .map(({ year, month }) => summarize(year, month)),
  };
}

function inventoryComparator(
  sort: InventoryItemsQuery['sort'],
): (left: InventoryManagementItem, right: InventoryManagementItem) => number {
  if (sort === 'quantityAsc') {
    return (left, right) => left.quantity - right.quantity;
  }
  if (sort === 'quantityDesc') {
    return (left, right) => right.quantity - left.quantity;
  }
  if (sort === 'usageAsc') {
    return (left, right) => left.annualUsage - right.annualUsage;
  }
  if (sort === 'valueDesc') {
    return (left, right) => right.value - left.value;
  }
  return compareInventoryRisk;
}

function compareInventoryRisk(
  left: InventoryManagementItem,
  right: InventoryManagementItem,
): number {
  return (
    riskScore(right) - riskScore(left) ||
    left.difference - right.difference ||
    left.sku.localeCompare(right.sku, 'zh-CN')
  );
}

function riskScore(item: InventoryManagementItem): number {
  if (item.negativeStock) return 3;
  if (item.lowStock) return 2;
  if (item.idle) return 1;
  return 0;
}

function fieldsOf(record: BitableRecordItem): RecordFields {
  return record.fields || {};
}

function text(fields: RecordFields, names: string[]): string {
  return extractDisplayText(pickField(fields, names));
}

function resolvedText(
  fields: RecordFields,
  names: string[],
  catalogFields: RecordFields,
  catalogNames: string[] = names,
): string {
  const value = text(fields, names);
  if (value && !isOptionReference(value)) return value;
  return text(catalogFields, catalogNames);
}

function isOptionReference(value: string): boolean {
  const tokens = value
    .split('、')
    .map((item) => item.trim())
    .filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.every((item) => /^opt[A-Za-z0-9_-]+$/.test(item))
  );
}

function extractLinkedRecordId(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = extractLinkedRecordId(item);
      if (id) return id;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['record_id', 'recordId', 'id']) {
    if (typeof record[key] === 'string' && record[key]) {
      return record[key] as string;
    }
  }
  return '';
}

function resolveMovementLocation(
  fields: RecordFields,
  itemBuilding: WarehouseBuilding | '未配置',
  sku: string,
  locations: InventoryLocationIndex,
): string {
  const rawLocation = text(
    fields,
    getWarehouseInventoryLocationReadFieldNames(),
  );
  if (rawLocation && !isOptionReference(rawLocation)) return rawLocation;
  if (!sku || itemBuilding === '未配置') return '';
  return locations.get(catalogKey(sku, itemBuilding)) || '';
}

function number(fields: RecordFields, names: string[]): number | null {
  return extractNumberValue(pickField(fields, names));
}

function dateTime(fields: RecordFields, names: string[]): string | null {
  return parseDeterministicDateTime(pickField(fields, names));
}

const EXPLICIT_ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i;
const SHANGHAI_LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function parseDeterministicDateTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseDeterministicDateTime(item);
      if (parsed) return parsed;
    }
    return null;
  }
  if (typeof value === 'number') return numericTimestampIso(value);
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^-?(?:\d{10}|\d{13})$/.test(text)) {
      return numericTimestampIso(Number(text));
    }
    const localMatch = SHANGHAI_LOCAL_DATE_TIME_PATTERN.exec(text);
    if (localMatch) {
      const wallClockTimestamp = validatedWallClockTimestamp(localMatch);
      return wallClockTimestamp === null
        ? null
        : numericTimestampIso(wallClockTimestamp - SHANGHAI_OFFSET_MS, false);
    }
    const isoMatch = EXPLICIT_ISO_DATE_TIME_PATTERN.exec(text);
    if (!isoMatch) return null;
    const wallClockTimestamp = validatedWallClockTimestamp(isoMatch);
    const offsetMinutes = parseIsoOffsetMinutes(isoMatch[8]);
    return wallClockTimestamp === null || offsetMinutes === null
      ? null
      : numericTimestampIso(
          wallClockTimestamp - offsetMinutes * 60 * 1000,
          false,
        );
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['timestamp', 'date', 'text', 'value']) {
      const parsed = parseDeterministicDateTime(object[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function numericTimestampIso(
  value: number,
  inferSeconds = true,
): string | null {
  if (!Number.isFinite(value)) return null;
  const timestamp =
    inferSeconds && Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function validatedWallClockTimestamp(match: RegExpExecArray): number | null {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  const fraction = String(match[7] || '')
    .slice(1, 4)
    .padEnd(3, '0');
  const millisecond = Number(fraction || 0);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }
  return date.getTime();
}

function parseIsoOffsetMinutes(value: string): number | null {
  if (value.toUpperCase() === 'Z') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  const offset = hours * 60 + minutes;
  return match[1] === '-' ? -offset : offset;
}

function building(
  fields: RecordFields,
  names: string[],
): WarehouseBuilding | '未配置' {
  return normalizeBuilding(text(fields, names)) || '未配置';
}

function normalizeBuilding(value: string): WarehouseBuilding | null {
  const text = value.trim().toUpperCase();
  if (!text) return null;
  if (text.includes('110')) return '110站';
  for (const code of ['A', 'B', 'C', 'D', 'E', 'H'] as const) {
    if (
      text === code ||
      text.includes(`${code}楼`) ||
      text.includes(`${code}栋`)
    ) {
      return `${code}楼` as WarehouseBuilding;
    }
  }
  return null;
}

function checked(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value > 0;
  return ['true', '1', '是', '已确认', '确认', '✅'].includes(
    extractDisplayText(value).trim().toLowerCase(),
  );
}

function sum<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

function count<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.reduce((total, item) => total + (predicate(item) ? 1 : 0), 0);
}

function percentage(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function dateScore(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
