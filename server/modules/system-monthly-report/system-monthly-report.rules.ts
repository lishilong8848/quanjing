import { BadRequestException } from '@nestjs/common';
import type {
  SystemMonthlyReportModuleKey,
  SystemMonthlyReportReviewRound,
  SystemMonthlyReportReviewRequest,
  SystemMonthlyReportRoomStatus,
  SystemMonthlyReportStage,
  SystemMonthlyReportSubmissionRequest,
} from '../../../shared/system-monthly-report.interface';
import { buildSystemMonthlyReportVersionedFileName } from '../../../shared/system-monthly-report.interface';

type BitableFields = Record<string, unknown>;
type ModuleFiles = Partial<Record<SystemMonthlyReportModuleKey, string[]>>;

const MODULE_KEYS: SystemMonthlyReportModuleKey[] = [
  'event',
  'change',
  'maintenance',
  'drill',
  'other',
];

const MODULE_LABELS: Record<SystemMonthlyReportModuleKey, string> = {
  event: '事件管理',
  change: '变更管理',
  maintenance: '维护管理',
  drill: '演练管理',
  other: '其他问题',
};

const REVIEW_FIELD_SUFFIXES: Record<
  SystemMonthlyReportModuleKey,
  { issue: string; description: string; screenshot: string }
> = {
  event: {
    issue: '事件模块是否有问题',
    description: '事件模块',
    screenshot: '事件模块截图',
  },
  change: {
    issue: '变更模块是否有问题',
    description: '变更模块',
    screenshot: '变更模块截图',
  },
  maintenance: {
    issue: '维护模块是否有问题',
    description: '维护模块',
    screenshot: '维护模块截图',
  },
  drill: {
    issue: '演练模块是否有问题',
    description: '演练模块',
    screenshot: '演练模块截图',
  },
  other: {
    issue: '是否有其他问题',
    description: '其他问题项',
    screenshot: '其他问题截图',
  },
};

const SUBMISSION_ATTACHMENT_FIELDS = {
  initial: '初版月报',
  recheck: '复审月报',
  final: '终版月报',
} as const;

const SUBMISSION_STATUS_BY_STAGE: Record<
  SystemMonthlyReportStage,
  SystemMonthlyReportRoomStatus
> = {
  initial: 'initial_pending',
  recheck: 'recheck_pending',
  final: 'final_pending',
};

const REVIEW_STATUS_BY_ROUND: Record<
  SystemMonthlyReportReviewRound,
  SystemMonthlyReportRoomStatus
> = {
  initial: 'initial_review',
  recheck: 'recheck_review',
};

const REPLACEABLE_STATUS_BY_STAGE: Record<
  SystemMonthlyReportStage,
  SystemMonthlyReportRoomStatus[]
> = {
  initial: ['initial_review', 'recheck_pending', 'recheck_review'],
  recheck: ['recheck_review', 'final_pending'],
  final: ['completed'],
};

const DELETABLE_STATUS_BY_STAGE: Record<
  SystemMonthlyReportStage,
  SystemMonthlyReportRoomStatus[]
> = {
  initial: ['initial_review'],
  recheck: ['recheck_review'],
  final: ['completed'],
};

export function getSystemMonthlyReportEditCutoff(
  reportYear: number,
  reportMonth: number,
): Date {
  if (
    !Number.isInteger(reportYear) ||
    reportYear < 2020 ||
    reportYear > 2100 ||
    !Number.isInteger(reportMonth) ||
    reportMonth < 1 ||
    reportMonth > 12
  ) {
    throw new BadRequestException('月报报告期无效');
  }
  return new Date(Date.UTC(reportYear, reportMonth, 14, 16));
}

export function isSystemMonthlyReportEditWindowOpen(
  reportYear: number,
  reportMonth: number,
  now = new Date(),
): boolean {
  return (
    now.getTime() <
    getSystemMonthlyReportEditCutoff(reportYear, reportMonth).getTime()
  );
}

