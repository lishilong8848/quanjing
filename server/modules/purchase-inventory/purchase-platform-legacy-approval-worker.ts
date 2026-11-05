import { createHash } from 'node:crypto';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';
import type { PlatformLegacyApprovalEntry } from './purchase-workflow.store';

export interface PlatformLegacyApprovalWorkerStore {
  leasePlatformLegacyApproval(eventId: string): Promise<{ entry: PlatformLegacyApprovalEntry; token: string; kind: 'dispatch' | 'reconcile' | 'complete' | 'done' } | null>;
  beginPlatformLegacyApprovalDispatch(eventId: string, token: string, record: PurchaseWorkflowRecord, markerFieldVerified: boolean): Promise<Record<string, string>>;
  confirmPlatformLegacyApproval(eventId: string, token: string, record: PurchaseWorkflowRecord, markerPresent: boolean): Promise<void>;
  markPlatformLegacyApprovalManual(eventId: string, token: string): Promise<void>;
  completePlatformLegacyApproval(eventId: string, token: string): Promise<void>;
}
export interface PlatformLegacyApprovalWorkerGateway {
  verifyMarker(sourceFingerprint: string): Promise<void>;
  readSnapshot(recordId: string, sourceFingerprint: string): Promise<{ record: PurchaseWorkflowRecord; markerPresent: boolean }>;
  writeDecision(recordId: string, fields: Record<string, string>, sourceFingerprint: string): Promise<void>;
}
function sourceFingerprint(record: PurchaseWorkflowRecord, markerPresent: boolean): string {
  return createHash('sha256').update(JSON.stringify([record.recordId,record.status,record.approvalCompleted,record.purchaseMethod,record.requesterOpenId,record.approvalBatchId || '',record.approvalActionId || '',record.building,record.specialty || '',markerPresent])).digest('hex');
}
/** Isolated worker, intentionally not registered. All operations on store are
 * durable ledger transactions; a dispatched result is never sent a second time. */
export function createPlatformLegacyApprovalWorker(store: PlatformLegacyApprovalWorkerStore, gateway: PlatformLegacyApprovalWorkerGateway) {
  return { async run(eventId: string): Promise<'completed' | 'busy' | 'manual_reconciliation'> {
    if (!/^platform_[A-Za-z0-9_-]{16,64}$/.test(eventId)) throw new Error('平台采购审批任务无效');
    const job = await store.leasePlatformLegacyApproval(eventId);
    if (!job) return 'busy';
    if (job.entry.eventId !== eventId || !/^rec[A-Za-z0-9_-]+$/.test(job.entry.recordId) || !/^[a-f0-9]{64}$/.test(job.entry.sourceFingerprint)) throw new Error('平台采购审批任务身份不可核对');
    if (job.kind === 'done') return 'completed';
    if (job.kind === 'complete') { await store.completePlatformLegacyApproval(eventId,job.token); return 'completed'; }
    if (job.kind === 'reconcile') {
      try {
        const current = await gateway.readSnapshot(job.entry.recordId,job.entry.sourceFingerprint);
        await store.confirmPlatformLegacyApproval(eventId,job.token,current.record,current.markerPresent);
        await store.completePlatformLegacyApproval(eventId,job.token);
        return 'completed';
      } catch { try { await store.markPlatformLegacyApprovalManual(eventId,job.token); } catch { /* durable fence remains */ } return 'manual_reconciliation'; }
    }
    let first: Awaited<ReturnType<PlatformLegacyApprovalWorkerGateway['readSnapshot']>>;
    try {
      await gateway.verifyMarker(job.entry.sourceFingerprint);
      first = await gateway.readSnapshot(job.entry.recordId,job.entry.sourceFingerprint);
      if (!first.markerPresent) return 'busy';
    } catch { return 'busy'; }
    const expected = sourceFingerprint(first.record,first.markerPresent);
    const patch = await store.beginPlatformLegacyApprovalDispatch(eventId,job.token,first.record,true);
    // After this persisted fence, any exception is an unknown result and must
    // never lead to another write. An expired lease may only reconcile by readback.
    try {
      const before = await gateway.readSnapshot(job.entry.recordId,job.entry.sourceFingerprint);
      if (sourceFingerprint(before.record,before.markerPresent) !== expected) { await store.markPlatformLegacyApprovalManual(eventId,job.token); return 'manual_reconciliation'; }
      await gateway.writeDecision(job.entry.recordId,patch,job.entry.sourceFingerprint);
      const after = await gateway.readSnapshot(job.entry.recordId,job.entry.sourceFingerprint);
      await store.confirmPlatformLegacyApproval(eventId,job.token,after.record,after.markerPresent);
      await store.completePlatformLegacyApproval(eventId,job.token);
      return 'completed';
    } catch { try { await store.markPlatformLegacyApprovalManual(eventId,job.token); } catch { /* durable fence remains */ } return 'manual_reconciliation'; }
  }};
}
