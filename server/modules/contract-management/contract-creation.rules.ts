import type {
  ContractCreateFieldDefinition,
  ContractCreateKind,
  ContractCreateRequest,
  ContractCreateValue,
} from '../../../shared/contract-management.interface';

export interface BitableFieldMeta {
  field_id: string;
  field_name: string;
  type: number;
  ui_type?: string;
  is_hidden?: boolean;
  property?: {
    multiple?: boolean;
    table_id?: string;
    options?: Array<{ name?: string }>;
  };
}

export interface ContractRecordRelations {
  supplierRecordId?: string;
  frameworkRecordId?: string;
  frameworkLabel?: string;
  attachmentTokens: string[];
}

const READ_ONLY_TYPES = new Set([
  19, 20, 24, 1001, 1002, 1003, 1004, 1005, 3001,
]);

const INTERNAL_FIELDS: Record<ContractCreateKind, ReadonlySet<string>> = {
  framework: new Set(['01-执行合同信息', '框架合同编码', '框架合同状态']),
  execution: new Set([
    '签订状态',
    '供应商',
    '合同公司',
    '付款计划',
    '父记录',
    '父记录 2',
    '关联框架合同',
    '专业示例人员001',
    '框架引用',
    '合同到期处置',
    '付款与合同差异核验时间',
    '付款与合同差异核验指纹',
  ]),
};

const REQUIRED_FIELDS: Record<ContractCreateKind, ReadonlySet<string>> = {
  framework: new Set([
    '合同编号',
    '合同名称',
    '合同类型',
    '合同开始日期',
    '合同结束日期',
    '合同附件',
  ]),
  execution: new Set([
    '合同编号',
    '合同名称',
    '跟进人',
    '合同类型',
    '合同金额',
    '合同开始日期',
    '合同结束日期',
    '合同附件',
    '专业类别',
  ]),
};

const SUPPLIER_REQUIRED_FIELDS = new Set(['公司单位']);

export function buildContractCreateDefinition(
  kind: ContractCreateKind,
  fields: BitableFieldMeta[],
): ContractCreateFieldDefinition[] {
  return fields.flatMap((field) => {
    if (
      !isWritableFormField(field) ||
      INTERNAL_FIELDS[kind].has(field.field_name)
    ) {
      return [];
    }
    return [toDefinition(field, REQUIRED_FIELDS[kind].has(field.field_name))];
  });
}

export function buildSupplierCreateDefinition(
  fields: BitableFieldMeta[],
): ContractCreateFieldDefinition[] {
  return fields.flatMap((field) => {
    if (!isWritableFormField(field) || field.field_name === '关联合同编号') {
      return [];
    }
    return [
      toDefinition(field, SUPPLIER_REQUIRED_FIELDS.has(field.field_name)),
    ];
  });
}

export function buildContractRecordFields(
  request: ContractCreateRequest,
  definition: ContractCreateFieldDefinition[],
  relations: ContractRecordRelations,
): Record<string, unknown> {
  const result = buildFields(request.fields, definition);
  const attachmentField = definition.find(
    (field) => field.control === 'attachment',
  );
  if (!attachmentField) {
    throw new Error('目标合同表缺少合同附件字段');
  }
  const attachmentTokens = dedupe(relations.attachmentTokens.map(clean));
  if (!attachmentTokens.length) {
    throw new Error('合同附件不能为空');
  }
  result[attachmentField.name] = attachmentTokens.map((fileToken) => ({
    file_token: fileToken,
  }));

  if (request.kind === 'execution') {
    const supplierRecordId = clean(relations.supplierRecordId);
    if (!supplierRecordId) throw new Error('供应商不能为空');
    result['供应商'] = [supplierRecordId];

    if (request.linkFramework) {
      const frameworkRecordId = clean(relations.frameworkRecordId);
      if (!frameworkRecordId) throw new Error('请选择生效的框架合同');
      result['框架引用'] = [frameworkRecordId];
      const frameworkLabel = clean(relations.frameworkLabel);
      if (frameworkLabel) result['关联框架合同'] = frameworkLabel;
    }
  }

  validateContractDates(result);
  return result;
}

export function buildSupplierRecordFields(
  values: Record<string, ContractCreateValue>,
  definition: ContractCreateFieldDefinition[],
): Record<string, unknown> {
  return buildFields(values, definition);
}

