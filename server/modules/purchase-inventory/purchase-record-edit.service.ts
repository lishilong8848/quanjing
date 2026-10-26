import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  PurchaseRecordEditableStatus,
  PurchaseRecordUpdateFields,
  PurchaseRecordUpdateRequest,
  PurchaseRecordUpdateResponse,
} from '../../../shared/purchase-inventory.interface';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';

const RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]+$/;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;
const BUILDINGS = new Set(['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站']);
const EDITABLE_STATUSES = new Set<PurchaseRecordEditableStatus>([
  'application',
  'approval',
  'executing',
  'receiving',
  'warehouse',
  'stocked',
]);

interface StatusFieldPatch {
  submission: Record<string, unknown>;
  execution: Record<string, unknown>;
}

@Injectable()
export class PurchaseRecordEditService {
  constructor(private readonly gateway: PurchaseWorkflowGateway) {}

  async updateRecord(
    routeRecordId: string,
    request: PurchaseRecordUpdateRequest,
  ): Promise<PurchaseRecordUpdateResponse> {
    const submissionRecordId = normalizeRecordId(request?.submissionRecordId);
    const executionRecordId = normalizeRecordId(request?.executionRecordId);
    const targetRecordId = normalizeRecordId(routeRecordId);
    if (!submissionRecordId && !executionRecordId) {
      throw new BadRequestException('采购记录缺少可更新的多维表记录 ID');
    }
    if (
      targetRecordId !== submissionRecordId &&
      targetRecordId !== executionRecordId
    ) {
      throw new BadRequestException('请求路径与采购记录 ID 不匹配');
    }

    const fields = normalizeFields(request?.fields);
    const statusPatch = buildStatusFieldPatch(
      fields.status,
      Boolean(executionRecordId),
      Date.now(),
    );
    const submissionFields = {
      ...buildSubmissionFields(fields),
      ...statusPatch.submission,
    };
    const executionFields = {
      ...buildExecutionFields(fields),
      ...statusPatch.execution,
    };
    const startedAt = Date.now();
    let updatedSubmissionRecord = false;
    let updatedExecutionRecord = false;

    if (submissionRecordId && Object.keys(submissionFields).length) {
      await this.gateway.updateSubmissionRecordAsApp(
        submissionRecordId,
        submissionFields,
      );
      updatedSubmissionRecord = true;
    }
    if (executionRecordId && Object.keys(executionFields).length) {
      try {
        await this.gateway.updateExecutionRecordAsApp(
          executionRecordId,
          executionFields,
        );
        updatedExecutionRecord = true;
      } catch (error) {
        if (updatedSubmissionRecord) {
          const message = error instanceof Error ? error.message : '未知错误';
          throw new BadRequestException(
            `采购申请表已更新，但采购执行表同步失败：${message}`,
          );
        }
        throw error;
      }
    }

    return {
      updatedSubmissionRecord,
      updatedExecutionRecord,
      durationMs: Date.now() - startedAt,
    };
  }
}

function normalizeFields(value: unknown): PurchaseRecordUpdateFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('采购记录更新字段格式错误');
  }
  const input = value as Record<string, unknown>;
  const fields: PurchaseRecordUpdateFields = {};

  if ('itemName' in input) {
    fields.itemName = requiredText(input.itemName, '物品名称不能为空');
  }
  if ('quantity' in input) {
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('采购数量必须大于 0');
    }
    fields.quantity = quantity;
  }
  if ('unit' in input) {
    fields.unit = requiredText(input.unit, '计数单位不能为空');
  }
  if ('building' in input) {
    const building = requiredText(input.building, '楼栋不能为空');
    if (!BUILDINGS.has(building)) {
      throw new BadRequestException('楼栋不在允许范围内');
    }
    fields.building = building;
  }
  if ('supplier' in input) fields.supplier = optionalText(input.supplier);
  if ('notes' in input) fields.notes = optionalText(input.notes);
  if ('expectedArrival' in input) {
    if (input.expectedArrival === null || input.expectedArrival === '') {
      fields.expectedArrival = null;
    } else {
      const date = requiredText(input.expectedArrival, '计划到货日期格式错误');
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(toTimestamp(date))
      ) {
        throw new BadRequestException('计划到货日期格式错误');
      }
      fields.expectedArrival = date;
    }
  }
  if ('requesterOpenId' in input) {
    const openId = requiredText(input.requesterOpenId, '申请人不能为空');
    if (!OPEN_ID_PATTERN.test(openId)) {
      throw new BadRequestException('申请人飞书 ID 格式错误');
    }
    fields.requesterOpenId = openId;
  }
  if ('status' in input) {
    const status = optionalText(input.status) as PurchaseRecordEditableStatus;
    if (!EDITABLE_STATUSES.has(status)) {
      throw new BadRequestException('采购状态不在允许范围内');
    }
    fields.status = status;
  }

  if (!Object.keys(fields).length) {
    throw new BadRequestException('请至少修改一个采购字段');
  }
  return fields;
}

