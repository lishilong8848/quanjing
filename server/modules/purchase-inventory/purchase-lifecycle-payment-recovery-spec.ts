/** Isolated specification helper only. It is not an endpoint or ledger adapter.
 * The caller must authenticate the session and authorize the actual order inside
 * the SAME ledger lock used for upload reservation before invoking this helper.
 * A query does not fence delayed requests and must NEVER authorize a new upload.
 */
export interface LifecyclePaymentRecoveryQuery {
  readonly appId: string; readonly actorOpenId: string;
  readonly approvalBatchId: string; readonly executionRecordId: string;
}
export type LifecyclePaymentRecoveryState = 'prepared' | 'dispatching' | 'uploaded' | 'manual_reconciliation' | 'committed' | 'cancelled';
export interface LifecyclePaymentRecoveryRow {
  readonly appId: string; readonly actorOpenId: string;
  readonly approvalBatchId: string; readonly executionRecordId: string;
  readonly entry: { readonly status: LifecyclePaymentRecoveryState };
}
export type LifecyclePaymentRecoveryResult = Readonly<{
  state: 'pending' | 'none_verified';
  /** Even none_verified cannot prove that an older request won't arrive later. */
  mayStartNewUpload: false;
}>;

export function projectLifecyclePaymentRecovery(
  query: LifecyclePaymentRecoveryQuery,
  rows: readonly LifecyclePaymentRecoveryRow[],
  /** Must revalidate session, principal, actual duties and record scope while holding the ledger lock. */
  authorizeInLedgerLock: (query: LifecyclePaymentRecoveryQuery) => true,
): LifecyclePaymentRecoveryResult {
  if (!query || !/^cli_[A-Za-z0-9_-]+$/.test(query.appId) || !/^ou_[A-Za-z0-9_-]+$/.test(query.actorOpenId) ||
      !/^[A-Za-z0-9_-]{8,160}$/.test(query.approvalBatchId) || !/^[A-Za-z0-9_-]{1,100}$/.test(query.executionRecordId) ||
      !Array.isArray(rows) || authorizeInLedgerLock(query) !== true) throw new Error('付款任务不可查询');
  const statuses: readonly string[] = ['prepared', 'dispatching', 'uploaded', 'manual_reconciliation', 'committed', 'cancelled'];
  let pending = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.appId !== 'string' || typeof row.actorOpenId !== 'string' ||
        typeof row.approvalBatchId !== 'string' || typeof row.executionRecordId !== 'string' || !row.entry || !statuses.includes(row.entry.status)) {
      throw new Error('付款任务不可查询');
    }
    if (row.appId === query.appId && row.actorOpenId === query.actorOpenId && row.approvalBatchId === query.approvalBatchId &&
        row.executionRecordId === query.executionRecordId && !['committed', 'cancelled'].includes(row.entry.status)) pending = true;
  }
  return Object.freeze({ state: pending ? 'pending' : 'none_verified', mayStartNewUpload: false });
}
