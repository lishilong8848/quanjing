import { ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import {
  mapLedgerRecords,
  summarizeLedger,
} from '../../server/modules/equipment-lifecycle/equipment-ledger.model';
import {
  ledgerAccessBuilding,
  scopeLedgerDashboard,
  scopeLedgerQuery,
  scopeLedgerLifecycle,
  scopedLedgerSnapshotId,
} from '../../server/modules/equipment-lifecycle/equipment-ledger-access';

const assets = mapLedgerRecords(
  ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].map((building, i) => ({
    record_id: `asset-${i}`,
    fields: {
      机楼: building,
      设备名称: `设备-${building}`,
      大设备类型: `种类-${building}`,
      品牌: `品牌-${building}`,
      型号: `型号-${building}`,
    },
  })),
  '2026-10-01',
);
const dashboard = {
  snapshotId: 'snapshot',
  updatedAt: '2026-10-01T00:00:00Z',
  asOf: '2026-10-01',
  stale: false,
  overview: summarizeLedger(assets),
  buildings: assets.map((a) => summarizeLedger(assets, a.building)),
};

describe('equipment ledger building access', () => {
  it.each(['admin', 'editor'] as const)(
    '%s retains the global scope',
    (role) => {
      expect(ledgerAccessBuilding({ role, purchaseBuilding: null })).toBeNull();
      expect(scopeLedgerDashboard(dashboard, null)).toBe(dashboard);
      expect(scopeLedgerQuery({ building: 'E楼' }, null)).toEqual({
        building: 'E楼',
      });
    },
  );
  it.each(['A楼', 'B楼', 'C楼', 'D楼', 'E楼'] as const)(
    '%s supervisor receives only own metrics, distributions and rows',
    (purchaseBuilding) => {
      const building = ledgerAccessBuilding({
        role: 'building_admin',
        purchaseBuilding,
      });
      const scoped = scopeLedgerDashboard(dashboard, building);
      expect(scoped.overview.metrics.total).toBe(1);
      expect(scoped.overview.building).toBe(purchaseBuilding);
      expect(scoped.buildings.map((b) => b.building)).toEqual([
        purchaseBuilding,
      ]);
      expect(scoped.overview.brands).toEqual([
        { name: `品牌-${purchaseBuilding}`, count: 1 },
      ]);
      expect(scoped.snapshotId).toBe(
        scopedLedgerSnapshotId('snapshot', building),
      );
      expect(
        scopeLedgerQuery({ id: 'foreign-id', search: '型号' }, building),
      ).toEqual({ id: 'foreign-id', search: '型号', building });
      expect(() => scopeLedgerQuery({ building: '全局' }, building)).toThrow(
        ForbiddenException,
      );
      expect(dashboard.overview.metrics.total).toBe(5);
    },
  );
  it.each([
    undefined,
    { role: 'guest', purchaseBuilding: null },
    { role: 'inventory_admin', purchaseBuilding: 'A楼' },
    { role: 'purchase_admin', purchaseBuilding: null },
    { role: 'building_admin', purchaseBuilding: null },
    { role: 'building_admin', purchaseBuilding: '110站' },
    { role: 'building_admin', purchaseBuilding: 'H楼' },
  ])(
    'fails closed for an unavailable or unauthorized principal %#',
    (principal) => {
      expect(() => ledgerAccessBuilding(principal as AccessPrincipal)).toThrow(
        ForbiddenException,
      );
    },
  );
  it('never falls back to global metrics for a missing building', () => {
    const scoped = scopeLedgerDashboard({ ...dashboard, buildings: [] }, 'A楼');
    expect(scoped.overview.metrics.total).toBe(0);
    expect(scoped.overview.brands).toEqual([]);
    expect(scoped.buildings).toEqual([]);
  });
  it('scopes all lifecycle sections including related contracts and does not mutate the shared cache', () => {
    const rows = ['A楼', 'B楼', ''].map((building, i) => ({
      id: `r-${i}`,
      building,
      name: building,
      status: '',
      dueDate: null,
    }));
    const view = {
      status: 'fresh' as const,
      assets: rows,
      longTermMaintenance: rows,
      keyParts: rows,
      maintenanceContracts: rows,
    };
    const scoped = scopeLedgerLifecycle(view, 'A楼');
    for (const key of [
      'assets',
      'longTermMaintenance',
      'keyParts',
      'maintenanceContracts',
    ] as const)
      expect(scoped[key].map((r) => r.building)).toEqual(['A楼']);
    expect(view.assets).toHaveLength(3);
    expect(scopeLedgerLifecycle(view, null)).toBe(view);
  });
});