export function assertSystemMonthlyReportSubmissionMutationAllowed(
  status: SystemMonthlyReportRoomStatus,
  stage: SystemMonthlyReportStage,
  operation: 'create' | 'replace' | 'delete',
  reportYear: number,
  reportMonth: number,
  now = new Date(),
): void {
  if (!isSystemMonthlyReportEditWindowOpen(reportYear, reportMonth, now)) {
    throw new BadRequestException('本月月报修改期限已截止');
  }
  if (operation === 'create') {
    assertSystemMonthlyReportSubmissionTransition(status, stage);
    return;
  }
  const allowed =
    operation === 'replace'
      ? REPLACEABLE_STATUS_BY_STAGE[stage]
      : DELETABLE_STATUS_BY_STAGE[stage];
  if (!allowed.includes(status)) {
    throw new BadRequestException(
      operation === 'replace'
        ? '该版本已被后续审核结果锁定，不能替换'
        : '该版本已被后续流程使用，不能删除',
    );
  }
}

export function assertSystemMonthlyReportSubmissionTransition(
  status: SystemMonthlyReportRoomStatus,
  stage: SystemMonthlyReportStage,
): void {
  if (status !== SUBMISSION_STATUS_BY_STAGE[stage]) {
    throw new BadRequestException('当前月报状态不允许提交该版本，请刷新后重试');
  }
}

export function assertSystemMonthlyReportReviewTransition(
  status: SystemMonthlyReportRoomStatus,
  round: SystemMonthlyReportReviewRound,
): void {
  if (status !== REVIEW_STATUS_BY_ROUND[round]) {
    throw new BadRequestException(
      '当前月报状态不允许提交该轮审核，请刷新后重试',
    );
  }
}

export function buildSystemMonthlyReportSubmissionFields(
  request: SystemMonthlyReportSubmissionRequest,
  attachmentTokens: string[],
): BitableFields {
  validateSystemMonthlyReportSubmission(request);
  if (!attachmentTokens.length) {
    throw new BadRequestException('月报附件不能为空');
  }
  return {
    机房: request.room.trim(),
    月报月份: request.reportMonth,
    [SUBMISSION_ATTACHMENT_FIELDS[request.stage]]: attachmentTokens.map(
      (fileToken) => ({ file_token: fileToken }),
    ),
  };
}

export function buildSystemMonthlyReportSubmissionClearFields(
  stage: SystemMonthlyReportStage,
): BitableFields {
  return { [SUBMISSION_ATTACHMENT_FIELDS[stage]]: [] };
}

export function validateSystemMonthlyReportSubmission(
  request: SystemMonthlyReportSubmissionRequest,
): void {
  const room = request.room?.trim();
  if (!room) throw new BadRequestException('机房不能为空');
  if (
    !Number.isInteger(request.reportYear) ||
    request.reportYear < 2020 ||
    request.reportYear > 2100 ||
    !Number.isInteger(request.reportMonth) ||
    request.reportMonth < 1 ||
    request.reportMonth > 12
  ) {
    throw new BadRequestException('月报报告期无效');
  }
  const match = /^(.*)(\.[a-zA-Z0-9]{1,8})$/u.exec(
    request.versionedFileName?.trim() || '',
  );
  const expectedFileName = buildSystemMonthlyReportVersionedFileName(
    room,
    request.reportYear,
    request.reportMonth,
    request.stage,
    request.versionedFileName || '',
  );
  if (
    !match ||
    request.versionedFileName !== expectedFileName ||
    !['.xlsx', '.xls', '.pdf'].includes(match[2].toLowerCase())
  ) {
    throw new BadRequestException('月报附件版本文件名与报告期或阶段不一致');
  }
}

export function normalizeSystemMonthlyReportSubmission(
  request: SystemMonthlyReportSubmissionRequest,
  originalFileName: string,
): {
  request: SystemMonthlyReportSubmissionRequest;
  fileName: string;
} {
  const room = request.room.trim();
  const fileName = buildSystemMonthlyReportVersionedFileName(
    room,
    request.reportYear,
    request.reportMonth,
    request.stage,
    originalFileName,
  );
  return {
    request: { ...request, room, versionedFileName: fileName },
    fileName,
  };
}

