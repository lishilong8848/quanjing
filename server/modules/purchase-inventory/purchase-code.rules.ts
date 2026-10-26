export const PURCHASE_BUILDING_CODES = {
  'A楼': '1',
  'B楼': '2',
  'C楼': '3',
  'D楼': '4',
  'E楼': '5',
  'H楼': '6',
  '110站': '7',
} as const;

export interface HistoricalPurchaseRecord {
  id: string;
  applicantId: string;
  building: string;
  createdAt: string;
}

export interface HistoricalPurchaseBatch {
  applicantId: string;
  building: string;
  date: string;
  startedAt: string;
  recordIds: string[];
}

const BATCH_WINDOW_MS = 10 * 60 * 1000;

export function purchaseBuildingNumber(building: string): string | undefined {
  return PURCHASE_BUILDING_CODES[
    building as keyof typeof PURCHASE_BUILDING_CODES
  ];
}

export function buildPurchaseOrderCode(
  date: string,
  building: string,
  sequence: number,
): string {
  const buildingNumber = purchaseBuildingNumber(building);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !buildingNumber) {
    throw new Error('采购单号日期或楼栋无效');
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 99) {
    throw new Error('采购单号序号必须为 1 至 99');
  }
  return `CG${date.slice(2).replaceAll('-', '')}-${buildingNumber}${String(
    sequence,
  ).padStart(2, '0')}`;
}

export function groupHistoricalPurchaseBatches(
  records: HistoricalPurchaseRecord[],
): HistoricalPurchaseBatch[] {
  const grouped = new Map<string, HistoricalPurchaseRecord[]>();
  for (const record of records) {
    const date = record.createdAt.slice(0, 10);
    const key = `${date}\u0000${record.building}\u0000${record.applicantId}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(record);
    grouped.set(key, bucket);
  }

  const batches: HistoricalPurchaseBatch[] = [];
  for (const recordsForApplicant of grouped.values()) {
    const ordered = [...recordsForApplicant].sort(compareHistoricalRecord);
    let current: HistoricalPurchaseRecord[] = [];
    let batchStart = 0;

    for (const record of ordered) {
      const createdAt = historicalTimestamp(record.createdAt);
      if (!current.length || createdAt - batchStart <= BATCH_WINDOW_MS) {
        if (!current.length) batchStart = createdAt;
        current.push(record);
        continue;
      }
      batches.push(toBatch(current));
      current = [record];
      batchStart = createdAt;
    }
    if (current.length) batches.push(toBatch(current));
  }

  return batches.sort((left, right) => {
    const startedAt = historicalTimestamp(left.startedAt);
    const comparison = startedAt - historicalTimestamp(right.startedAt);
    if (comparison) return comparison;
    return left.applicantId.localeCompare(right.applicantId, 'zh-CN');
  });
}

function compareHistoricalRecord(
  left: HistoricalPurchaseRecord,
  right: HistoricalPurchaseRecord,
): number {
  const comparison = historicalTimestamp(left.createdAt) - historicalTimestamp(right.createdAt);
  if (comparison) return comparison;
  return left.id.localeCompare(right.id, 'zh-CN');
}

function toBatch(records: HistoricalPurchaseRecord[]): HistoricalPurchaseBatch {
  const first = records[0];
  return {
    applicantId: first.applicantId,
    building: first.building,
    date: first.createdAt.slice(0, 10),
    startedAt: first.createdAt,
    recordIds: records.map((record) => record.id),
  };
}

function historicalTimestamp(value: string): number {
  const timestamp = Date.parse(`${value.replace(' ', 'T')}+08:00`);
  if (!Number.isFinite(timestamp)) throw new Error(`采购记录创建时间无效：${value}`);
  return timestamp;
}
