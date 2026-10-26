import type {
  WeatherGuardRegistrationRequest,
  WeatherGuardRegistrationStatus,
  WeatherWarningBuilding,
  WeatherWarningGuardLevel,
} from '@shared/api.interface';

export const WEATHER_GUARD_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
] as const satisfies readonly WeatherWarningBuilding[];

export interface WeatherGuardRegistrationAttachmentCounts {
  device: number;
  disaster: number;
  environment?: number;
}

export interface WeatherGuardRegistrationValidationContext {
  guardLevel: WeatherWarningGuardLevel;
  environmentRequired: boolean;
  attachmentCounts: WeatherGuardRegistrationAttachmentCounts;
}

export interface WeatherGuardRegistrationValidationIssue {
  field: string;
  message: string;
}

export interface WeatherGuardRegistrationAttachmentTokens {
  device: string;
  disaster: string;
  environment?: string;
}

export interface WeatherGuardRegistrationBuildContext {
  submittedAt: Date;
  guardLevel: WeatherWarningGuardLevel;
  tag: string;
  checkerOpenIds: readonly string[];
  managerOpenIds: readonly string[];
  environmentRequired: boolean;
  attachmentTokens: WeatherGuardRegistrationAttachmentTokens;
}

export interface WeatherGuardRegistrationUserCell {
  id: string;
}

export interface WeatherGuardRegistrationAttachmentCell {
  file_token: string;
}

export interface WeatherGuardRegistrationFields {
  日期: number;
  检查人: WeatherGuardRegistrationUserCell[];
  机房经理: WeatherGuardRegistrationUserCell[];
  重保戒备等级: WeatherWarningGuardLevel;
  检查设备安全项: WeatherGuardRegistrationStatus;
  设备安全检查纸质图片: WeatherGuardRegistrationAttachmentCell[];
  设备异常描述: string;
  检查灾害专项: WeatherGuardRegistrationStatus;
  灾害专项检查纸质图片: WeatherGuardRegistrationAttachmentCell[];
  灾害异常描述: string;
  检查环境安全项?: WeatherGuardRegistrationStatus;
  环境安全检查纸质图片?: WeatherGuardRegistrationAttachmentCell[];
  环境异常描述?: string;
  检查重保物资清单正常: WeatherGuardRegistrationStatus;
  重保物资异常描述: string;
  检查重保联络清单人员齐备: WeatherGuardRegistrationStatus;
  联络清单异常描述: string;
  楼栋: WeatherWarningBuilding;
  重保标签: string;
  机房经理确认: '已确认';
}

export class WeatherGuardRegistrationRuleError extends Error {
  constructor(
    public readonly issues: readonly WeatherGuardRegistrationValidationIssue[],
  ) {
    super(issues.map(({ message }) => message).join('；'));
    this.name = 'WeatherGuardRegistrationRuleError';
  }
}

const BUILDING_SET = new Set<string>(WEATHER_GUARD_BUILDINGS);
const GUARD_LEVEL_SET = new Set<string>(['一级戒备', '二级戒备', '三级戒备']);
const STATUS_SET = new Set<string>(['正常', '异常']);
const RFC_4122_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/u;
const REQUEST_FIELDS = new Set<string>([
  'clientMutationId',
  'warningId',
  'building',
  'checkerKeys',
  'deviceStatus',
  'deviceAbnormalDescription',
  'disasterStatus',
  'disasterAbnormalDescription',
  'environmentStatus',
  'environmentAbnormalDescription',
  'materialsStatus',
  'materialsAbnormalDescription',
  'contactsStatus',
  'contactsAbnormalDescription',
]);

