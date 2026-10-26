import type { EquipmentHistoryDevice } from '../../shared/equipment-history.interface';
import { mapLedgerRecords } from '../../server/modules/equipment-lifecycle/equipment-ledger.model';
import {
  formatRepairFaultDate,
  getRepairDevicePage,
  getRepairDeviceView,
} from '../../client/src/pages/EquipmentLedgerManagement/repair-device-view';

const assets = mapLedgerRecords(
  [
    {
      record_id: 'pump',
      fields: {
        编号: 'asset-1',
        设备编号: 'C-127-CWP-2',
        设备名称: '冷却水泵',
        机楼: 'C楼',
        品牌: '格兰富',
        型号: 'TP-100',
      },
    },
    {
      record_id: 'power',
      fields: {
        编号: 'asset-2',
        设备编号: 'E-417-HVDC-222',
        设备名称: 'HVDC',
        机楼: 'E楼',
        品牌: '华为',
        型号: 'P-200',
      },
    },
  ],
  '2026-10-03',
);
const devices: EquipmentHistoryDevice[] = [
  {
    asset: assets[0],
    count: 3,
    completed: 2,
    pending: 1,
    lastFaultAt: null,
    latestFault: '冷却泵压差偏大',
  },
  {
    asset: assets[1],
    count: 1,
    completed: 1,
    pending: 0,
    lastFaultAt: null,
    latestFault: '系统故障告警',
  },
];
const filters = { floor: '', family: '', status: 'all' as const, search: '' };

describe('repair device view', () => {
  it('paginates the full filtered groups without losing or repeating devices', () => {
    const rows = Array.from({ length: 58 }, (_, index) => ({
      ...devices[index % 2],
      asset: { ...devices[index % 2].asset, id: `device-${index}` },
    }));
    const view = getRepairDeviceView(rows, filters);
    const before = JSON.stringify(view);
    const pages = [1, 2, 3].map((page) =>
      getRepairDevicePage(view.groups, page),
    );
    const ids = pages.flatMap((page) =>
      page.groups.flatMap(([, entries]) =>
        entries.map((device) => device.asset.id),
      ),
    );
    expect(
      pages.map((page) =>
        page.groups.reduce((sum, [, entries]) => sum + entries.length, 0),
      ),
    ).toEqual([20, 20, 18]);
    expect(ids).toEqual(
      view.groups.flatMap(([, entries]) =>
        entries.map((device) => device.asset.id),
      ),
    );
    expect(new Set(ids).size).toBe(58);
    expect(JSON.stringify(view)).toBe(before);
    expect(view.deviceCount).toBe(58);
    expect(pages[0].pageCount).toBe(3);
  });

  it('shows fault dates in Shanghai time and keeps missing or invalid dates explicit', () => {
    expect(formatRepairFaultDate('2026-10-02T18:30:00Z')).toBe('2026-10-03');
    expect(formatRepairFaultDate('2026-04-05')).toBe('2026-04-05');
    expect(formatRepairFaultDate(null)).toBe('—');
    expect(formatRepairFaultDate('invalid')).toBe('—');
  });

  it('keeps fuzzy search global before paging and clamps stale page numbers', () => {
    const view = getRepairDeviceView(devices, { ...filters, search: 'E-417' });
    const page = getRepairDevicePage(view.groups, 9);
    expect(page.page).toBe(1);
    expect(page.groups[0][1][0].asset.id).toBe('power');
    expect(view.recordCount).toBe(1);
    expect(getRepairDevicePage([], 9)).toEqual({
      groups: [],
      page: 1,
      pageCount: 1,
    });
  });
  it('counts devices separately from repeated repair records', () => {
    expect(getRepairDeviceView(devices, filters)).toMatchObject({
      deviceCount: 2,
      recordCount: 4,
    });
    expect(
      getRepairDeviceView(devices, { ...filters, status: 'completed' }),
    ).toMatchObject({ deviceCount: 2, recordCount: 3 });
    expect(
      getRepairDeviceView(devices, { ...filters, status: 'pending' }),
    ).toMatchObject({ deviceCount: 1, recordCount: 1 });
  });
  it('combines floor, family and status without exposing a different floor', () => {
    const view = getRepairDeviceView(devices, {
      ...filters,
      floor: 'E楼',
      family: 'HVDC',
      status: 'completed',
    });
    expect(view).toMatchObject({ deviceCount: 1, recordCount: 1 });
    expect(view.groups.map(([key]) => key)).toEqual(['E楼 · HVDC']);
    expect(
      getRepairDeviceView(devices, {
        ...filters,
        floor: 'E楼',
        status: 'pending',
      }).deviceCount,
    ).toBe(0);
  });
  it.each([
    'c-127-cwp',
    'Ｃ－１２７－ＣＷＰ',
    'asset-1',
    '格兰富',
    'tp-100',
    '压差',
  ])('supports fuzzy search for %s', (search) => {
    const view = getRepairDeviceView(devices, { ...filters, search });
    expect(view.deviceCount).toBe(1);
    expect(view.groups[0][1][0].asset.id).toBe('pump');
  });
  it('has explicit zero results and leaves the source unchanged', () => {
    const before = JSON.stringify(devices);
    expect(
      getRepairDeviceView(devices, { ...filters, search: '不存在的设备' }),
    ).toEqual({ groups: [], deviceCount: 0, recordCount: 0 });
    expect(JSON.stringify(devices)).toBe(before);
  });
});
