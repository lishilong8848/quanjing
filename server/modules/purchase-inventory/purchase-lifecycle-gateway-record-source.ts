import { createHash, randomUUID } from 'node:crypto';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';
import type { PurchaseManagerApprovalBatchEntry } from './purchase-workflow.store';
import type { PurchaseReplicaIdentity } from './purchase-lifecycle-replica';
import type { PurchaseLifecycleTrustedRecordSource } from './purchase-lifecycle-delivery-authorizer';
import type { PurchaseComparisonCardEvidence } from './purchase-comparison-card-evidence';

type Selector = (batch: PurchaseManagerApprovalBatchEntry, record: PurchaseWorkflowRecord) => boolean;
type Loaded = { batch: PurchaseManagerApprovalBatchEntry; records: PurchaseWorkflowRecord[]; comparisonImages: Record<string, Array<{ imageKey: string; alt: string }>>; comparisonCounts: Record<string, number> };
type Entry = { identity: PurchaseReplicaIdentity; selector: Selector; fingerprint: string; expiresAt: number };
const unavailable = (): never => { throw new Error('采购卡片数据来源无法核对'); };
const digest = (snapshot: Loaded) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

/** Direct Feishu reads; a matching second read is not a remote write lock or CAS. */
export class PurchaseLifecycleGatewayRecordSource implements PurchaseLifecycleTrustedRecordSource {
  private readonly snapshots = new Map<string, Entry>();
  constructor(
    private readonly store: { findManagerApprovalBatch(id: string): Promise<PurchaseManagerApprovalBatchEntry | null> },
    private readonly gateway: { getLifecycleExecutionRecordsAsApp(ids: string[]): Promise<PurchaseWorkflowRecord[]>; prepareManagerComparisonBatchEvidence(records: PurchaseWorkflowRecord[]): Promise<PurchaseComparisonCardEvidence[]> },
    private readonly currentAppId: () => string,
    private readonly clock: () => number = Date.now,
    private readonly sourceGuard?: () => Promise<void>,
  ) {}

  async load(identity: PurchaseReplicaIdentity, includeComparison: Selector): Promise<{ version: string; batchFingerprint: string; records: PurchaseWorkflowRecord[]; comparisonImages: Loaded['comparisonImages']; comparisonCounts: Loaded['comparisonCounts'] }> {
    if (typeof includeComparison !== 'function') return unavailable();
    const snapshot = await this.readLatest(identity, includeComparison);
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now <= 0) return unavailable();
    for (const [version, entry] of this.snapshots) if (entry.expiresAt <= now) this.snapshots.delete(version);
    if (this.snapshots.size >= 100) return unavailable();
    const version = randomUUID();
    this.snapshots.set(version, { identity: { ...identity }, selector: includeComparison, fingerprint: digest(snapshot), expiresAt: now + 180_000 });
    return { version, batchFingerprint: createHash('sha256').update(JSON.stringify(snapshot.batch)).digest('hex'), records: structuredClone(snapshot.records), comparisonImages: structuredClone(snapshot.comparisonImages), comparisonCounts: structuredClone(snapshot.comparisonCounts) };
  }

  isLocallyValid(version: string): boolean {
    const entry = this.snapshots.get(version), now = this.clock();
    return !!entry && Number.isSafeInteger(now) && now > 0 && now < entry.expiresAt && this.currentAppId() === entry.identity.appId;
  }

  async verifyLatest(version: string): Promise<boolean> {
    if (!this.isLocallyValid(version)) return false;
    const entry = this.snapshots.get(version)!;
    try {
      const fresh = await this.readLatest(entry.identity, entry.selector);
      return this.isLocallyValid(version) && digest(fresh) === entry.fingerprint;
    } catch { return false; }
  }

  private async readLatest(identity: PurchaseReplicaIdentity, includeComparison: Selector): Promise<Loaded> {
    await this.sourceGuard?.();
    if (this.currentAppId() !== identity.appId) return unavailable();
    const batch = await this.store.findManagerApprovalBatch(identity.batchId);
    if (!batch || batch.flowVersion !== 'lifecycle_v1' || batch.approvalBatchId !== identity.batchId ||
      !Array.isArray(batch.recordIds) || !batch.recordIds.length || batch.recordIds.length > 20 ||
      new Set(batch.recordIds).size !== batch.recordIds.length) return unavailable();
    const rows = await this.gateway.getLifecycleExecutionRecordsAsApp([...batch.recordIds]);
    if (!Array.isArray(rows) || rows.length !== batch.recordIds.length) return unavailable();
    const byId = new Map<string, PurchaseWorkflowRecord>();
    for (const row of rows) {
      if (!row || !batch.recordIds.includes(row.recordId) || byId.has(row.recordId)) return unavailable();
      byId.set(row.recordId, row);
    }
    const records = batch.recordIds.map(id => byId.get(id)!);
    const wanted = records.filter(record => {
      const selected: unknown = includeComparison(batch, record);
      if (selected instanceof Promise) void selected.catch(() => undefined);
      if (typeof selected !== 'boolean') return unavailable();
      return selected && record.procurementForm === '三方比价';
    });
    const comparisonImages: Loaded['comparisonImages'] = {};
    const comparisonCounts: Loaded['comparisonCounts'] = {};
    if (wanted.length) {
      const evidence = await this.gateway.prepareManagerComparisonBatchEvidence(wanted);
      if (!Array.isArray(evidence) || evidence.length !== wanted.length || new Set(evidence.map(entry => entry.recordId)).size !== wanted.length) return unavailable();
      for (const entry of evidence) {
        if (!wanted.some(record => record.recordId === entry.recordId) || !Array.isArray(entry.attachments) || entry.attachments.length < 3 || entry.attachments.length > 5 ||
          entry.attachments.some(attachment => !attachment || typeof attachment.name !== 'string' || (attachment.disposition !== 'original' &&
            (attachment.disposition !== 'preview' || typeof attachment.imageKey !== 'string' || !/^img_[A-Za-z0-9_-]+$/.test(attachment.imageKey))))) return unavailable();
        comparisonCounts[entry.recordId] = entry.attachments.length;
        comparisonImages[entry.recordId] = entry.attachments.filter(attachment => attachment.disposition === 'preview').map(attachment => ({ imageKey: attachment.imageKey!, alt: attachment.name }));
      }
    }
    if (this.currentAppId() !== identity.appId) return unavailable();
    await this.sourceGuard?.();
    return { batch: structuredClone(batch), records: structuredClone(records), comparisonImages, comparisonCounts };
  }
}
