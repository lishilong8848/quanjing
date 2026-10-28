import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, FilePenLine, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { useAccess } from '@/access/AccessProvider';
import { businessBuildingLabels } from '@shared/business-permissions';
import { canUseContractAction, type ContractPermissionScope } from './contract-permissions';

import { getContractEditOptions, updateContractInformation } from '@/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type {
  ContractCreateFieldDefinition,
  ContractCreateValue,
  ContractEditOptionsResponse,
  ContractManagementItem,
} from '@shared/contract-management.interface';

import {
  buildContractEditRequest,
  createContractEditDraft,
  validateContractEditDraft,
  type ContractEditDraft,
} from './contract-edit.logic';

interface ContractEditDialogProps {
  contract: ContractManagementItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void | Promise<void>;
}

const groupLabels: Record<ContractCreateFieldDefinition['group'], string> = {
  basic: '合同基本信息',
  commercial: '商务与履约信息',
  relationship: '关联信息',
  attachment: '合同附件',
  other: '其他信息',
};

export function ContractEditDialog({
  contract,
  open,
  onOpenChange,
  onCompleted,
}: ContractEditDialogProps) {
  const access = useAccess();
  const canUpdateRecord = canUseContractAction(access, 'update', contract);
  const [options, setOptions] = useState<ContractEditOptionsResponse | null>(
    null,
  );
  const [draft, setDraft] = useState<ContractEditDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [loadError, setLoadError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const contractRecordId = contract?.recordId;
  const canSave = canUpdateRecord && canUseContractAction(access, 'update', contractEditPermissionScope(contract, draft, options));

  useEffect(() => {
    if (!open || !contractRecordId) return;
    if (!canUpdateRecord) { setLoading(false); setLoadError('当前账号无此合同的修改权限'); return; }
    let cancelled = false;
    setOptions(null);
    setDraft(null);
    setLoading(true);
    setSaving(false);
    setFeedback('正在读取合同当前信息');
    setLoadError('');
    setFieldErrors({});

    void getContractEditOptions(contractRecordId)
      .then((response) => {
        if (cancelled) return;
        if (response.contract.recordId !== contractRecordId) {
          throw new Error('返回的合同信息与当前合同不匹配，请重新打开');
        }
        setOptions(response);
        setDraft(createContractEditDraft(response));
        setFeedback('');
      })
      .catch((reason) => {
        if (cancelled) return;
        setLoadError(
          apiErrorMessage(reason, '合同当前信息读取失败，请稍后重试'),
        );
        setFeedback('');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [contractRecordId, open, canUpdateRecord]);

  const groups = useMemo(() => {
    if (!options) return [];
    return (['basic', 'commercial', 'relationship', 'other'] as const)
      .map((group) => ({
        group,
        fields: options.fields.filter((field) => field.group === group),
      }))
      .filter((item) => item.fields.length > 0);
  }, [options]);

  function updateField(fieldId: string, value: ContractCreateValue) {
    setDraft((current) =>
      current
        ? {
            ...current,
            fields: { ...current.fields, [fieldId]: value },
          }
        : current,
    );
    setFieldErrors((current) => clearError(current, `fields.${fieldId}`));
  }

  function updateSupplier(supplierRecordId: string) {
    setDraft((current) =>
      current ? { ...current, supplierRecordId } : current,
    );
    setFieldErrors((current) => clearError(current, 'supplierRecordId'));
  }

  async function handleSubmit() {
    if (!contractRecordId || !draft || !options || saving) return;
    if (!canSave) { setFeedback('当前合同或修改后的专业、楼栋超出修改权限范围'); return; }
    const validationErrors = validateContractEditDraft(draft, options);
    if (validationErrors.length > 0) {
      setFieldErrors(
        Object.fromEntries(
          validationErrors.map((validationError) => [
            validationError.path,
            validationError.message,
          ]),
        ),
      );
      setFeedback('请先修正标记字段');
      return;
    }

    const request = buildContractEditRequest(draft, options);
    if (
      !Object.keys(request.fields).length &&
      request.supplierRecordId === undefined
    ) {
      setFeedback('合同信息未发生变化');
      return;
    }

    setSaving(true);
    setFieldErrors({});
    setFeedback('正在同步至多维表');
    try {
      const response = await updateContractInformation(
        contractRecordId,
        request,
      );
      toast.success(response.message);
      onOpenChange(false);
      void Promise.resolve(onCompleted()).catch(() => {
        toast.warning('合同信息已同步，但看板刷新失败，请手动刷新');
      });
    } catch (reason) {
      setFeedback(apiErrorMessage(reason, '合同信息同步失败，请稍后重试'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving || nextOpen) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-5xl overflow-hidden p-0">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FilePenLine className="h-5 w-5 text-blue-600" />
            合同信息迭代
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            更新执行合同业务信息与供应商关联；合同附件和付款计划保持不变。
          </DialogDescription>
        </div>

        <div className="max-h-[72vh] overflow-y-auto px-5 py-5">
          {contract && (
            <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <p className="truncate text-sm font-semibold text-slate-900">
                {contract.name}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {contract.code || '编号待补充'}
              </p>
            </div>
          )}

          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm font-medium text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              正在读取合同当前信息
            </div>
          ) : loadError ? (
            <div
              role="alert"
              className="flex min-h-32 items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-5 text-rose-800"
            >
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="text-sm font-semibold">合同信息读取失败</p>
                <p className="mt-1 text-xs leading-5">{loadError}</p>
              </div>
            </div>
          ) : options && draft ? (
            <div className="space-y-4">
              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h3 className="mb-4 text-sm font-bold text-slate-900">
                  供应商关联
                </h3>
                <label className="block max-w-xl">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-700">
                    选择供应商<span className="ml-1 text-rose-500">*</span>
                  </span>
                  <select
                    value={draft.supplierRecordId}
                    onChange={(event) => updateSupplier(event.target.value)}
                    className={inputClassName(
                      Boolean(fieldErrors.supplierRecordId),
                    )}
                  >
                    <option value="">请选择供应商</option>
                    {options.suppliers.map((supplier) => (
                      <option key={supplier.recordId} value={supplier.recordId}>
                        {supplier.name}
                      </option>
                    ))}
                  </select>
                  <FieldError value={fieldErrors.supplierRecordId} />
                </label>
              </section>

              {groups.map(({ group, fields }) => (
                <section
                  key={group}
                  className="rounded-lg border border-slate-200 bg-white p-4"
                >
                  <h3 className="mb-4 text-sm font-bold text-slate-900">
                    {groupLabels[group]}
                  </h3>
                  <div className="grid gap-4 md:grid-cols-2">
                    {fields.map((field) => (
                      <EditableField
                        key={field.fieldId}
                        field={field}
                        people={options.people}
                        value={draft.fields[field.fieldId]}
                        error={fieldErrors[`fields.${field.fieldId}`]}
                        onChange={(value) => updateField(field.fieldId, value)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-200 bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p
            role={feedback ? 'status' : undefined}
            className={cn(
              'min-h-5 text-xs font-medium',
              feedback.includes('失败') || feedback.includes('修正')
                ? 'text-rose-600'
                : 'text-slate-500',
            )}
          >
            {feedback}
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!draft || loading || saving || Boolean(loadError) || !canSave}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? '正在同步' : '保存迭代'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function contractEditPermissionScope(contract: ContractManagementItem | null, draft: ContractEditDraft | null, options: ContractEditOptionsResponse | null): ContractPermissionScope | null {
  if (!contract) return null;
  const field = (name: string) => {
    const id = options?.fields.find(item => item.name === name)?.fieldId;
    return id && draft && Object.prototype.hasOwnProperty.call(draft.fields, id) ? draft.fields[id] : undefined;
  };
  const specialty = field('专业类别'), buildings = field('对应楼栋设备');
  return { specialty: specialty === undefined ? contract.specialty : typeof specialty === 'string' ? specialty : '',
    buildings: buildings === undefined ? contract.buildings : businessBuildingLabels(typeof buildings === 'string' ? buildings : Array.isArray(buildings) ? buildings.filter(value => typeof value === 'string').join('、') : '') };
}

function EditableField({
  field,
  people,
  value,
  error,
  onChange,
}: {
  field: ContractCreateFieldDefinition;
  people: ContractEditOptionsResponse['people'];
  value: ContractCreateValue | undefined;
  error?: string;
  onChange: (value: ContractCreateValue) => void;
}) {
  const label = (
    <span className="mb-1.5 block text-xs font-semibold text-slate-700">
      {field.name}
      {field.required && <span className="ml-1 text-rose-500">*</span>}
    </span>
  );

  if (field.control === 'select' || field.control === 'multiselect') {
    return (
      <label className="block">
        {label}
        <select
          multiple={field.control === 'multiselect'}
          value={
            field.control === 'multiselect'
              ? Array.isArray(value)
                ? value
                : []
              : typeof value === 'string'
                ? value
                : ''
          }
          onChange={(event) =>
            onChange(
              field.control === 'multiselect'
                ? Array.from(event.target.selectedOptions, (item) => item.value)
                : event.target.value,
            )
          }
          className={inputClassName(Boolean(error))}
        >
          {field.control === 'select' && <option value="">请选择</option>}
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <FieldError value={error} />
      </label>
    );
  }

  if (field.control === 'user') {
    const userValues = Array.isArray(value)
      ? value
      : typeof value === 'string' && value
        ? [value]
        : [];
    return (
      <label className="block">
        {label}
        <select
          multiple={field.multiple}
          value={field.multiple ? userValues : userValues[0] || ''}
          onChange={(event) =>
            onChange(
              field.multiple
                ? Array.from(event.target.selectedOptions, (item) => item.value)
                : event.target.value,
            )
          }
          className={inputClassName(Boolean(error))}
        >
          {!field.multiple && <option value="">请选择人员</option>}
          {people.map((person) => (
            <option key={person.openId} value={person.openId}>
              {person.name}
            </option>
          ))}
        </select>
        <FieldError value={error} />
      </label>
    );
  }

  if (field.control === 'checkbox') {
    return (
      <label className="flex items-center gap-2 self-end rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.name}
      </label>
    );
  }

  return (
    <label className="block">
      {label}
      <input
        type={
          field.control === 'number'
            ? 'number'
            : field.control === 'date'
              ? 'date'
              : field.inputType
        }
        value={
          typeof value === 'number' || typeof value === 'string' ? value : ''
        }
        onChange={(event) =>
          onChange(
            field.control === 'number'
              ? event.target.value === ''
                ? ''
                : Number(event.target.value)
              : event.target.value,
          )
        }
        className={inputClassName(Boolean(error))}
        placeholder={`请输入${field.name}`}
      />
      <FieldError value={error} />
    </label>
  );
}

function FieldError({ value }: { value?: string }) {
  return value ? (
    <span className="mt-1 block text-xs font-medium text-rose-600">
      {value}
    </span>
  ) : null;
}

function inputClassName(error: boolean): string {
  return cn(
    'h-10 w-full rounded-lg border bg-white px-3 text-sm text-slate-900 outline-none transition focus:ring-2',
    error
      ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-100'
      : 'border-slate-300 focus:border-blue-500 focus:ring-blue-100',
  );
}

function clearError(
  errors: Record<string, string>,
  path: string,
): Record<string, string> {
  if (!errors[path]) return errors;
  const next = { ...errors };
  delete next[path];
  return next;
}

function apiErrorMessage(reason: unknown, fallback: string): string {
  const responseMessage = (
    reason as { response?: { data?: { message?: unknown } } }
  )?.response?.data?.message;
  return typeof responseMessage === 'string' && responseMessage.trim()
    ? responseMessage.trim()
    : reason instanceof Error && reason.message
      ? reason.message
      : fallback;
}