export function validateWeatherGuardRegistration(
  request: unknown,
  context: WeatherGuardRegistrationValidationContext,
): WeatherGuardRegistrationValidationIssue[] {
  if (!isPlainRecord(request)) {
    return [{ field: 'request', message: '登记请求必须是对象' }];
  }

  const issues: WeatherGuardRegistrationValidationIssue[] = [];
  for (const field of Object.keys(request)) {
    if (!REQUEST_FIELDS.has(field)) {
      issues.push({
        field,
        message: `客户端包含不允许的字段：${field}`,
      });
    }
  }

  if (
    typeof request.clientMutationId !== 'string' ||
    !RFC_4122_UUID_PATTERN.test(request.clientMutationId)
  ) {
    addIssue(
      issues,
      'clientMutationId',
      'clientMutationId 必须是 RFC 4122 UUID',
    );
  }
  if (!isNonBlankString(request.warningId)) {
    addIssue(issues, 'warningId', '预警 ID 不能为空');
  }
  if (
    typeof request.building !== 'string' ||
    !BUILDING_SET.has(request.building)
  ) {
    addIssue(issues, 'building', '楼栋不在允许范围内');
  }
  if (!isValidPersonnelKeys(request.checkerKeys, true)) {
    addIssue(issues, 'checkerKeys', '检查人键必须是非空字符串数组');
  }
  validateStatusAndDescription(
    issues,
    request,
    'deviceStatus',
    'deviceAbnormalDescription',
  );
  validateStatusAndDescription(
    issues,
    request,
    'disasterStatus',
    'disasterAbnormalDescription',
  );
  validateStatusAndDescription(
    issues,
    request,
    'materialsStatus',
    'materialsAbnormalDescription',
  );
  validateStatusAndDescription(
    issues,
    request,
    'contactsStatus',
    'contactsAbnormalDescription',
  );

  const guardLevel = context?.guardLevel;
  if (!GUARD_LEVEL_SET.has(guardLevel)) {
    addIssue(issues, 'guardLevel', '服务端戒备等级无效');
  }
  const environmentRequired = context?.environmentRequired;
  if (typeof environmentRequired !== 'boolean') {
    addIssue(
      issues,
      'environmentRequired',
      '服务端环境检查范围无效',
    );
  }
  if (environmentRequired === true) {
    validateStatusAndDescription(
      issues,
      request,
      'environmentStatus',
      'environmentAbnormalDescription',
    );
  }

  const attachmentCounts = context?.attachmentCounts;
  if (!hasAttachment(attachmentCounts?.device)) {
    addIssue(issues, 'deviceImage', '设备安全检查附件不能为空');
  }
  if (!hasAttachment(attachmentCounts?.disaster)) {
    addIssue(issues, 'disasterImage', '灾害专项检查附件不能为空');
  }
  if (
    environmentRequired === true &&
    !hasAttachment(attachmentCounts?.environment)
  ) {
    addIssue(issues, 'environmentImage', '环境安全检查附件不能为空');
  }

  return issues;
}

export function buildWeatherGuardRegistrationFields(
  request: WeatherGuardRegistrationRequest,
  context: WeatherGuardRegistrationBuildContext,
): WeatherGuardRegistrationFields {
  validateBuildContext(context);

  const environmentRequired = context.environmentRequired;
  const issues = validateWeatherGuardRegistration(request, {
    guardLevel: context.guardLevel,
    environmentRequired,
    attachmentCounts: {
      device: 1,
      disaster: 1,
      environment: environmentRequired ? 1 : 0,
    },
  });
  if (issues.length > 0) {
    throw new WeatherGuardRegistrationRuleError(issues);
  }

  const fields: WeatherGuardRegistrationFields = {
    日期: context.submittedAt.getTime(),
    检查人: context.checkerOpenIds.map((id) => ({ id })),
    机房经理: context.managerOpenIds.map((id) => ({ id })),
    重保戒备等级: context.guardLevel,
    检查设备安全项: request.deviceStatus,
    设备安全检查纸质图片: [
      { file_token: clean(context.attachmentTokens.device) },
    ],
    设备异常描述: clean(request.deviceAbnormalDescription),
    检查灾害专项: request.disasterStatus,
    灾害专项检查纸质图片: [
      { file_token: clean(context.attachmentTokens.disaster) },
    ],
    灾害异常描述: clean(request.disasterAbnormalDescription),
    检查重保物资清单正常: request.materialsStatus,
    重保物资异常描述: clean(request.materialsAbnormalDescription),
    检查重保联络清单人员齐备: request.contactsStatus,
    联络清单异常描述: clean(request.contactsAbnormalDescription),
    楼栋: request.building,
    重保标签: clean(context.tag),
    机房经理确认: '已确认',
  };

  if (environmentRequired) {
    fields.检查环境安全项 = request.environmentStatus!;
    fields.环境安全检查纸质图片 = [
      { file_token: clean(context.attachmentTokens.environment) },
    ];
    fields.环境异常描述 = clean(request.environmentAbnormalDescription);
  }

  return fields;
}

