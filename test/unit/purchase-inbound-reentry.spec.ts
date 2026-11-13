jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn(async (_http: unknown, options: { appToken?: string }) => options.appToken),
  fetchBitableRecords: jest.fn(),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { InventoryInboundTaskStatusResponse, PurchaseInboundConfirmRequest } from '../../shared/inventory-management.interface';
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
import { InventoryInboundTaskLedgerStore } from '../../server/modules/inventory-management/inventory-inbound-task-ledger.store';
import { InventoryInboundTaskService } from '../../server/modules/inventory-management/inventory-inbound-task.service';
import { InventoryMovementCommandService } from '../../server/modules/inventory-management/inventory-movement-command.service';
import { InventoryMovementDeletionService } from '../../server/modules/inventory-management/inventory-movement-deletion.service';
import { InventoryMovementDeletionTaskLedgerStore } from '../../server/modules/inventory-management/inventory-movement-deletion-task-ledger.store';
import { InventoryMovementOperationCoordinator } from '../../server/modules/inventory-management/inventory-movement-operation-coordinator';
import { PurchaseInboundConfirmationService } from '../../server/modules/inventory-management/purchase-inbound-confirmation.service';

const ADMIN: AccessPrincipal = { role: 'admin', purchaseBuilding: null };
const FINGERPRINT = 'isolated-purchase-inbound-user';
const EXECUTION_ID = 'execution-reentry';
const TABLES = { purchase: 'tblPurchase', submission: 'tblSubmission', catalog: 'tblCatalog', inventory: 'tblInventory', inbound: 'tblInbound' };
const ENVIRONMENT = {
  FEISHU_PURCHASE_INVENTORY_APP_TOKEN: 'appPurchase',
  FEISHU_PURCHASE_SUBMISSION_TABLE_ID: TABLES.submission,
  FEISHU_PURCHASE_EXECUTION_TABLE_ID: TABLES.purchase,
  FEISHU_WAREHOUSE_APP_TOKEN: 'appWarehouse',
  FEISHU_WAREHOUSE_CATALOG_TABLE_ID: TABLES.catalog,
  FEISHU_WAREHOUSE_INVENTORY_TABLE_ID: TABLES.inventory,
  FEISHU_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME: '存放位置',
  FEISHU_WAREHOUSE_INBOUND_TABLE_ID: TABLES.inbound,
  FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID: 'tblOutbound',
};

type Row = { record_id: string; fields: Record<string, unknown> };

