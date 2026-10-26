import type { ContractWorkflowCode } from '../../../shared/contract-management.interface';

export interface ContractWorkflowRecord {
  recordId: string;
  kind: 'contract' | 'payment';
  name: string;
  code: string;
  ownerNames: string[];
  ownerOpenIds: string[];
  specialty: string;
  specialtyManagerOpenIds: string[];
  amount: number;
  startDate: string | null;
  endDate: string | null;
  attachmentCount: number;
  paymentPlanCount: number;
  createdAt: string;
  paymentStatus?: string;
  actualAmount?: number;
}

export interface ContractWorkflowCandidate {
  record: ContractWorkflowRecord;
  dedupeKey: string;
}

interface BuildCandidatesInput {
  workflow: ContractWorkflowCode;
  records: ContractWorkflowRecord[];
  now: Date;
  baselineAt: string | null;
  processedKeys: ReadonlySet<string>;
}

export function buildContractWorkflowCandidates(
  input: BuildCandidatesInput,
): ContractWorkflowCandidate[] {
  const tomorrow = addShanghaiDays(shanghaiDateKey(input.now), 1);
  return input.records.flatMap((record) => {
    const dedupeKey = candidateKey(input.workflow, record, tomorrow);
    if (!dedupeKey || input.processedKeys.has(dedupeKey)) return [];

    if (record.endDate !== tomorrow) return [];
    if (input.workflow === 'payment_due_reminder') {
      if (record.kind !== 'payment' || isPaid(record)) return [];
      return [{ record, dedupeKey }];
    }

    if (
      record.kind !== 'contract' ||
      !record.name ||
      !record.ownerNames.length ||
      record.amount <= 0 ||
      !record.startDate ||
      !record.specialty ||
      record.paymentPlanCount < 1
    ) {
      return [];
    }
    return [{ record, dedupeKey }];
  });
}

export function isContractWorkflowCode(
  value: string,
): value is ContractWorkflowCode {
  return ['payment_due_reminder', 'contract_expiry_reminder'].includes(value);
}

export function shanghaiDateKey(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function candidateKey(
  workflow: ContractWorkflowCode,
  record: ContractWorkflowRecord,
  tomorrow: string,
): string {
  const triggerValue = record.endDate || tomorrow;
  return triggerValue ? `${workflow}:${record.recordId}:${triggerValue}` : '';
}

function isPaid(record: ContractWorkflowRecord): boolean {
  return (
    (record.paymentStatus || '').includes('已付款') ||
    (record.amount > 0 && (record.actualAmount || 0) >= record.amount)
  );
}

function addShanghaiDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}
