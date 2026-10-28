import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { BusinessModule } from '../../shared/business-permissions';
import type { ThresholdRecord } from '../../shared/threshold-management.interface';
import { assertGlobalBusinessOperation } from '../../server/common/access/global-business-operation';
import { ContractManagementController } from '../../server/modules/contract-management/contract-management.controller';
import { InventoryManagementController } from '../../server/modules/inventory-management/inventory-management.controller';
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';
import { assertStorageLocationCreateScope } from '../../server/modules/inventory-management/inventory-access-policy';
import { ThresholdController } from '../../server/modules/threshold-management/threshold.controller';
import { ThresholdStore } from '../../server/modules/threshold-management/threshold.store';
import { ThresholdSyncService } from '../../server/modules/threshold-management/threshold-sync.service';

function notifier(module: BusinessModule, global: boolean): AccessPrincipal {
  return { role: 'guest', purchaseBuilding: null, effectiveAuthorization: { mode: 'independent',
    baseline: { nativeRole: null, pages: [], rules: [{ id: 'synthetic-notify', module, effect: 'allow', actions: ['notify'], buildings: global ? null : ['A楼'], specialties: null }] },
    overrides: { rules: [], allowPages: [], denyPages: [] },
  } };
}

describe('global jobs and shared storage retain real operation boundaries', () => {
  it.each(['contracts', 'inventory', 'purchase'] as const)('%s global notify cannot use a one-building or read-only grant', module => {
    expect(() => assertGlobalBusinessOperation(notifier(module, false), { module, action: 'notify' })).toThrow();
    expect(() => assertGlobalBusinessOperation(notifier(module, true), { module, action: 'notify' })).not.toThrow();
    const readOnly = notifier(module, true); readOnly.effectiveAuthorization!.baseline.rules[0].actions = ['read'];
    expect(() => assertGlobalBusinessOperation(readOnly, { module, action: 'notify' })).toThrow();
  });
  it('contract and inventory entrypoints reject before starting a global job', () => {
    for (const [module, Controller, code] of [
      ['contracts', ContractManagementController, 'payment_due_reminder'],
      ['inventory', InventoryManagementController, 'item_confirmation'],
    ] as const) {
      const run = jest.fn();
      const controller = Object.assign(Object.create(Controller.prototype), { workflowService: { run } });
      expect(() => controller.runWorkflow(code, { accessPrincipal: notifier(module, false) })).toThrow();
      expect(run).not.toHaveBeenCalled();
      controller.runWorkflow(code, { accessPrincipal: notifier(module, true) });
      expect(run).toHaveBeenCalledWith(code, { trigger: 'manual' });
    }
  });
  it('purchase rejects partial notify before obtaining a workflow session or sending reminders', async () => {
    const run = jest.fn(), getWorkflowSession = jest.fn(async () => ({}));
    const controller = Object.assign(Object.create(PurchaseInventoryController.prototype), { workflowScheduler: { run }, workflowService: { assertEnabled: jest.fn() }, getWorkflowSession });
    await expect(controller.runWorkflowReminder({ accessPrincipal: notifier('purchase', false) }, 'order')).rejects.toThrow();
    expect(getWorkflowSession).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    await controller.runWorkflowReminder({ accessPrincipal: notifier('purchase', true) }, 'order');
    expect(run).toHaveBeenCalledWith('order');
  });
  it('shared warehouse location creation requires create across all specialties of the actual building', () => {
    const principal = notifier('inventory', false);
    principal.effectiveAuthorization!.baseline.rules[0].actions = ['create'];
    const body = { building: 'A楼', category: '货架', name: '合成库位', clientMutationId: 'synthetic-location-001' } as Parameters<typeof assertStorageLocationCreateScope>[1];
    expect(assertStorageLocationCreateScope(principal, body)).toBe(body);
    expect(() => assertStorageLocationCreateScope(principal, { ...body, building: 'B楼' })).toThrow();
    principal.effectiveAuthorization!.baseline.rules[0].specialties = ['电气'];
    expect(() => assertStorageLocationCreateScope(principal, body)).toThrow();
    principal.effectiveAuthorization!.baseline.rules[0].specialties = null;
    principal.effectiveAuthorization!.baseline.rules[0].actions = ['read'];
    expect(() => assertStorageLocationCreateScope(principal, body)).toThrow();
  });
});