describe('purchase inbound re-entry after a confirmed deletion', () => {
  it('recreates a deleted purchase inbound with a new receipt and preserves inventory and idempotency', async () => {
    const previous = Object.fromEntries(Object.keys(ENVIRONMENT).map((key) => [key, process.env[key]]));
    Object.assign(process.env, ENVIRONMENT);
    const directory = mkdtempSync(join(tmpdir(), 'purchase-inbound-reentry-'));
    const execution: Row = { record_id: EXECUTION_ID, fields: {
      采购编码: 'CG-REENTRY', 申请楼栋: 'A楼', 实际采购数量: 5, 是否已入库: false,
      采购流程: '到货已签收（待入库）', 程序采购状态: '物品签收（待入库）',
    } };
    const rows: Record<string, Row[]> = {
      [TABLES.purchase]: [execution], [TABLES.submission]: [], [TABLES.catalog]: [],
      [TABLES.inventory]: [], [TABLES.inbound]: [],
    };
    let nextRecord = 0;
    const read = (table: string, id: string) => rows[table]?.find((row) => row.record_id === id);
    const list = ({ tableId }: { tableId: string }) => structuredClone(rows[tableId] || []);
    const gateway = {
      listRecords: jest.fn(async (options) => list(options)),
      searchRecords: jest.fn(async (options) => list(options)),
      getRecord: jest.fn(async (_app: string, table: string, id: string) => {
        const row = read(table, id);
        if (!row) throw new Error('Unexpected fixture row lookup');
        return structuredClone(row);
      }),
      tryGetRecord: jest.fn(async (_app: string, table: string, id: string) => structuredClone(read(table, id))),
      createRecord: jest.fn(async (_app: string, table: string, fields: Row['fields']) => {
        const id = `${table}-${++nextRecord}`;
        rows[table].push({ record_id: id, fields: structuredClone(fields) });
        return id;
      }),
      updateRecord: jest.fn(async (_app: string, table: string, id: string, fields: Row['fields']) => {
        const row = read(table, id);
        if (!row) throw new Error('Unexpected fixture row update');
        Object.assign(row.fields, fields);
      }),
      deleteRecordAndConfirmAbsent: jest.fn(async (_app: string, table: string, id: string) => {
        rows[table] = rows[table].filter((row) => row.record_id !== id);
      }),
      invalidateRecordsCache: jest.fn(),
      ensureTextField: jest.fn(), ensureNumberField: jest.fn(),
      getFieldSchemas: jest.fn(async (_app: string, table: string) => {
        const fields: Record<string, number> = table === TABLES.purchase
          ? { 物品类别码: 1, 实际采购数量: 2, 是否已入库: 7, 采购流程: 3, 程序采购状态: 1 }
          : table === TABLES.inventory ? { 存放位置: 3 } : {};
        return Object.entries(fields).map(([fieldName, type]) => ({ fieldName, type, writable: true }));
      }),
    };
    (fetchBitableRecords as jest.Mock).mockImplementation(async (_http, options) => list(options));
    const cache = { invalidateCache: jest.fn() };
    const workflows = { enqueueCompletionNotifications: jest.fn().mockResolvedValue(0) };
    const storage = { resolveSelectedLocation: jest.fn().mockResolvedValue({ recordId: 'location-1', name: 'A-01' }) };
    const http = { axiosRef: {} } as never;
    const coordinator = new InventoryMovementOperationCoordinator();
    const deletionLedger = new InventoryMovementDeletionTaskLedgerStore(join(directory, 'deletion.json'));
    const inboundLedger = new InventoryInboundTaskLedgerStore(join(directory, 'inbound.json'));
    const command = new InventoryMovementCommandService(http, gateway as never, cache as never);
    const purchase = new PurchaseInboundConfirmationService(http, gateway as never, workflows as never,
      command, storage as never, coordinator, inboundLedger, deletionLedger);
    const deletion = new InventoryMovementDeletionService(http, gateway as never, cache as never,
      deletionLedger, coordinator, {}, cache as never);
    const inbound = new InventoryInboundTaskService(inboundLedger, command, purchase, workflows as never,
      storage as never, {}, undefined, undefined, deletionLedger);
    try {
      const preparation = { executionRecordId: EXECUTION_ID, building: 'A楼' as const,
        clientMutationId: 'purchase-reentry-original', quantity: 5, occurredAt: '2026-11-13T01:00:00Z',
        newItem: { primaryCategory: '设备', secondaryCategory: '传感器 A2', name: '测试传感器',
          specification: 'S-100', location: 'A-01', locationRecordId: 'location-1' } };
      const prepared = await purchase.prepareCategory(preparation, ADMIN);
      const original: PurchaseInboundConfirmRequest = { ...preparation, mode: 'new',
        preparedCatalogRecordId: prepared.catalogRecordId, generatedSku: prepared.sku };
      const originalTask = await inbound.acceptPurchase(original, ADMIN, FINGERPRINT);
      const first = await waitForTask(inbound, originalTask.taskId);
      expect(first.task).toMatchObject({ status: 'completed', result: { success: true } });
      const oldRecord = rows[TABLES.inbound][0].record_id;
      expect(rows[TABLES.inbound][0].fields.入库数量).toBe(5);
      expect(execution.fields.是否已入库).toBe(true);

      const remove = await deletion.accept({ clientMutationId: 'purchase-reentry-delete', movementType: 'inbound', recordId: oldRecord }, ADMIN, FINGERPRINT);
      await until(async () => (await deletionLedger.findByTaskId(remove.taskId))?.task.status === 'completed');
      expect(rows[TABLES.inbound]).toHaveLength(0);
      expect(execution.fields).toMatchObject({ 是否已入库: false, 采购流程: '到货已签收（待入库）' });
      expect((await purchase.listPending(true)).items[0]).toMatchObject({
        reopenedAfterDeletion: true, inboundRollbackRecordId: oldRecord, quantity: 5,
      });

      const stale = { httpStatus: 409, details: 'PURCHASE_INBOUND_ROLLED_BACK' };
      await expect(inbound.getTaskStatus(originalTask.taskId, ADMIN)).rejects.toMatchObject(stale);
      await expect(inbound.acceptPurchase(original, ADMIN, FINGERPRINT)).rejects.toMatchObject(stale);
      expect(rows[TABLES.inbound]).toHaveLength(0);

      const tooLarge = await inbound.acceptPurchase({ ...original, clientMutationId: 'purchase-reentry-too-large', quantity: 6 }, ADMIN, FINGERPRINT);
      expect((await waitForTask(inbound, tooLarge.taskId)).task).toMatchObject({ status: 'failed', message: expect.stringContaining('不能超过') });
      expect(rows[TABLES.inbound]).toHaveLength(0);

      const reopened: PurchaseInboundConfirmRequest = { ...original, clientMutationId: 'purchase-reentry-new-receipt',
        quantity: 4, occurredAt: '2026-11-13T03:00:00Z' };
      const [secondTask, duplicate] = await Promise.all([
        inbound.acceptPurchase(reopened, ADMIN, FINGERPRINT), inbound.acceptPurchase(reopened, ADMIN, FINGERPRINT),
      ]);
      expect(secondTask.taskId).toBe(duplicate.taskId);
      const second = await waitForTask(inbound, secondTask.taskId);
      expect(second.task).toMatchObject({ status: 'completed', result: { success: true, alreadyProcessed: false } });
      expect(rows[TABLES.inbound]).toHaveLength(1);
      expect(rows[TABLES.inbound][0].record_id).not.toBe(oldRecord);
      expect(rows[TABLES.inbound][0].fields).toMatchObject({ 入库数量: 4, 入库来源: `采购:${EXECUTION_ID}` });
      expect(rows[TABLES.catalog]).toHaveLength(1);
      expect(rows[TABLES.inventory]).toHaveLength(1);
      expect(rows[TABLES.inventory][0].fields.初始化库存数量).toBe(0);
      expect(execution.fields).toMatchObject({ 是否已入库: true, 实际采购数量: 4, 采购流程: '采购完成（已入库）' });
      expect(await purchase.confirm(reopened, ADMIN, async () => undefined)).toMatchObject({ alreadyProcessed: true, inboundRecordId: rows[TABLES.inbound][0].record_id });
      expect(gateway.createRecord.mock.calls.filter(([, table]) => table === TABLES.inbound)).toHaveLength(2);

      const secondRecord = rows[TABLES.inbound][0].record_id;
      const secondRemoval = await deletion.accept({ clientMutationId: 'purchase-reentry-delete-second', movementType: 'inbound', recordId: secondRecord }, ADMIN, FINGERPRINT);
      await until(async () => (await deletionLedger.findByTaskId(secondRemoval.taskId))?.task.status === 'completed');
      expect((await purchase.listPending(true)).items[0]).toMatchObject({ inboundRollbackRecordId: secondRecord });
      await expect(inbound.getTaskStatus(secondTask.taskId, ADMIN)).rejects.toMatchObject(stale);
      const existing = await inbound.acceptPurchase({ executionRecordId: EXECUTION_ID, mode: 'existing', building: 'A楼',
        catalogRecordId: prepared.catalogRecordId, sku: prepared.sku, clientMutationId: 'purchase-reentry-existing-receipt',
        quantity: 4, occurredAt: '2026-11-13T04:00:00Z' }, ADMIN, FINGERPRINT);
      expect((await waitForTask(inbound, existing.taskId)).task).toMatchObject({ status: 'completed' });
      expect(rows[TABLES.inbound]).toHaveLength(1);
      expect(rows[TABLES.inbound][0].record_id).not.toBe(secondRecord);
      expect(rows[TABLES.inventory]).toHaveLength(1);
    } finally {
      await Promise.all([deletion.onModuleDestroy(), inbound.onModuleDestroy()]);
      rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

async function until(read: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Isolated inbound task did not settle');
}

async function waitForTask(service: InventoryInboundTaskService, id: string) {
  let result!: InventoryInboundTaskStatusResponse;
  await until(async () => {
    result = await service.getTaskStatus(id, ADMIN);
    return result.task.status === 'completed' || result.task.status === 'failed';
  });
  return result;
}
