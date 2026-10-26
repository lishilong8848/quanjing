import type {
  InventoryBatchAcceptanceResponse,
  InventoryOutboundMovementCreateRequest,
  PurchaseExistingInboundConfirmRequest,
  PurchaseNewInboundConfirmRequest,
} from '@shared/inventory-management.interface';

export type InventoryBatchKind = 'purchase' | 'outbound';
export type InventoryBatchRequest =
  | InventoryOutboundMovementCreateRequest
  | PurchaseExistingInboundConfirmRequest
  | PurchaseNewInboundConfirmRequest;

export interface InventoryBatchEntry {
  clientMutationId: string;
  label: string;
  status:
    | 'submitting'
    | 'accepted'
    | 'completed'
    | 'failed'
    | 'uncertain'
    | 'rejected';
  taskId?: string;
  message: string;
}

export function updateInventoryBatchTask(
  journal: InventoryBatchJournal,
  clientMutationId: string,
  status: 'accepted' | 'completed' | 'failed' | 'uncertain',
  message: string,
): InventoryBatchJournal {
  const current = journal.entries.find(
    (entry) => entry.clientMutationId === clientMutationId,
  );
  if (!current || (current.status === status && current.message === message))
    return journal;
  return {
    ...journal,
    entries: journal.entries.map((entry) =>
      entry.clientMutationId === clientMutationId
        ? { ...entry, status, message }
        : entry,
    ),
  };
}

export interface InventoryBatchJournal {
  version: 1;
  kind: InventoryBatchKind;
  principalFingerprint: string;
  requests: InventoryBatchRequest[];
  entries: InventoryBatchEntry[];
  createdAt: number;
}

function storageKey(
  principalFingerprint: string,
  kind: InventoryBatchKind,
): string {
  return `inventory-batch-v1:${principalFingerprint}:${kind}`;
}

export function createInventoryBatchJournal(
  kind: InventoryBatchKind,
  principalFingerprint: string,
  requests: InventoryBatchRequest[],
  labels: string[],
): InventoryBatchJournal {
  if (
    !principalFingerprint ||
    requests.length < 2 ||
    requests.length > 50 ||
    requests.length !== labels.length
  ) {
    throw new Error('批量操作数据不完整');
  }
  const ids = requests.map((request) => request.clientMutationId?.trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error('批量操作编号无效或重复');
  }
  const batchId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/gu, '')
      : `${Date.now().toString(16).padStart(12, '0')}${Math.random().toString(16).slice(2).padEnd(20, '0').slice(0, 20)}`;
  const normalizedRequests = requests.map((request, index) => ({
    ...request,
    clientMutationId: `inventory_batch_${kind === 'purchase' ? 'inbound' : 'outbound'}_${batchId}_${index + 1}`,
  }));
  return {
    version: 1,
    kind,
    principalFingerprint,
    requests: normalizedRequests,
    entries: normalizedRequests.map((request, index) => ({
      clientMutationId: request.clientMutationId,
      label: labels[index],
      status: 'submitting',
      message: '正在受理',
    })),
    createdAt: Date.now(),
  };
}

export function readInventoryBatchJournal(
  principalFingerprint: string,
  kind: InventoryBatchKind,
): InventoryBatchJournal | null {
  const raw = window.localStorage.getItem(
    storageKey(principalFingerprint, kind),
  );
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object')
    throw new Error('批量任务记录损坏，请联系管理员');
  const journal = value as InventoryBatchJournal;
  if (
    journal.version !== 1 ||
    journal.kind !== kind ||
    journal.principalFingerprint !== principalFingerprint ||
    !Array.isArray(journal.requests) ||
    !Array.isArray(journal.entries) ||
    journal.requests.length !== journal.entries.length ||
    journal.requests.length < 2 ||
    journal.requests.length > 50 ||
    journal.requests.some(
      (request, index) =>
        request.clientMutationId !== journal.entries[index]?.clientMutationId,
    )
  )
    throw new Error('批量任务记录损坏，请联系管理员');
  return journal;
}

export function saveInventoryBatchJournal(
  journal: InventoryBatchJournal,
): void {
  window.localStorage.setItem(
    storageKey(journal.principalFingerprint, journal.kind),
    JSON.stringify(journal),
  );
  const saved = readInventoryBatchJournal(
    journal.principalFingerprint,
    journal.kind,
  );
  if (!saved || saved.requests.length !== journal.requests.length) {
    throw new Error('批量任务无法安全保存，本次未发送');
  }
}

export function applyInventoryBatchAcceptance(
  journal: InventoryBatchJournal,
  response: InventoryBatchAcceptanceResponse,
): InventoryBatchJournal {
  const results = new Map(
    response.items.map((item) => [item.clientMutationId, item]),
  );
  if (
    response.success !== true ||
    results.size !== journal.entries.length ||
    journal.entries.some((entry) => !results.has(entry.clientMutationId))
  )
    throw new Error('批量受理响应与提交内容不一致，请用原编号重新核对');
  return {
    ...journal,
    entries: journal.entries.map((entry) => {
      const result = results.get(entry.clientMutationId)!;
      if (result.accepted && !result.taskId) {
        throw new Error('批量任务缺少任务号，请用原编号重新核对');
      }
      return {
        ...entry,
        status: result.accepted ? 'accepted' : 'rejected',
        taskId: result.taskId,
        message: result.message,
      };
    }),
  };
}
