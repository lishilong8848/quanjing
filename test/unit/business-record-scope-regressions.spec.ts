import type { AccessPrincipal } from '../../shared/access-control.interface';
import { ThresholdController } from '../../server/modules/threshold-management/threshold.controller';
import { EquipmentLedgerService } from '../../server/modules/equipment-lifecycle/equipment-ledger.service';
import { EquipmentLifecycleService } from '../../server/modules/equipment-lifecycle/equipment-lifecycle.service';
import { ledgerAccessBuilding } from '../../server/modules/equipment-lifecycle/equipment-ledger-access';
import { mapLedgerRecords, summarizeLedger } from '../../server/modules/equipment-lifecycle/equipment-ledger.model';

function principal(module: 'thresholds' | 'equipment_ledger' | 'equipment_lifecycle', additional = 'B楼'): AccessPrincipal {
  return { role: 'professional_engineer', purchaseBuilding: 'A楼', buildings: ['A楼'], specialties: ['电气'], accountId: 'feishu-synthetic', authorizationVersion: 1,
    permissionContext: { module, action: 'read' }, personalRules: [
      { id: 'synthetic-extra', module, effect: 'allow', actions: ['read'], buildings: [additional as 'B楼'], specialties: ['电气'] },
      { id: 'synthetic-deny-home', module, effect: 'deny', actions: ['read'], buildings: ['A楼'], specialties: ['电气'] },
    ] };
}
const records = ['A楼', 'B楼', 'C楼'].map((building, i) => ({ record_id: `recAsset${i}`, fields: { 机楼: building, 楼栋: building, 设备名称: `设备${i}`, 专业: '电气' } }));

it('threshold results keep explicit cross-building read permission and still enforce deny', () => {
  const rows = records.map((record, i) => ({ id: record.record_id, building: record.fields.楼栋, profession: '电气', marker: i }));
  const controller = new ThresholdController({ list: () => ({ records: rows }) } as never);
  const response = controller.list({ accessPrincipal: principal('thresholds') } as never);
  expect(response.records.map(row => row.building)).toEqual(['B楼']);
});

it('equipment source filtering remains authoritative after the controller removes its single-building prefilter', () => {
  const service = new EquipmentLedgerService({} as never, {} as never);
  const assets = mapLedgerRecords(records, '2026-10-27').map(asset => ({ ...asset, specialty: '电气' }));
  const snapshot = { assets, dashboard: { snapshotId: 'synthetic-snapshot', overview: summarizeLedger(assets), buildings: [] } };
  const scope = (value: AccessPrincipal) => (service as unknown as { scope(snapshot: unknown, principal: AccessPrincipal): typeof snapshot }).scope(snapshot, value);
  const first = principal('equipment_ledger'), second = principal('equipment_ledger', 'C楼');
  expect(ledgerAccessBuilding(first, true)).toBeNull();
  expect(scope(first).assets.map(asset => asset.building)).toEqual(['B楼']);
  expect(scope(second).assets.map(asset => asset.building)).toEqual(['C楼']);
  expect(scope(first).dashboard.snapshotId).not.toBe(scope(second).dashboard.snapshotId);
});

it('lifecycle filters use its own module and do not strip allowed cross-building records', async () => {
  const service = new EquipmentLifecycleService({} as never);
  jest.spyOn(service as unknown as { loadTable: (...args: unknown[]) => Promise<unknown> }, 'loadTable').mockResolvedValue({ records, status: 'fresh' });
  const dashboard = await service.getDashboard(false, undefined, principal('equipment_lifecycle'));
  expect(dashboard.assets.map(asset => asset.building)).toEqual(['B楼']);
  expect(dashboard.sourceTables.every(source => source.recordCount === 1)).toBe(true);
});
