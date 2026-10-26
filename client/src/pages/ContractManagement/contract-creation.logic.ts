import type {
  ContractCreatePaymentPlanInput,
  ContractCreateFrameworkOption,
  ContractCreateKind,
  ContractCreateOptionsResponse,
  ContractCreateRequest,
  ContractCreateSupplierOption,
  ContractCreateValue,
} from '@shared/contract-management.interface';
import { CONTRACT_PAYMENT_PERIODS } from '../../../../shared/contract-field-config';

export interface ContractCreatePaymentPlanDraft {
  period: string;
  plannedAmount: number | '';
  plannedPaymentDate: string;
  ownerOpenId: string;
}

export interface ContractCreateDraft {
  kind: ContractCreateKind;
  fields: Record<string, ContractCreateValue>;
  linkFramework: boolean;
  frameworkRecordId: string;
  supplierMode: 'existing' | 'create';
  supplierRecordId: string;
  supplierFields: Record<string, ContractCreateValue>;
  paymentPlans: ContractCreatePaymentPlanDraft[];
  attachments: File[];
}

export interface ContractCreateValidationError {
  path: string;
  message: string;
}

export function createEmptyContractDraft(
  kind: ContractCreateKind,
): ContractCreateDraft {
  return {
    kind,
    fields: {},
    linkFramework: false,
    frameworkRecordId: '',
    supplierMode: 'existing',
    supplierRecordId: '',
    supplierFields: {},
    paymentPlans: kind === 'execution' ? [createEmptyPaymentPlan()] : [],
    attachments: [],
  };
}

export function fuzzyContractOptions(
  items: ContractCreateFrameworkOption[],
  query: string,
): ContractCreateFrameworkOption[] {
  return fuzzyOptions(items, query, (item) => `${item.code} ${item.name}`);
}

export function fuzzySupplierOptions(
  items: ContractCreateSupplierOption[],
  query: string,
): ContractCreateSupplierOption[] {
  return fuzzyOptions(items, query, (item) => item.name);
}

export function validateContractDraft(
  draft: ContractCreateDraft,
  options: ContractCreateOptionsResponse,
): ContractCreateValidationError[] {
  const errors: ContractCreateValidationError[] = [];
  for (const field of options.fields) {
    if (field.control === 'attachment') continue;
    if (field.required && empty(draft.fields[field.fieldId])) {
      errors.push({
        path: `fields.${field.fieldId}`,
        message: `${field.name}不能为空`,
      });
    }
  }

  if (draft.kind === 'execution') {
    if (draft.linkFramework && !draft.frameworkRecordId) {
      errors.push({
        path: 'frameworkRecordId',
        message: '请选择生效的框架合同',
      });
    }
    if (draft.supplierMode === 'existing' && !draft.supplierRecordId) {
      errors.push({ path: 'supplierRecordId', message: '请选择供应商' });
    }
    if (draft.supplierMode === 'create') {
      for (const field of options.supplierFields) {
        if (field.required && empty(draft.supplierFields[field.fieldId])) {
          errors.push({
            path: `supplierFields.${field.fieldId}`,
            message: `${field.name}不能为空`,
          });
        }
      }
    }
    errors.push(...validatePaymentPlanDrafts(draft.paymentPlans));
  }

  if (!draft.attachments.length) {
    errors.push({ path: 'attachments', message: '请上传合同 PDF 附件' });
  } else if (draft.attachments.length > options.upload.maxFiles) {
    errors.push({
      path: 'attachments',
      message: `合同附件最多上传 ${options.upload.maxFiles} 个`,
    });
  } else {
    const invalid = draft.attachments.find(
      (file) =>
        file.type !== options.upload.accept ||
        !file.name.toLowerCase().endsWith('.pdf') ||
        file.size > options.upload.maxFileSize,
    );
    if (invalid) {
      errors.push({
        path: 'attachments',
        message: '附件仅支持 20MB 以内的 PDF 文件',
      });
    }
  }
  return errors;
}

export function validatePaymentPlanDrafts(
  paymentPlans: ContractCreatePaymentPlanDraft[],
): ContractCreateValidationError[] {
  const errors: ContractCreateValidationError[] = [];
  if (!paymentPlans.length) {
    errors.push({ path: 'paymentPlans', message: '请至少录入一条付款计划' });
  }
  paymentPlans.forEach((plan, index) => {
    const prefix = `paymentPlans.${index}`;
    if (!CONTRACT_PAYMENT_PERIODS.includes(plan.period as never)) {
      errors.push({ path: `${prefix}.period`, message: '请选择付款周期' });
    }
    if (
      typeof plan.plannedAmount !== 'number' ||
      !Number.isFinite(plan.plannedAmount) ||
      plan.plannedAmount <= 0
    ) {
      errors.push({
        path: `${prefix}.plannedAmount`,
        message: '计划付款金额必须大于 0',
      });
    }
    if (!validDate(plan.plannedPaymentDate)) {
      errors.push({
        path: `${prefix}.plannedPaymentDate`,
        message: '请选择有效的计划付款日期',
      });
    }
    if (!plan.ownerOpenId.trim()) {
      errors.push({ path: `${prefix}.ownerOpenId`, message: '请选择跟进人' });
    }
  });
  return errors;
}

export function buildContractCreateRequest(
  draft: ContractCreateDraft,
  idempotencyKey: string,
): ContractCreateRequest {
  return {
    kind: draft.kind,
    idempotencyKey,
    fields: draft.fields,
    supplier:
      draft.kind === 'execution'
        ? draft.supplierMode === 'existing'
          ? { mode: 'existing', recordId: draft.supplierRecordId }
          : { mode: 'create', fields: draft.supplierFields }
        : undefined,
    linkFramework: draft.kind === 'execution' && draft.linkFramework,
    frameworkRecordId:
      draft.kind === 'execution' && draft.linkFramework
        ? draft.frameworkRecordId
        : undefined,
    ...(draft.kind === 'execution'
      ? { paymentPlans: draft.paymentPlans.map(toPaymentPlanInput) }
      : {}),
  };
}

export function createEmptyPaymentPlan(): ContractCreatePaymentPlanDraft {
  return {
    period: '',
    plannedAmount: '',
    plannedPaymentDate: '',
    ownerOpenId: '',
  };
}

export function toPaymentPlanInput(
  plan: ContractCreatePaymentPlanDraft,
): ContractCreatePaymentPlanInput {
  return {
    period: plan.period.trim(),
    plannedAmount: Number(plan.plannedAmount),
    plannedPaymentDate: plan.plannedPaymentDate,
    ownerOpenId: plan.ownerOpenId.trim(),
  };
}

function validDate(value: string): boolean {
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

function fuzzyOptions<T>(
  items: T[],
  query: string,
  label: (item: T) => string,
): T[] {
  const needle = normalize(query);
  if (!needle) return items;
  return items.filter((item) => normalize(label(item)).includes(needle));
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[\s·_\-/]+/g, '');
}

function empty(value: ContractCreateValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  );
}