const seed: ThresholdRecord = { id: 'hvac-synthetic', profession: '暖通', device: '冷水机组', section: '告警', parameter: '负荷', building: 'A楼', location: '合成位置', value: '30%', range: '0-100%', unit: '%', kind: '设定', enabled: '', note: '', version: 1, updatedAt: '', source: { sheet: '合成设备', cell: 'F12', originalValue: '30%', parameterCell: 'A12' } };
const engineer = (building: 'A楼' | 'B楼'): AccessPrincipal => ({ role: 'professional_engineer', purchaseBuilding: building, buildings: [building], specialties: ['暖通'], accountId: 'synthetic-owner' });

describe('threshold sync authorizes original, current and fetched records before mutation', () => {
  let directory: string, ledgerPath: string, store: ThresholdStore;
  const mutation = 'synthetic-scope-update';
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nt-scoped-entry-')); ledgerPath = join(directory, 'ledger.json');
    store = new ThresholdStore(ledgerPath, [seed], [], true);
    store.mutate({ operation: 'update', clientMutationId: mutation, id: seed.id, expectedVersion: 1, record: { ...seed, value: '29%' } }, 'professional_engineer:synthetic-owner');
    store.finishSync(mutation, { state: 'error', error: '多维表记录已变化' });
  });
  afterEach(() => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('nt-scoped-entry-')) throw new Error('Unexpected synthetic test directory');
    rmSync(directory, { recursive: true, force: true });
  });
  it('does not expose an out-of-scope task or retry it even for the same actor', () => {
    const controller = new ThresholdController(store);
    const bytes = readFileSync(ledgerPath, 'utf8');
    const request = { accessPrincipal: engineer('B楼') } as never;
    expect(() => controller.status(mutation, request)).toThrow('超出');
    expect(() => controller.retry({ clientMutationId: mutation }, request)).toThrow('超出');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(bytes);
  });
  it('retains the original-record scope for a deletion with null result.record', () => {
    const other = new ThresholdStore(join(directory, 'delete.json'), [seed], [], true);
    const id = 'synthetic-scope-delete';
    other.mutate({ operation: 'delete', clientMutationId: id, id: seed.id, expectedVersion: 1 }, 'professional_engineer:synthetic-owner');
    other.finishSync(id, { state: 'error', error: 'synthetic unavailable' });
    const controller = new ThresholdController(other);
    expect(() => controller.status(id, { accessPrincipal: engineer('B楼') } as never)).toThrow('超出');
    expect(controller.status(id, { accessPrincipal: engineer('A楼') } as never)[0].record).toBeNull();
  });
  it('checks before the external read and rejects a returned cloud record that moved outside scope', async () => {
    const readRecord = jest.fn(async () => ({ ...seed, building: 'B楼', version: 3 }));
    const sync = new ThresholdSyncService(store, { readRecord } as never);
    const controller = new ThresholdController(store, sync);
    const bytes = readFileSync(ledgerPath, 'utf8');
    await expect(controller.acceptCloud({ clientMutationId: mutation }, { accessPrincipal: engineer('B楼') } as never)).rejects.toThrow('超出');
    expect(readRecord).not.toHaveBeenCalled();
    await expect(controller.acceptCloud({ clientMutationId: mutation }, { accessPrincipal: engineer('A楼') } as never)).rejects.toThrow('超出');
    expect(readRecord).toHaveBeenCalledTimes(1); expect(readFileSync(ledgerPath, 'utf8')).toBe(bytes);
  });
  it('rechecks the same mutation inside the store write and preserves the actor ownership gate', () => {
    const check = jest.fn(() => { throw new Error('synthetic revoked scope'); });
    const bytes = readFileSync(ledgerPath, 'utf8');
    expect(() => store.retrySync(mutation, 'professional_engineer:synthetic-owner', check)).toThrow('synthetic revoked');
    expect(check).toHaveBeenCalledTimes(1);
    expect(() => store.retrySync(mutation, 'professional_engineer:other', () => undefined)).toThrow('无权');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(bytes);
  });
});
