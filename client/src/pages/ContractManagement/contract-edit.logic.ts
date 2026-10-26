import type {
  ContractCreateFieldDefinition,
  ContractCreateValue,
  ContractEditOptionsResponse,
  ContractEditRequest,
} from '@shared/contract-management.interface';

export interface ContractEditDraft {
  fields: Record<string, ContractCreateValue>;
  supplierRecordId: string;
}

export interface ContractEditValidationError {
  path: string;
  message: string;
}

export function createContractEditDraft(
  options: ContractEditOptionsResponse,
): ContractEditDraft {
  return {
    fields: Object.fromEntries(
      Object.entries(options.values).map(([fieldId, value]) => [
        fieldId,
        Array.isArray(value) ? [...value] : value,
      ]),
    ),
    supplierRecordId: options.supplierRecordId,
  };
}

export function validateContractEditDraft(
  draft: ContractEditDraft,
  options: ContractEditOptionsResponse,
): ContractEditValidationError[] {
  const errors: ContractEditValidationError[] = [];
  for (const field of options.fields) {
    const value = draft.fields[field.fieldId];
    const path = `fields.${field.fieldId}`;
    if (isEmpty(value)) {
      if (field.required)
        errors.push({ path, message: `${field.name}不能为空` });
      continue;
    }
    const message = validateField(field, value);
    if (message) errors.push({ path, message });
  }

  if (
    !draft.supplierRecordId ||
    !options.suppliers.some(
      (supplier) => supplier.recordId === draft.supplierRecordId,
    )
  ) {
    errors.push({ path: 'supplierRecordId', message: '请选择有效的供应商' });
  }

  const startField = options.fields.find(
    (field) => field.name === '合同开始日期',
  );
  const endField = options.fields.find(
    (field) => field.name === '合同结束日期',
  );
  const start = startField
    ? String(draft.fields[startField.fieldId] || '')
    : '';
  const end = endField ? String(draft.fields[endField.fieldId] || '') : '';
  if (start && end && end < start && endField) {
    errors.push({
      path: `fields.${endField.fieldId}`,
      message: '合同结束日期不能早于开始日期',
    });
  }
  return dedupeErrors(errors);
}

export function buildContractEditRequest(
  draft: ContractEditDraft,
  options: ContractEditOptionsResponse,
): ContractEditRequest {
  const fields = Object.fromEntries(
    options.fields.flatMap((field) => {
      const value = draft.fields[field.fieldId];
      if (sameValue(value, options.values[field.fieldId])) return [];
      return [
        [field.fieldId, Array.isArray(value) ? [...value] : (value ?? null)],
      ];
    }),
  );
  const supplierRecordId = draft.supplierRecordId.trim();
  return supplierRecordId === options.supplierRecordId
    ? { fields }
    : { fields, supplierRecordId };
}

function sameValue(
  left: ContractCreateValue | undefined,
  right: ContractCreateValue | undefined,
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return left === right;
}

function validateField(
  field: ContractCreateFieldDefinition,
  value: ContractCreateValue,
): string | null {
  if (field.control === 'number' && !Number.isFinite(Number(value))) {
    return `${field.name}必须是有效数字`;
  }
  if (field.control === 'date') {
    const text = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return `${field.name}必须是有效日期`;
    }
  }
  if (field.control === 'select') {
    const text = String(value);
    if (!field.options.some((option) => option.value === text)) {
      return `${field.name}不是有效选项`;
    }
  }
  if (field.control === 'user') {
    const ids = Array.isArray(value) ? value : [value];
    if (!ids.every((item) => /^ou_[A-Za-z0-9]+$/.test(String(item)))) {
      return `${field.name}人员标识无效`;
    }
  }
  return null;
}

function isEmpty(value: ContractCreateValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function dedupeErrors(
  errors: ContractEditValidationError[],
): ContractEditValidationError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    if (seen.has(error.path)) return false;
    seen.add(error.path);
    return true;
  });
}
