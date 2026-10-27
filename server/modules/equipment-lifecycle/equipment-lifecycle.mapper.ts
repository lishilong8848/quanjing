import type {
  EquipmentLifecycleAsset,
  EquipmentLifecycleBuildingUsage,
  EquipmentLifecycleDashboardResponse,
  EquipmentLifecycleExpiryHeatmapRow,
  EquipmentLifecycleLongTermMaintenancePoint,
  EquipmentLifecycleRelatedRecord,
  EquipmentLifecycleSourceStatus,
  EquipmentLifecycleSourceTable,
  EquipmentLifecycleSourceTableKey,
  EquipmentLifecycleStatusPoint,
  EquipmentLifecycleTableStatus,
  EquipmentLifecycleTopDevice,
} from '../../../shared/equipment-lifecycle.interface';
import {
  type BitableRecordItem,
  extractDateTimeIso,
  extractDateValue,
  extractDisplayText,
  extractNumberValue,
  getRecordId,
} from '../../common/feishu/bitable-direct-read';
import { normalizeLedgerBuilding } from './equipment-ledger.model';

export interface EquipmentLifecycleSourceInput {
  records: BitableRecordItem[] | null;
  status: EquipmentLifecycleTableStatus;
}

export type EquipmentLifecycleSources = Record<
  EquipmentLifecycleSourceTableKey,
  EquipmentLifecycleSourceInput
>;

interface EquipmentLifecycleMapperOptions {
  month: string;
  syncedAt: string;
  building?: string;
}

const SOURCE_KEYS: EquipmentLifecycleSourceTableKey[] = [
  'equipment',
  'longTermMaintenance',
  'keyParts',
  'maintenanceContracts',
];

const PARTIAL_WARNING =
  '部分飞书数据源暂时不可用，当前展示可用数据及最近一次成功快照。';
const STALE_WARNING =
  '飞书实时数据暂时不可用，当前展示最近一次成功同步的数据。';

export function mapEquipmentLifecycleDashboard(
  sources: EquipmentLifecycleSources,
  options: EquipmentLifecycleMapperOptions,
): EquipmentLifecycleDashboardResponse {
  if (options.building) {
    const scoped = { ...sources };
    for (const key of SOURCE_KEYS) {
      const source = sources[key];
      scoped[key] = {
        ...source,
        records:
          source.records
            ?.filter(
              (record) =>
                normalizeLedgerBuilding(getBuilding(record.fields || {})) ===
                options.building,
            )
            .map((record) => ({
              ...record,
              fields: { ...record.fields, 楼栋: options.building },
            })) ?? null,
      };
    }
    sources = scoped;
  }
  const equipmentRecords = sources.equipment.records;
  const longTermRecords = sources.longTermMaintenance.records;
  const visibleLongTermRecords =
    longTermRecords?.filter(
      (record) => !isMainTransformerBuilding(getBuilding(record.fields || {})),
    ) ?? null;
  const keyPartRecords = sources.keyParts.records;
  const contractRecords = sources.maintenanceContracts.records;
  const assets = equipmentRecords?.map(mapEquipmentAsset) ?? [];
  const sourceTables = buildSourceTables(sources);
  const sourceUpdatedAt = latestIso(
    sourceTables.map(({ updatedAt }) => updatedAt),
  );
  const sourceStatus = resolveSourceStatus(sourceTables);
  const missingEquipmentStatusCount =
    equipmentRecords?.filter((record) => !text(record.fields?.['状态']))
      .length ?? 0;
  const warnings = buildWarnings(sourceStatus, missingEquipmentStatusCount);

  return {
    month: options.month,
    availableMonths: [options.month],
    updatedAt: sourceUpdatedAt || options.syncedAt,
    sourceUpdatedAt,
    syncedAt: options.syncedAt,
    sourceStatus,
    warnings,
    summary: {
      equipmentTotal: equipmentRecords?.length ?? null,
      keyPartTotal: keyPartRecords?.length ?? null,
      expiringEquipment:
        equipmentRecords === null
          ? null
          : countStatus(equipmentRecords, '状态', '待评估'),
      expiredContracts:
        contractRecords === null
          ? null
          : countStatus(contractRecords, '合同当前状态', '过保'),
      maintenanceContracts: contractRecords?.length ?? null,
      longTermMaintenance: visibleLongTermRecords?.length ?? null,
    },
    maintenanceContractInWarrantyRate:
      contractRecords === null || contractRecords.length === 0
        ? null
        : roundOne(
            (countStatus(contractRecords, '合同当前状态', '在保') /
              contractRecords.length) *
              100,
          ),
    buildingUsage:
      equipmentRecords === null ? [] : buildBuildingUsage(equipmentRecords),
    longTermMaintenance:
      visibleLongTermRecords === null
        ? []
        : buildLongTermMaintenance(visibleLongTermRecords),
    maintenanceContracts:
      contractRecords === null
        ? []
        : buildThreeStatusPoints(contractRecords, '合同当前状态'),
    keyPartWarnings:
      keyPartRecords === null
        ? []
        : buildThreeStatusPoints(keyPartRecords, '状态'),
    expiryHeatmap:
      equipmentRecords === null ? [] : buildExpiryHeatmap(equipmentRecords),
    topDevices:
      equipmentRecords === null ? [] : buildTopDevices(equipmentRecords),
    filterOptions: {
      buildings: uniqueSorted(assets.map(({ building }) => building)),
      specialties: uniqueSorted(assets.map(({ specialty }) => specialty)),
      managers: uniqueSorted(assets.map(({ manager }) => manager)),
      statuses: uniqueSorted(assets.map(({ status }) => status)),
    },
    assets,
    relatedRecords: {
      longTermMaintenance:
        visibleLongTermRecords?.map(mapLongTermMaintenanceRecord) ?? [],
      keyParts: keyPartRecords?.map(mapKeyPartRecord) ?? [],
      maintenanceContracts:
        contractRecords?.map(mapMaintenanceContractRecord) ?? [],
    },
    sourceTables,
  };
}