export function validateSystemMonthlyReportReview(
  request: SystemMonthlyReportReviewRequest,
  screenshotFiles: ModuleFiles,
): void {
  if (!request.completed) {
    throw new BadRequestException('请确认已完成全部审核项');
  }
  if (!request.currentRecordId?.trim() || !request.room?.trim()) {
    throw new BadRequestException('审核关联和机房不能为空');
  }
  for (const key of MODULE_KEYS) {
    const module = request.modules?.[key];
    if (!module)
      throw new BadRequestException(`缺少${MODULE_LABELS[key]}审核项`);
    if (!module.hasIssue) continue;
    if (!module.description?.trim()) {
      throw new BadRequestException(`${MODULE_LABELS[key]}的问题描述不能为空`);
    }
    if (!screenshotFiles[key]?.length) {
      throw new BadRequestException(`${MODULE_LABELS[key]}的问题截图不能为空`);
    }
  }
}

export function buildSystemMonthlyReportReviewFields(
  request: SystemMonthlyReportReviewRequest,
  screenshotTokens: ModuleFiles,
): BitableFields {
  validateSystemMonthlyReportReview(request, screenshotTokens);
  const prefix = request.round === 'initial' ? '初审' : '复审';
  const fields: BitableFields = {
    机房: request.room.trim(),
    审核关联: [request.currentRecordId.trim()],
  };
  const summaries: string[] = [];
  const aggregateTokens: string[] = [];

  for (const key of MODULE_KEYS) {
    const module = request.modules[key];
    const suffixes = REVIEW_FIELD_SUFFIXES[key];
    fields[`${prefix}：${suffixes.issue}`] = module.hasIssue ? '是' : '否';
    if (!module.hasIssue) continue;
    const description = module.description.trim();
    const tokens = screenshotTokens[key] || [];
    fields[`${prefix}：${suffixes.description}`] = description;
    fields[`${prefix}：${suffixes.screenshot}`] = tokens.map((fileToken) => ({
      file_token: fileToken,
    }));
    summaries.push(`${MODULE_LABELS[key]}：${description}`);
    aggregateTokens.push(...tokens);
  }

  fields[`${prefix}意见`] = summaries.length
    ? summaries.join('\n')
    : '本轮审核未发现问题';
  if (aggregateTokens.length) {
    fields[`${prefix}问题截图`] = aggregateTokens.map((fileToken) => ({
      file_token: fileToken,
    }));
  }
  fields[`${prefix}确认提交`] = '是';
  if (request.round === 'initial') fields.初审审核 = true;
  return fields;
}

export function assertSystemMonthlyReportSemanticReadback(
  expected: BitableFields,
  actual: BitableFields,
): void {
  for (const [fieldName, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[fieldName];
    const matches = isAttachmentValue(expectedValue)
      ? sameSet(attachmentTokens(expectedValue), attachmentTokens(actualValue))
      : fieldName === '审核关联'
        ? sameSet(relationIds(expectedValue), relationIds(actualValue))
        : typeof expectedValue === 'boolean'
          ? Boolean(actualValue) === expectedValue
          : textValues(actualValue).includes(String(expectedValue));
    if (!matches) {
      throw new Error(`飞书语义回读校验失败：${fieldName}`);
    }
  }
}

function isAttachmentValue(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && typeof item.file_token === 'string')
  );
}

function attachmentTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      isRecord(item) && typeof item.file_token === 'string'
        ? item.file_token
        : '',
    )
    .filter(Boolean);
}

function relationIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (!isRecord(item)) return [];
      const id = item.record_id || item.recordId || item.id;
      return typeof id === 'string' ? [id] : [];
    })
    .filter(Boolean);
}

function textValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (!isRecord(value)) return [];
  for (const key of ['text', 'name', 'value']) {
    if (value[key] !== undefined) return textValues(value[key]);
  }
  return [];
}

function sameSet(left: string[], right: string[]): boolean {
  const a = Array.from(new Set(left)).sort();
  const b = Array.from(new Set(right)).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
