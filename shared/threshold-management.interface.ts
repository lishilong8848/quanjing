export const THRESHOLD_KINDS = ['告警', '设定', '额定参数', '待核对'] as const;
export type ThresholdKind = (typeof THRESHOLD_KINDS)[number];
export interface ThresholdInput {
  profession: string;
  device: string;
  section: string;
  parameter: string;
  building: string;
  location: string;
  model?: string;
  brand?: string;
  value: string;
  range?: string;
  unit: string;
  kind: ThresholdKind;
  enabled: string;
  note: string;
}
export interface ThresholdRecord extends ThresholdInput {
  id: string;
  version: number;
  updatedAt: string;
  source: {
    sheet: string;
    cell: string;
    originalValue: string;
    parameterCell?: string;
    rangeCell?: string;
    noteCell?: string;
  } | null;
}
export interface ThresholdSnapshot {
  records: ThresholdRecord[];
  revision: number;
  updatedAt: string;
  syncResults?: ThresholdMutationResult[];
  sourceSync?: ThresholdSourceSync;
}
export interface ThresholdSourceSync {
  state: 'loading' | 'ready' | 'error';
  checkedAt?: string;
  error?: string;
}
export interface ThresholdCommand {
  operation: 'create' | 'update' | 'delete';
  clientMutationId: string;
  id?: string;
  expectedVersion?: number;
  expectedContent?: string;
  record?: ThresholdInput;
}
export interface ThresholdMutationResult {
  clientMutationId: string;
  operation: ThresholdCommand['operation'];
  id: string;
  record: ThresholdRecord | null;
  revision: number;
  updatedAt: string;
  sync?: ThresholdSyncState;
}
export interface ThresholdSyncState {
  state: 'pending' | 'success' | 'error' | 'cancelled';
  attempts: number;
  error?: string;
  nextAttemptAt?: string;
  finishedAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  cloudRecords?: Record<string, string>;
}
export interface ThresholdSyncJob {
  actor: string;
  before: ThresholdRecord | null;
  result: ThresholdMutationResult;
}
export type ThresholdOverlay = Record<
  string,
  { record: ThresholdRecord | null; mutationId: string }
>;
export function mergeThresholdReceipt(
  previous: ThresholdSnapshot,
  result: ThresholdMutationResult,
  temporaryKey: string,
  expectedVersion?: number,
): ThresholdSnapshot {
  const current = previous.records.find((record) => record.id === result.id);
  const stale =
    current &&
    current.version >
      (result.record?.version ?? expectedVersion ?? current.version);
  const records = stale
    ? previous.records
    : previous.records.filter(
        (record) => record.id !== result.id && record.id !== temporaryKey,
      );
  if (!stale && result.record) records.unshift(result.record);
  return {
    ...previous,
    records,
    revision: Math.max(previous.revision, result.revision),
    updatedAt:
      previous.updatedAt > result.updatedAt
        ? previous.updatedAt
        : result.updatedAt,
  };
}
export function applyThresholdOverlay(
  records: ThresholdRecord[],
  overlay: ThresholdOverlay,
): ThresholdRecord[] {
  const result = records
    .map((record) => (overlay[record.id] ? overlay[record.id].record : record))
    .filter((record): record is ThresholdRecord => Boolean(record));
  const ids = new Set(records.map((record) => record.id));
  for (const [id, item] of Object.entries(overlay))
    if (!ids.has(id) && item.record) result.unshift(item.record);
  return result;
}