function validateBuildContext(
  context: WeatherGuardRegistrationBuildContext,
): void {
  const issues: WeatherGuardRegistrationValidationIssue[] = [];
  const submittedAt = context?.submittedAt;
  if (
    !(submittedAt instanceof Date) ||
    !Number.isFinite(submittedAt.getTime())
  ) {
    addIssue(issues, 'submittedAt', '服务端提交日期无效');
  }
  if (!GUARD_LEVEL_SET.has(context?.guardLevel)) {
    addIssue(issues, 'guardLevel', '服务端戒备等级无效');
  }
  if (!isNonBlankString(context?.tag)) {
    addIssue(issues, 'tag', '服务端重保标签不能为空');
  }
  if (!isValidOpenIds(context?.checkerOpenIds, true)) {
    addIssue(issues, 'checkerOpenIds', '检查人 open_id 无效');
  }
  if (
    !Array.isArray(context?.managerOpenIds) ||
    context.managerOpenIds.length !== 2 ||
    !isValidOpenIds(context.managerOpenIds, true)
  ) {
    addIssue(
      issues,
      'managerOpenIds',
      '机房经理必须恰好两名且 open_id 唯一有效',
    );
  }
  if (typeof context?.environmentRequired !== 'boolean') {
    addIssue(
      issues,
      'environmentRequired',
      '服务端环境检查范围无效',
    );
  }

  const tokens = context?.attachmentTokens;
  if (!isNonBlankString(tokens?.device)) {
    addIssue(issues, 'deviceImage', '设备附件 token 不能为空');
  }
  if (!isNonBlankString(tokens?.disaster)) {
    addIssue(issues, 'disasterImage', '灾害附件 token 不能为空');
  }
  if (
    context?.environmentRequired === true &&
    !isNonBlankString(tokens?.environment)
  ) {
    addIssue(issues, 'environmentImage', '环境附件 token 不能为空');
  }

  if (issues.length > 0) {
    throw new WeatherGuardRegistrationRuleError(issues);
  }
}

function validateStatusAndDescription(
  issues: WeatherGuardRegistrationValidationIssue[],
  request: Record<string, unknown>,
  statusField: string,
  descriptionField: string,
): void {
  const status = request[statusField];
  if (!isRegistrationStatus(status)) {
    addIssue(issues, statusField, `${statusField} 必须是“正常”或“异常”`);
  }
  validateDescription(issues, request, status, descriptionField);
}

function validateDescription(
  issues: WeatherGuardRegistrationValidationIssue[],
  request: Record<string, unknown>,
  status: unknown,
  descriptionField: string,
): void {
  const description = request[descriptionField];
  if (description !== undefined && typeof description !== 'string') {
    addIssue(issues, descriptionField, `${descriptionField} 必须是字符串`);
    return;
  }
  if (status === '异常' && !isNonBlankString(description)) {
    addIssue(issues, descriptionField, '状态为异常时必须填写异常描述');
  }
}

function isRegistrationStatus(
  value: unknown,
): value is WeatherGuardRegistrationStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

function isValidPersonnelKeys(value: unknown, required: boolean): boolean {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    return false;
  }
  if (!value.every(isNonBlankString)) {
    return false;
  }
  return true;
}

function isValidOpenIds(value: unknown, required: boolean): boolean {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    return false;
  }
  if (
    !value.every(
      (item) => typeof item === 'string' && OPEN_ID_PATTERN.test(item),
    )
  ) {
    return false;
  }
  return new Set(value).size === value.length;
}

function hasAttachment(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addIssue(
  issues: WeatherGuardRegistrationValidationIssue[],
  field: string,
  message: string,
): void {
  issues.push({ field, message });
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
