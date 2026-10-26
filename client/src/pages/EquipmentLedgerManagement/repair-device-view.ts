import type { EquipmentHistoryDevice } from '@shared/equipment-history.interface';
import { classifyLedgerAsset } from '@shared/equipment-ledger-classification';

export type RepairDeviceStatus = 'all' | 'completed' | 'pending';

const faultDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatRepairFaultDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return faultDateFormatter.format(date).replace(/\//g, '-');
}

export function getRepairDevicePage(
  groups: readonly (readonly [string, readonly EquipmentHistoryDevice[]])[],
  requestedPage: number,
) {
  const pageSize = 20;
  const total = groups.reduce((sum, [, rows]) => sum + rows.length, 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const start = (page - 1) * pageSize;
  const result: [string, EquipmentHistoryDevice[]][] = [];
  let offset = 0;
  for (const [key, rows] of groups) {
    const visible = rows.slice(
      Math.max(0, start - offset),
      Math.max(0, start + pageSize - offset),
    );
    if (visible.length) result.push([key, visible]);
    offset += rows.length;
    if (offset >= start + pageSize) break;
  }
  return { groups: result, page, pageCount };
}

export function getRepairDeviceView(
  devices: readonly EquipmentHistoryDevice[],
  filters: {
    floor: string;
    family: string;
    status: RepairDeviceStatus;
    search: string;
  },
) {
  const groups = new Map<string, EquipmentHistoryDevice[]>();
  const term = filters.search.trim().normalize('NFKC').toLocaleLowerCase();
  let deviceCount = 0;
  let recordCount = 0;
  for (const device of devices) {
    const kind = classifyLedgerAsset(device.asset).family;
    const records =
      filters.status === 'completed'
        ? device.completed
        : filters.status === 'pending'
          ? device.pending
          : device.count;
    if (
      !records ||
      (filters.floor && device.asset.building !== filters.floor) ||
      (filters.family && kind !== filters.family)
    )
      continue;
    const searchable = [
      device.asset.name,
      device.asset.code,
      device.asset.sourceCode,
      device.asset.brand,
      device.asset.model,
      device.latestFault,
    ]
      .join(' ')
      .normalize('NFKC')
      .toLocaleLowerCase();
    if (term && !searchable.includes(term)) continue;
    const key = `${device.asset.building} · ${kind}`;
    groups.set(key, [...(groups.get(key) || []), device]);
    deviceCount++;
    recordCount += records;
  }
  return {
    groups: [...groups].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')),
    deviceCount,
    recordCount,
  };
}