export function buildContractEditFields(
  values: Record<string, ContractCreateValue>,
  definition: ContractCreateFieldDefinition[],
  supplierRecordId: string,
): Record<string, unknown> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('合同编辑字段格式无效');
  }
  const editableFields = definition.filter(
    (field) => field.control !== 'attachment',
  );
  const allowedFieldIds = new Set(editableFields.map((field) => field.fieldId));
  const unknownFieldId = Object.keys(values).find(
    (fieldId) => !allowedFieldIds.has(fieldId),
  );
  if (unknownFieldId) throw new Error('存在不允许编辑的合同字段');

  const result: Record<string, unknown> = {};
  for (const field of editableFields) {
    const value = values[field.fieldId];
    if (isEmpty(value)) {
      if (field.required) throw new Error(`${field.name}不能为空`);
      result[field.name] = null;
      continue;
    }
    result[field.name] = toCellValue(field, value);
  }

  const normalizedSupplierRecordId = clean(supplierRecordId);
  if (!normalizedSupplierRecordId) throw new Error('供应商不能为空');
  result['供应商'] = [normalizedSupplierRecordId];
  validateContractDates(result);
  return result;
}

export function buildContractPartialEditFields(
  values: Record<string, ContractCreateValue>,
  definition: ContractCreateFieldDefinition[],
): Record<string, unknown> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('合同编辑字段格式无效');
  }
  const editableFields = definition.filter(
    (field) => field.control !== 'attachment',
  );
  const fieldById = new Map(
    editableFields.map((field) => [field.fieldId, field]),
  );
  const unknownFieldId = Object.keys(values).find(
    (fieldId) => !fieldById.has(fieldId),
  );
  if (unknownFieldId) throw new Error('存在不允许编辑的合同字段');

  const result: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(values)) {
    const field = fieldById.get(fieldId);
    if (!field) continue;
    if (isEmpty(value)) {
      if (field.required) throw new Error(`${field.name}不能为空`);
      result[field.name] = null;
      continue;
    }
    result[field.name] = toCellValue(field, value);
  }
  return result;
}

export function readContractEditValues(
  fields: Record<string, unknown>,
  definition: ContractCreateFieldDefinition[],
): Record<string, ContractCreateValue> {
  return Object.fromEntries(
    definition
      .filter((field) => field.control !== 'attachment')
      .map((field) => [
        field.fieldId,
        fromCellValue(field, fields?.[field.name]),
      ]),
  );
}

export function readLinkedRecordId(value: unknown): string {
  return linkedRecordIds(value)[0] || '';
}

function buildFields(
  values: Record<string, ContractCreateValue>,
  definition: ContractCreateFieldDefinition[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of definition) {
    if (field.control === 'attachment') continue;
    const value = values[field.fieldId];
    if (isEmpty(value)) {
      if (field.required) throw new Error(`${field.name}不能为空`);
      continue;
    }
    result[field.name] = toCellValue(field, value);
  }
  return result;
}