function mapEquipmentAsset(record: BitableRecordItem): EquipmentLifecycleAsset {
  const fields = record.fields || {};
  const deviceName = text(fields['设备名称']);
  const manager = text(fields['管理员']);

  return {
    id: getRecordId(record),
    description: text(fields['描述']) || deviceName || '—',
    building: text(fields['楼栋']),
    deviceName: deviceName || '—',
    specialty: text(fields['专业']),
    manager: manager || '—',
    managerInitial: Array.from(manager || '—')[0] || '—',
    serviceYears: extractNumberValue(fields['运维服役年限']),
    lastReplacementDate: extractDateValue(fields['上次更换日期']),
    currentExpiryDate: extractDateValue(fields['本次到期日期']),
    status: text(fields['状态']) || '未填写',
    nextReplacementDate: extractDateValue(fields['预计下次更换日期']),
  };
}

function mapLongTermMaintenanceRecord(
  record: BitableRecordItem,
): EquipmentLifecycleRelatedRecord {
  const fields = record.fields || {};
  const name = text(fields['维护名称']);

  return {
    id: getRecordId(record),
    description: text(fields['描述']) || name || '—',
    name: name || '—',
    building: getBuilding(fields),
    specialty: text(fields['专业']) || '—',
    owner: text(fields['责任人']) || '—',
    status: text(fields['状态']) || '未填写',
    previousDate: extractDateValue(fields['上次维护日期']),
    dueDate: extractDateValue(fields['本次到期日期']),
    nextDate: extractDateValue(fields['预计下次维护日期']),
    countdownDays: extractNumberValue(fields['到期倒计时']),
  };
}

function mapKeyPartRecord(
  record: BitableRecordItem,
): EquipmentLifecycleRelatedRecord {
  const fields = record.fields || {};
  const name = text(fields['关键器件项目']) || text(fields['设备类型']) || '—';

  return {
    id: getRecordId(record),
    description: text(fields['描述']) || name,
    name,
    building: getBuilding(fields),
    specialty: text(fields['专业']) || '—',
    owner: text(fields['责任人']) || '—',
    status: text(fields['状态']) || '未填写',
    previousDate: extractDateValue(fields['上次更换时间']),
    dueDate: extractDateValue(fields['下次更换时间']),
    nextDate: null,
    countdownDays: null,
  };
}

function mapMaintenanceContractRecord(
  record: BitableRecordItem,
): EquipmentLifecycleRelatedRecord {
  const fields = record.fields || {};
  const name = text(fields['设备名称']) || text(fields['设备类型']) || '—';

  return {
    id: getRecordId(record),
    description: text(fields['描述']) || name,
    name,
    building: getBuilding(fields),
    specialty: text(fields['专业']) || '—',
    owner: text(fields['责任人']) || '—',
    status: text(fields['合同当前状态']) || '未填写',
    previousDate: null,
    dueDate: extractDateValue(fields['本轮截止日期']),
    nextDate: null,
    countdownDays: null,
  };
}

function buildBuildingUsage(
  records: BitableRecordItem[],
): EquipmentLifecycleBuildingUsage[] {
  const groups = groupByBuilding(records);
  return [...groups.entries()]
    .sort(([left], [right]) => compareBuilding(left, right))
    .map(([building, buildingRecords]) => {
      const notExpired = countStatus(buildingRecords, '状态', '未到期');
      const evaluation = countStatus(buildingRecords, '状态', '待评估');
      const total = notExpired + evaluation;
      return {
        building,
        notExpiredRate: total === 0 ? 0 : roundOne((notExpired / total) * 100),
        evaluationRate: total === 0 ? 0 : roundOne((evaluation / total) * 100),
        notExpired,
        evaluation,
      };
    });
}