function buildSubmissionFields(
  fields: PurchaseRecordUpdateFields,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (fields.itemName !== undefined) result['新增物品名称'] = fields.itemName;
  if (fields.quantity !== undefined) result['采购数量'] = fields.quantity;
  if (fields.unit !== undefined) result['单位'] = fields.unit;
  if (fields.building !== undefined) {
    result['申请楼栋（多楼请选H楼，备注里填写详情）'] = fields.building;
  }
  if (fields.supplier !== undefined) result['供应商'] = fields.supplier;
  if (fields.expectedArrival !== undefined) {
    result['期望交付时间'] = fields.expectedArrival
      ? toTimestamp(fields.expectedArrival)
      : null;
  }
  if (fields.notes !== undefined) result['其他备注'] = fields.notes;
  if (fields.requesterOpenId !== undefined) {
    result['业务申请人'] = [{ id: fields.requesterOpenId }];
  }
  return result;
}

function buildExecutionFields(
  fields: PurchaseRecordUpdateFields,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (fields.itemName !== undefined) result['物品名称'] = fields.itemName;
  if (fields.quantity !== undefined) result['采购申请数量'] = fields.quantity;
  if (fields.unit !== undefined) result['计数单位'] = fields.unit;
  if (fields.building !== undefined) result['申请楼栋'] = [fields.building];
  if (fields.supplier !== undefined) result['供应商'] = fields.supplier;
  if (fields.expectedArrival !== undefined) {
    result['期望交付时间'] = fields.expectedArrival
      ? toTimestamp(fields.expectedArrival)
      : null;
  }
  if (fields.notes !== undefined) result['需求备注（提交人)'] = fields.notes;
  if (fields.requesterOpenId !== undefined) {
    result['需求人'] = [{ id: fields.requesterOpenId }];
  }
  return result;
}

function buildStatusFieldPatch(
  status: PurchaseRecordEditableStatus | undefined,
  hasExecutionRecord: boolean,
  now: number,
): StatusFieldPatch {
  if (!status) return { submission: {}, execution: {} };
  if (status === 'application') {
    if (hasExecutionRecord) {
      throw new BadRequestException('已有采购执行记录，不能回退到待提交');
    }
    return {
      submission: { '提交成功（无需点击🚫）': false },
      execution: {},
    };
  }
  if (status === 'approval' && !hasExecutionRecord) {
    return {
      submission: { '提交成功（无需点击🚫）': true },
      execution: {},
    };
  }
  if (!hasExecutionRecord) {
    throw new BadRequestException('该申请尚无采购执行记录，不能调整到此状态');
  }

  const clearedDownstream = {
    '到货签收确认（签收内容填写完成后点击）': false,
    采购完成: false,
    库房确认: false,
    签收时间: null,
  };
  if (status === 'approval') {
    return {
      submission: {},
      execution: {
        采购流程: '未开始（待审批）',
        ...clearedDownstream,
      },
    };
  }
  if (status === 'executing') {
    return {
      submission: {},
      execution: {
        采购流程: '审批通过（待下单）',
        ...clearedDownstream,
      },
    };
  }
  if (status === 'receiving') {
    return {
      submission: {},
      execution: {
        采购流程: '下单完成（待签收）',
        ...clearedDownstream,
      },
    };
  }
  if (status === 'warehouse') {
    return {
      submission: { '是否需要录入 库房台账': true },
      execution: {
        采购流程: '采购完成（已入库）',
        '到货签收确认（签收内容填写完成后点击）': true,
        采购完成: false,
        库房确认: false,
        签收时间: now,
      },
    };
  }
  return {
    submission: {},
    execution: {
      采购流程: '采购完成（已入库）',
      '到货签收确认（签收内容填写完成后点击）': true,
      采购完成: true,
      库房确认: true,
      签收时间: now,
    },
  };
}

function normalizeRecordId(value: unknown): string | null {
  const recordId = optionalText(value);
  if (!recordId) return null;
  if (!RECORD_ID_PATTERN.test(recordId)) {
    throw new BadRequestException('多维表记录 ID 格式错误');
  }
  return recordId;
}

function requiredText(value: unknown, message: string): string {
  const text = optionalText(value);
  if (!text) throw new BadRequestException(message);
  return text;
}

function optionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toTimestamp(date: string): number {
  return new Date(`${date}T00:00:00+08:00`).getTime();
}