function toCellValue(
  field: ContractCreateFieldDefinition,
  value: ContractCreateValue,
): unknown {
  switch (field.control) {
    case 'text':
      return clean(value);
    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed))
        throw new Error(`${field.name}必须是有效数字`);
      return parsed;
    }
    case 'select': {
      const selected = clean(value);
      assertSelectOption(field, selected);
      return selected;
    }
    case 'multiselect': {
      if (!Array.isArray(value))
        throw new Error(`${field.name}必须选择有效选项`);
      const selected = dedupe(value.map(clean));
      for (const item of selected) assertSelectOption(field, item);
      return selected;
    }
    case 'date': {
      const selected = clean(value);
      if (!isValidCalendarDate(selected)) {
        throw new Error(`${field.name}必须是有效日期`);
      }
      const timestamp = Date.parse(`${selected}T00:00:00+08:00`);
      if (!Number.isFinite(timestamp))
        throw new Error(`${field.name}必须是有效日期`);
      return timestamp;
    }
    case 'user': {
      const openIds = Array.isArray(value) ? value.map(clean) : [clean(value)];
      const normalized = dedupe(openIds);
      if (!normalized.every((item) => /^ou_[A-Za-z0-9]+$/.test(item))) {
        throw new Error(`${field.name}人员标识无效`);
      }
      return normalized.map((id) => ({ id }));
    }
    case 'checkbox':
      if (typeof value !== 'boolean')
        throw new Error(`${field.name}必须选择是或否`);
      return value;
    case 'attachment':
      throw new Error('附件必须通过安全上传流程写入');
  }
}

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function fromCellValue(
  field: ContractCreateFieldDefinition,
  value: unknown,
): ContractCreateValue {
  switch (field.control) {
    case 'number': {
      const parsed =
        typeof value === 'number' ? value : Number(cellText(value));
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'multiselect':
      return cellTexts(value);
    case 'date':
      return dateCellValue(value);
    case 'user': {
      const ids = userIds(value);
      return field.multiple ? ids : ids[0] || '';
    }
    case 'checkbox':
      return Boolean(value);
    case 'attachment':
      return null;
    default:
      return cellText(value);
  }
}

function assertSelectOption(
  field: ContractCreateFieldDefinition,
  selected: string,
): void {
  if (!field.options.some((option) => option.value === selected)) {
    throw new Error(`${field.name}不是多维表已有选项`);
  }
}

function toDefinition(
  field: BitableFieldMeta,
  required: boolean,
): ContractCreateFieldDefinition {
  const control = controlForField(field);
  return {
    fieldId: field.field_id,
    name: field.field_name,
    control,
    required,
    multiple: Boolean(field.property?.multiple || field.type === 4),
    group: groupForField(field.field_name, control),
    inputType: inputTypeForField(field),
    options: (field.property?.options || []).flatMap((option) => {
      const name = clean(option.name);
      return name ? [{ value: name, label: name }] : [];
    }),
  };
}

function isWritableFormField(field: BitableFieldMeta): boolean {
  if (
    !clean(field.field_id) ||
    !clean(field.field_name) ||
    field.is_hidden ||
    READ_ONLY_TYPES.has(field.type)
  ) {
    return false;
  }
  return [1, 2, 3, 4, 5, 7, 11, 13, 15, 17].includes(field.type);
}

function controlForField(
  field: BitableFieldMeta,
): ContractCreateFieldDefinition['control'] {
  switch (field.type) {
    case 2:
      return 'number';
    case 3:
      return 'select';
    case 4:
      return 'multiselect';
    case 5:
      return 'date';
    case 7:
      return 'checkbox';
    case 11:
      return 'user';
    case 17:
      return 'attachment';
    default:
      return 'text';
  }
}

function inputTypeForField(
  field: BitableFieldMeta,
): ContractCreateFieldDefinition['inputType'] {
  if (field.type === 13 || /电话|手机/.test(field.field_name)) return 'tel';
  if (/邮箱|邮件/.test(field.field_name)) return 'email';
  if (field.type === 15 || /链接|网址/.test(field.field_name)) return 'url';
  return 'text';
}

function groupForField(
  name: string,
  control: ContractCreateFieldDefinition['control'],
): ContractCreateFieldDefinition['group'] {
  if (control === 'attachment') return 'attachment';
  if (/金额|签报|开始日期|结束日期/.test(name)) return 'commercial';
  if (/供应商|框架|关联|对接/.test(name)) return 'relationship';
  if (/合同编号|合同名称|合同类型|跟进人|专业类别/.test(name)) {
    return 'basic';
  }
  return 'other';
}

function validateContractDates(fields: Record<string, unknown>): void {
  const start = Number(fields['合同开始日期']);
  const end = Number(fields['合同结束日期']);
  if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
    throw new Error('合同结束日期不能早于开始日期');
  }
}

function isEmpty(value: ContractCreateValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value))
    return value.map(cellText).filter(Boolean).join('、');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  for (const key of ['text', 'name', 'value']) {
    const result = cellText(item[key]);
    if (result) return result;
  }
  return '';
}

function cellTexts(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return dedupe(
    values.flatMap((item) => cellText(item).split('、')).map(clean),
  );
}

function userIds(value: unknown): string[] {
  if (Array.isArray(value)) return dedupe(value.flatMap(userIds));
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  const id = [item.id, item.open_id].find(
    (entry): entry is string =>
      typeof entry === 'string' && /^ou_[A-Za-z0-9]+$/.test(entry),
  );
  return id ? [id] : [];
}

function linkedRecordIds(value: unknown): string[] {
  if (typeof value === 'string') return clean(value) ? [clean(value)] : [];
  if (Array.isArray(value)) return dedupe(value.flatMap(linkedRecordIds));
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (Array.isArray(item.record_ids)) {
    return dedupe(item.record_ids.map(clean));
  }
  return [item.record_id, item.id].map(clean).filter(Boolean);
}

function dateCellValue(value: unknown): string {
  const date =
    typeof value === 'number' && Number.isFinite(value)
      ? new Date(value)
      : new Date(cellText(value));
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