function buildLongTermMaintenance(
  records: BitableRecordItem[],
): EquipmentLifecycleLongTermMaintenancePoint[] {
  return [...groupByBuilding(records).entries()]
    .sort(([left], [right]) => compareBuilding(left, right))
    .map(([building, buildingRecords]) => ({
      building,
      inWarranty: countStatus(buildingRecords, '状态', '在保'),
      expired: countStatus(buildingRecords, '状态', '到期'),
    }));
}

function buildThreeStatusPoints(
  records: BitableRecordItem[],
  statusField: string,
): EquipmentLifecycleStatusPoint[] {
  return [...groupByBuilding(records).entries()]
    .sort(([left], [right]) => compareBuilding(left, right))
    .map(([building, buildingRecords]) => ({
      building,
      inWarranty: countStatus(buildingRecords, statusField, '在保'),
      warning: countStatus(buildingRecords, statusField, '三月预警'),
      expired: countStatus(buildingRecords, statusField, '过保'),
    }));
}

function buildExpiryHeatmap(
  records: BitableRecordItem[],
): EquipmentLifecycleExpiryHeatmapRow[] {
  return [...groupByBuilding(records).entries()]
    .sort(([left], [right]) => compareBuilding(left, right))
    .map(([building, buildingRecords]) => {
      const values = Array.from({ length: 12 }, () => 0);
      for (const record of buildingRecords) {
        const date = extractDateValue(record.fields?.['本次到期日期']);
        const match = date?.match(/^\d{4}-(\d{2})-\d{2}$/u);
        if (!match) continue;
        const monthIndex = Number(match[1]) - 1;
        if (monthIndex >= 0 && monthIndex < values.length) {
          values[monthIndex] += 1;
        }
      }
      return { building, values };
    });
}

function buildTopDevices(
  records: BitableRecordItem[],
): EquipmentLifecycleTopDevice[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const name = text(record.fields?.['设备名称']);
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  return [...counts.entries()]
    .sort(
      ([leftName, leftCount], [rightName, rightCount]) =>
        rightCount - leftCount || leftName.localeCompare(rightName, 'zh-CN'),
    )
    .slice(0, 5)
    .map(([name, count], index) => ({
      id: `top-${index + 1}`,
      name,
      count,
    }));
}

function buildSourceTables(
  sources: EquipmentLifecycleSources,
): EquipmentLifecycleSourceTable[] {
  return SOURCE_KEYS.map((key) => {
    const source = sources[key];
    return {
      key,
      status: source.status,
      recordCount: source.records?.length ?? null,
      updatedAt: source.records
        ? latestIso(
            source.records.map((record) =>
              extractDateTimeIso(record.last_modified_time),
            ),
          )
        : null,
    };
  });
}

function resolveSourceStatus(
  sources: EquipmentLifecycleSourceTable[],
): EquipmentLifecycleSourceStatus {
  if (sources.every(({ status }) => status === 'fresh')) {
    return 'fresh';
  }
  if (sources.every(({ status }) => status === 'stale')) {
    return 'stale';
  }
  return 'partial';
}

function buildWarnings(
  sourceStatus: EquipmentLifecycleSourceStatus,
  missingEquipmentStatusCount: number,
): string[] {
  const warnings: string[] = [];
  if (sourceStatus !== 'fresh') {
    warnings.push(sourceStatus === 'stale' ? STALE_WARNING : PARTIAL_WARNING);
  }
  if (missingEquipmentStatusCount > 0) {
    warnings.push(
      `${missingEquipmentStatusCount}条设备状态未填写，未纳入使用状态比例。`,
    );
  }
  return warnings;
}

function groupByBuilding(
  records: BitableRecordItem[],
): Map<string, BitableRecordItem[]> {
  const groups = new Map<string, BitableRecordItem[]>();
  for (const record of records) {
    const fields = record.fields || {};
    const building = getBuilding(fields);
    if (!building) continue;
    const current = groups.get(building) || [];
    current.push(record);
    groups.set(building, current);
  }
  return groups;
}

function getBuilding(fields: Record<string, unknown>): string {
  return text(fields['楼栋']) || text(fields['园区楼栋']);
}

function isMainTransformerBuilding(building: string): boolean {
  return /^#?\d+\s*主变$/u.test(building.trim());
}

function countStatus(
  records: BitableRecordItem[],
  fieldName: string,
  expected: string,
): number {
  return records.filter(
    (record) => text(record.fields?.[fieldName]) === expected,
  ).length;
}

function text(value: unknown): string {
  return extractDisplayText(value, '、').trim();
}

function latestIso(values: Array<string | null>): string | null {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) || null
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function compareBuilding(left: string, right: string): number {
  const order = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'];
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (
      (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
      (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
    );
  }
  return left.localeCompare(right, 'zh-CN');
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
