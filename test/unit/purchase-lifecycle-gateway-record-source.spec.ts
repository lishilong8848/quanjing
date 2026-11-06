import { PurchaseLifecycleGatewayRecordSource } from '../../server/modules/purchase-inventory/purchase-lifecycle-gateway-record-source';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

describe('purchase lifecycle direct source readback', () => {
  const identity = { appId: 'cli_test', batchId: 'purchase-batch-1', recipientOpenId: 'ou_person' };
  let record: PurchaseWorkflowRecord, batch: any, appId: string, now: number;
  const store = { findManagerApprovalBatch: jest.fn() };
  const gateway = { getLifecycleExecutionRecordsAsApp: jest.fn(), prepareManagerComparisonBatchEvidence: jest.fn() };
  const make = () => new PurchaseLifecycleGatewayRecordSource(store, gateway, () => appId, () => now);
  beforeEach(() => {
    appId = identity.appId; now = Date.UTC(2026, 10, 4);
    record = { recordId: 'rec1', status: '未开始（待审批）', building: 'A楼', procurementForm: '三方比价' } as PurchaseWorkflowRecord;
    batch = { approvalBatchId: identity.batchId, flowVersion: 'lifecycle_v1', recordIds: ['rec1'], revision: 1 };
    store.findManagerApprovalBatch.mockReset().mockImplementation(async () => structuredClone(batch));
    gateway.getLifecycleExecutionRecordsAsApp.mockReset().mockImplementation(async () => [structuredClone(record)]);
    gateway.prepareManagerComparisonBatchEvidence.mockReset().mockImplementation(async () => [{ recordId: 'rec1', recordUrl: 'https://safe.example', attachments: [1, 2, 3].map(i => ({ disposition: 'preview', imageKey: `img_${i}`, name: `图${i}` })) }]);
  });

  it('does not prepare comparison media for a recipient without explicit access', async () => {
    const source = make(), snapshot = await source.load(identity, () => false);
    expect(snapshot.comparisonImages).toEqual({});
    expect(gateway.prepareManagerComparisonBatchEvidence).not.toHaveBeenCalled();
    expect(source.isLocallyValid(snapshot.version)).toBe(true);
    expect(await source.verifyLatest(snapshot.version)).toBe(true);
    expect(gateway.getLifecycleExecutionRecordsAsApp).toHaveBeenCalledTimes(2);
  });

  it('checks the persistent source before reads and stops before preparing media if it changes during the read', async () => {
    const sourceGuard=jest.fn(async()=>{});
    const source=new PurchaseLifecycleGatewayRecordSource(store,gateway,()=>appId,()=>now,sourceGuard);
    sourceGuard.mockRejectedValueOnce(new Error('source mismatch'));
    await expect(source.load(identity,()=>true)).rejects.toThrow('source mismatch');
    expect(gateway.getLifecycleExecutionRecordsAsApp).not.toHaveBeenCalled();
    gateway.getLifecycleExecutionRecordsAsApp.mockImplementationOnce(async()=>{sourceGuard.mockRejectedValue(new Error('source changed'));return [record];});
    await expect(source.load(identity,()=>true)).rejects.toThrow('source changed');
    expect(gateway.prepareManagerComparisonBatchEvidence).not.toHaveBeenCalled();
  });

  it('rechecks permitted comparison evidence and rejects changed record or batch', async () => {
    const source = make(), snapshot = await source.load(identity, () => true);
    expect(snapshot.comparisonImages.rec1).toHaveLength(3);
    expect(await source.verifyLatest(snapshot.version)).toBe(true);
    record = { ...record, status: '审批通过（待下单）' };
    expect(await source.verifyLatest(snapshot.version)).toBe(false);
    record = { ...record, status: '未开始（待审批）' };
    batch.revision += 1;
    expect(await source.verifyLatest(snapshot.version)).toBe(false);
  });
  it('withdraws local proof immediately after a same-app source switch, including after successful remote verification',async()=>{
    let fingerprint='a'.repeat(64);
    const source=new PurchaseLifecycleGatewayRecordSource(store,gateway,()=>appId,()=>now,async()=>{},()=>fingerprint);
    const loaded=await source.load(identity,()=>false);
    expect(await source.verifyLatest(loaded.version)).toBe(true);
    fingerprint='b'.repeat(64);
    expect(source.isLocallyValid(loaded.version)).toBe(false);expect(await source.verifyLatest(loaded.version)).toBe(false);
    fingerprint='invalid';expect(source.isLocallyValid(loaded.version)).toBe(false);
    await expect(source.load(identity,()=>false)).rejects.toThrow();
  });

  it('never silently drops original-only or missing comparison attachments', async () => {
    gateway.prepareManagerComparisonBatchEvidence.mockResolvedValueOnce([{ recordId: 'rec1', recordUrl: 'https://safe.example', attachments: [{ disposition: 'original', name: '报价' }] }]);
    await expect(make().load(identity, () => true)).rejects.toThrow('采购卡片数据来源无法核对');
    expect(gateway.getLifecycleExecutionRecordsAsApp).toHaveBeenCalled();
  });

  it('preserves original-only comparison entries for an authorized secure attachment link', async () => {
    gateway.prepareManagerComparisonBatchEvidence.mockResolvedValueOnce([{ recordId: 'rec1', recordUrl: 'https://safe.example', attachments: [1, 2, 3].map(i => ({ disposition: 'original', name: `报价${i}.pdf` })) }]);
    const snapshot = await make().load(identity, () => true);
    expect(snapshot.comparisonCounts.rec1).toBe(3);
    expect(snapshot.comparisonImages.rec1).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('file_token');
  });

  it('fails closed on missing or mismatched records, app changes, stale snapshots, and invalid selectors', async () => {
    gateway.getLifecycleExecutionRecordsAsApp.mockResolvedValueOnce([{ ...record, recordId: 'other' }]);
    await expect(make().load(identity, () => false)).rejects.toThrow();
    const source = make(), snapshot = await source.load(identity, () => false);
    appId = 'cli_other';
    expect(source.isLocallyValid(snapshot.version)).toBe(false);
    expect(await source.verifyLatest(snapshot.version)).toBe(false);
    appId = identity.appId; now += 180_000;
    expect(source.isLocallyValid(snapshot.version)).toBe(false);
    await expect(source.load(identity, (() => Promise.resolve(true)) as unknown as () => boolean)).rejects.toThrow();
  });

  it('maps out-of-order batch reads by ID and rejects missing or duplicate results', async () => {
    batch.recordIds = ['rec1', 'rec2'];
    const second = { ...record, recordId: 'rec2' };
    gateway.getLifecycleExecutionRecordsAsApp.mockResolvedValueOnce([second, record]);
    const source = make();
    expect((await source.load(identity, () => false)).records.map(row => row.recordId)).toEqual(['rec1', 'rec2']);
    gateway.getLifecycleExecutionRecordsAsApp.mockResolvedValueOnce([record]);
    await expect(make().load(identity, () => false)).rejects.toThrow();
    gateway.getLifecycleExecutionRecordsAsApp.mockResolvedValueOnce([record, record]);
    await expect(make().load(identity, () => false)).rejects.toThrow();
  });
});
