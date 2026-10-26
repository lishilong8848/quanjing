import { Injectable } from '@nestjs/common';
import type {
  InventoryWorkflowCode,
  InventoryWorkflowLogItem,
} from '../../../shared/inventory-management.interface';
import {
  extractDisplayText,
  extractNumberValue,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import {
  escapeBaseFilterText,
  InventoryWorkflowGateway,
} from './inventory-workflow.gateway';

export type InventoryWorkflowStage =
  | '处理中'
  | '业务已写入'
  | '源记录已回写'
  | '已完成'
  | '失败'
  | '已清理';

export interface InventoryWorkflowExecution {
  recordId: string;
  idempotencyKey: string;
  code: InventoryWorkflowCode;
  workflowName: string;
  runId: string;
  sourceTable: string;
  sourceRecordId: string;
  targetRecordId: string;
  messageState: Record<string, string>;
  stage: InventoryWorkflowStage;
  attempts: number;
  result: string;
  error: string;
  lastRunAt: string | null;
  completedAt: string | null;
  selfTest: boolean;
}

interface ClaimExecutionInput {
  idempotencyKey: string;
  code: InventoryWorkflowCode;
  workflowName: string;
  runId: string;
  sourceTable: string;
  sourceRecordId: string;
  selfTest?: boolean;
}

@Injectable()
export class InventoryWorkflowStore {
  constructor(private readonly gateway: InventoryWorkflowGateway) {}

  async find(
    appToken: string,
    tableId: string,
    idempotencyKey: string,
  ): Promise<InventoryWorkflowExecution | null> {
    const records = await this.gateway.listRecords({
      appToken,
      tableId,
      tableName: '程序工作流执行日志',
      filter: `CurrentValue.[幂等键]="${escapeBaseFilterText(idempotencyKey)}"`,
    });
    return records.length ? mapExecution(latestRecord(records)) : null;
  }

  async claim(
    appToken: string,
    tableId: string,
    input: ClaimExecutionInput,
  ): Promise<InventoryWorkflowExecution> {
    const existing = await this.find(appToken, tableId, input.idempotencyKey);
    const now = Date.now();
    if (existing) {
      await this.gateway.updateRecord(
        appToken,
        tableId,
        existing.recordId,
        {
          运行ID: input.runId,
          尝试次数: existing.attempts + 1,
          最后运行时间: now,
          错误信息: '',
        },
        '程序工作流执行日志',
      );
      return {
        ...existing,
        runId: input.runId,
        attempts: existing.attempts + 1,
        lastRunAt: new Date(now).toISOString(),
        error: '',
      };
    }

    const fields = {
      幂等键: input.idempotencyKey,
      工作流代码: input.code,
      工作流名称: input.workflowName,
      运行ID: input.runId,
      源表: input.sourceTable,
      源记录ID: input.sourceRecordId,
      目标记录ID: '',
      通知消息ID: '{}',
      阶段: '处理中',
      尝试次数: 1,
      处理结果: '',
      错误信息: '',
      最后运行时间: now,
      完成时间: null,
      自测记录: Boolean(input.selfTest),
    };
    const recordId = await this.gateway.createRecord(
      appToken,
      tableId,
      fields,
      '程序工作流执行日志',
    );
    return {
      recordId,
      idempotencyKey: input.idempotencyKey,
      code: input.code,
      workflowName: input.workflowName,
      runId: input.runId,
      sourceTable: input.sourceTable,
      sourceRecordId: input.sourceRecordId,
      targetRecordId: '',
      messageState: {},
      stage: '处理中',
      attempts: 1,
      result: '',
      error: '',
      lastRunAt: new Date(now).toISOString(),
      completedAt: null,
      selfTest: Boolean(input.selfTest),
    };
  }

  async update(
    appToken: string,
    tableId: string,
    execution: InventoryWorkflowExecution,
  ): Promise<InventoryWorkflowExecution> {
    const now = Date.now();
    await this.gateway.updateRecord(
      appToken,
      tableId,
      execution.recordId,
      {
        运行ID: execution.runId,
        目标记录ID: execution.targetRecordId,
        通知消息ID: JSON.stringify(execution.messageState),
        阶段: execution.stage,
        尝试次数: execution.attempts,
        处理结果: execution.result,
        错误信息: execution.error,
        最后运行时间: now,
        完成时间: execution.completedAt
          ? new Date(execution.completedAt).getTime()
          : null,
      },
      '程序工作流执行日志',
    );
    return { ...execution, lastRunAt: new Date(now).toISOString() };
  }

  async listRecent(
    appToken: string,
    tableId: string,
    limit = 30,
  ): Promise<InventoryWorkflowLogItem[]> {
    const records = await this.gateway.listRecords({
      appToken,
      tableId,
      tableName: '程序工作流执行日志',
    });
    return records
      .sort((left, right) => recordTime(right) - recordTime(left))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((record) => toLogItem(mapExecution(record)));
  }

  async delete(
    appToken: string,
    tableId: string,
    recordId: string,
  ): Promise<void> {
    await this.gateway.deleteRecord(
      appToken,
      tableId,
      recordId,
      '程序工作流执行日志',
    );
  }
}

function mapExecution(record: BitableRecordItem): InventoryWorkflowExecution {
  const fields = record.fields || {};
  return {
    recordId: getRecordId(record),
    idempotencyKey: extractDisplayText(fields['幂等键']),
    code: extractDisplayText(fields['工作流代码']) as InventoryWorkflowCode,
    workflowName: extractDisplayText(fields['工作流名称']),
    runId: extractDisplayText(fields['运行ID']),
    sourceTable: extractDisplayText(fields['源表']),
    sourceRecordId: extractDisplayText(fields['源记录ID']),
    targetRecordId: extractDisplayText(fields['目标记录ID']),
    messageState: parseMessageState(fields['通知消息ID']),
    stage: (extractDisplayText(fields['阶段']) || '处理中') as InventoryWorkflowStage,
    attempts: extractNumberValue(fields['尝试次数']) || 0,
    result: extractDisplayText(fields['处理结果']),
    error: extractDisplayText(fields['错误信息']),
    lastRunAt: dateValue(fields['最后运行时间']),
    completedAt: dateValue(fields['完成时间']),
    selfTest: checked(fields['自测记录']),
  };
}

function toLogItem(execution: InventoryWorkflowExecution): InventoryWorkflowLogItem {
  return {
    recordId: execution.recordId,
    code: execution.code,
    workflowName: execution.workflowName,
    sourceRecordId: execution.sourceRecordId,
    targetRecordId: execution.targetRecordId,
    stage: execution.stage,
    attempts: execution.attempts,
    result: execution.result,
    error: execution.error,
    lastRunAt: execution.lastRunAt,
    completedAt: execution.completedAt,
    selfTest: execution.selfTest,
  };
}

function parseMessageState(value: unknown): Record<string, string> {
  const text = extractDisplayText(value);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function latestRecord(records: BitableRecordItem[]): BitableRecordItem {
  return [...records].sort((left, right) => recordTime(right) - recordTime(left))[0];
}

function recordTime(record: BitableRecordItem): number {
  return Number(record.last_modified_time || record.created_time || 0);
}

function checked(value: unknown): boolean {
  return value === true || value === 1 || extractDisplayText(value) === 'true';
}

function dateValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  const text = extractDisplayText(value);
  if (!text) return null;
  const parsed = new Date(text.includes('T') ? text : text.replace(' ', 'T') + '+08:00');
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
