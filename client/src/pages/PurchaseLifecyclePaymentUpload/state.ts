export interface PaymentTarget { approvalBatchId: string; executionRecordId: string; generation: number }
export interface PaymentPending extends PaymentTarget { accountId: string; requestId: string; state: 'pending' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TARGET_KEYS = ['approvalBatchId', 'executionRecordId', 'generation'];

/** Non-sensitive selectors only; identity and permission are always server-derived. */
export function parsePaymentTarget(search: string): PaymentTarget | null {
  const params = new URLSearchParams(search);
  if ([...params.keys()].some(key => !TARGET_KEYS.includes(key)) || TARGET_KEYS.some(key => params.getAll(key).length !== 1)) return null;
  const approvalBatchId = params.get('approvalBatchId') || '', executionRecordId = params.get('executionRecordId') || '', rawGeneration = params.get('generation') || '';
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(approvalBatchId) || !/^[A-Za-z0-9_-]{1,100}$/.test(executionRecordId) || !/^[1-9]\d{0,8}$/.test(rawGeneration)) return null;
  return { approvalBatchId, executionRecordId, generation: Number(rawGeneration) };
}

export function validatePaymentFiles(files: readonly Pick<File, 'name' | 'size'>[]): string | null {
  if (!files.length || files.length > 5) return '请选择 1 至 5 个附件。';
  if (files.some(file => !file.name.trim() || Array.from(file.name).length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(file.name))) return '附件名称无效，请修改名称后重试。';
  if (files.some(file => !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 20 * 1024 * 1024)) return '每个附件须大于 0 且不超过 20 MB。';
  return null;
}

export function paymentPendingKey(accountId: string, target: PaymentTarget): string {
  if (!accountId || accountId.length > 256) throw new Error('账号信息不可用');
  // A continuation must not bypass an uncertain upload from an earlier generation.
  return `purchase-payment-pending:${encodeURIComponent(accountId)}:${encodeURIComponent(target.approvalBatchId)}:${encodeURIComponent(target.executionRecordId)}`;
}

export function parsePaymentPending(value: string | null, accountId: string, target: PaymentTarget): PaymentPending | null {
  if (value === null) return null;
  try {
    const row: unknown = JSON.parse(value);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
    const entry = row as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'accountId,approvalBatchId,executionRecordId,generation,requestId,state' ||
      entry.accountId !== accountId || entry.approvalBatchId !== target.approvalBatchId || entry.executionRecordId !== target.executionRecordId ||
      !Number.isSafeInteger(entry.generation) || Number(entry.generation) < 1 || Number(entry.generation) > target.generation || entry.state !== 'pending' || typeof entry.requestId !== 'string' || !UUID.test(entry.requestId)) throw new Error();
    return entry as unknown as PaymentPending;
  } catch { throw new Error('上次上传记录无法核对，请联系管理员。'); }
}

/** Write and read back before sending; a storage error must prevent the upload. */
export function reservePaymentAttempt(storage: Storage, accountId: string, target: PaymentTarget, requestId: string): PaymentPending {
  if (!UUID.test(requestId)) throw new Error('上传请求标识无效');
  const key = paymentPendingKey(accountId, target);
  if (storage.getItem(key) !== null) throw new Error('上次上传结果待核对，请勿重复上传。');
  const entry: PaymentPending = { ...target, accountId, requestId, state: 'pending' };
  storage.setItem(key, JSON.stringify(entry));
  if (parsePaymentPending(storage.getItem(key), accountId, target)?.requestId !== requestId) throw new Error('上传记录保存失败，请重试。');
  return entry;
}

export function finishPaymentAttempt(storage: Storage, accountId: string, target: PaymentTarget, requestId: string): void {
  const key = paymentPendingKey(accountId, target), pending = parsePaymentPending(storage.getItem(key), accountId, target);
  if (!pending || pending.requestId !== requestId) throw new Error('上传记录状态已变化，请联系管理员核对。');
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error('上传记录状态无法确认，请联系管理员核对。');
}
