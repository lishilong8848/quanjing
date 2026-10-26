import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  PurchaseRecordBatchDeleteRequest,
  PurchaseRecordBatchDeleteResponse,
  PurchaseRecordDeleteTarget,
} from '../../../shared/purchase-inventory.interface';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';

const MAX_DELETE_ITEMS = 200;
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]+$/;

@Injectable()
export class PurchaseRecordDeletionService {
  constructor(private readonly gateway: PurchaseWorkflowGateway) {}

  async deleteRecords(
    request: PurchaseRecordBatchDeleteRequest,
  ): Promise<PurchaseRecordBatchDeleteResponse> {
    const records = normalizeTargets(request?.records);
    const submissionRecordIds = uniqueIds(
      records.map((record) => record.submissionRecordId),
    );
    const executionRecordIds = uniqueIds(
      records.map((record) => record.executionRecordId),
    );
    if (!submissionRecordIds.length && !executionRecordIds.length) {
      throw new BadRequestException('所选采购记录缺少可删除的多维表记录 ID');
    }

    const startedAt = Date.now();
    await this.gateway.batchDeleteRecordsAsApp({
      submissionRecordIds,
      executionRecordIds,
    });
    return {
      deletedItems: records.length,
      deletedSubmissionRecords: submissionRecordIds.length,
      deletedExecutionRecords: executionRecordIds.length,
      durationMs: Date.now() - startedAt,
    };
  }
}

function normalizeTargets(value: unknown): PurchaseRecordDeleteTarget[] {
  if (!Array.isArray(value) || !value.length) {
    throw new BadRequestException('请至少选择一条采购记录');
  }
  if (value.length > MAX_DELETE_ITEMS) {
    throw new BadRequestException(
      `单次最多删除 ${MAX_DELETE_ITEMS} 条采购记录`,
    );
  }

  const uniqueTargets = new Map<string, PurchaseRecordDeleteTarget>();
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw new BadRequestException('采购记录删除参数格式错误');
    }
    const target = candidate as Record<string, unknown>;
    const submissionRecordId = normalizeRecordId(target.submissionRecordId);
    const executionRecordId = normalizeRecordId(target.executionRecordId);
    if (!submissionRecordId && !executionRecordId) {
      throw new BadRequestException('采购记录缺少多维表记录 ID');
    }
    const key =
      clean(target.key) ||
      `${submissionRecordId || ''}:${executionRecordId || ''}`;
    uniqueTargets.set(key, { key, submissionRecordId, executionRecordId });
  }
  return [...uniqueTargets.values()];
}

function normalizeRecordId(value: unknown): string | null {
  const recordId = clean(value);
  if (!recordId) return null;
  if (!RECORD_ID_PATTERN.test(recordId)) {
    throw new BadRequestException('多维表记录 ID 格式错误');
  }
  return recordId;
}

function uniqueIds(values: Array<string | null>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
