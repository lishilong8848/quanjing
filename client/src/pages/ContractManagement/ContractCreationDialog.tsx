import { useEffect, useMemo, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  ChevronLeft,
  FilePlus2,
  FileText,
  Loader2,
  Plus,
  Search,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { toast } from 'sonner';

import { createContract, getContractCreateOptions } from '@/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  CONTRACT_PAYMENT_PERIODS,
  createFixedContractOptions,
} from '@shared/contract-field-config';
import type {
  ContractCreateFieldDefinition,
  ContractCreateKind,
  ContractCreateOptionsResponse,
  ContractCreateResponse,
  ContractCreateValue,
} from '@shared/contract-management.interface';
import {
  buildContractCreateRequest,
  createEmptyContractDraft,
  createEmptyPaymentPlan,
  fuzzyContractOptions,
  fuzzySupplierOptions,
  validateContractDraft,
  type ContractCreateDraft,
} from './contract-creation.logic';
import { createLatestRequestCoordinator } from './latest-request';

interface ContractCreationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void | Promise<void>;
}

const groupMeta = [
  { key: 'basic', label: '合同基本信息' },
  { key: 'commercial', label: '商务与履约信息' },
  { key: 'relationship', label: '关联信息' },
  { key: 'other', label: '其他信息' },
] as const;

export function ContractCreationDialog({
  open,
  onOpenChange,
  onCreated,
}: ContractCreationDialogProps) {
  const [kind, setKind] = useState<ContractCreateKind | null>(null);
  const [options, setOptions] = useState<ContractCreateOptionsResponse | null>(
    null,
  );
  const [draft, setDraft] = useState<ContractCreateDraft | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [dynamicOptionsReady, setDynamicOptionsReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');
  const [result, setResult] = useState<ContractCreateResponse | null>(null);
  const [frameworkQuery, setFrameworkQuery] = useState('');
  const [supplierQuery, setSupplierQuery] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [optionsRequestCoordinator] = useState(createLatestRequestCoordinator);

  useEffect(() => {
    optionsRequestCoordinator.invalidate();
    setLoadingOptions(false);
    setDynamicOptionsReady(false);
    if (!open) return;
    setKind(null);
    setOptions(null);
    setDraft(null);
    setErrors({});
    setFeedback('');
    setResult(null);
    setFrameworkQuery('');
    setSupplierQuery('');
  }, [open, optionsRequestCoordinator]);

  const frameworkOptions = useMemo(
    () => fuzzyContractOptions(options?.frameworks ?? [], frameworkQuery),
    [frameworkQuery, options?.frameworks],
  );
  const supplierOptions = useMemo(
    () => fuzzySupplierOptions(options?.suppliers ?? [], supplierQuery),
    [options?.suppliers, supplierQuery],
  );

  async function chooseKind(selectedKind: ContractCreateKind) {
    const fixedOptions = createFixedContractOptions(selectedKind);
    setKind(selectedKind);
    setOptions(fixedOptions);
    setDraft(createEmptyContractDraft(selectedKind));
    setIdempotencyKey(createRequestId());
    setErrors({});
    setFeedback('');
    setDynamicOptionsReady(false);
    setLoadingOptions(true);
    await optionsRequestCoordinator.run(
      getContractCreateOptions(selectedKind),
      {
        onSuccess: (response) => {
          if (response.kind !== selectedKind) {
            setFeedback('动态选项返回的合同类型不匹配，请重新选择合同类型');
            return;
          }
          setOptions(response);
          setDynamicOptionsReady(true);
        },
        onError: (reason) => {
          setFeedback(apiErrorMessage(reason, '动态选项同步失败，请稍后重试'));
        },
        onSettled: () => {
          setLoadingOptions(false);
        },
      },
    );
  }

  function resetKindSelection() {
    optionsRequestCoordinator.invalidate();
    setKind(null);
    setOptions(null);
    setDraft(null);
    setFeedback('');
    setLoadingOptions(false);
    setDynamicOptionsReady(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      optionsRequestCoordinator.invalidate();
      setLoadingOptions(false);
      setDynamicOptionsReady(false);
    }
    onOpenChange(nextOpen);
  }

  async function handleSubmit() {
    if (!draft || !options || submitting || !dynamicOptionsReady) return;
    const validationErrors = validateContractDraft(draft, options);
    if (validationErrors.length) {
      setErrors(
        Object.fromEntries(
          validationErrors.map((item) => [item.path, item.message]),
        ),
      );
      setFeedback('请补充标红的必填信息');
      return;
    }
    setSubmitting(true);
    setErrors({});
    setFeedback('');
    try {
      const response = await createContract(
        buildContractCreateRequest(draft, idempotencyKey),
        draft.attachments,
      );
      setResult(response);
      void Promise.resolve(onCreated()).catch(() => {
        toast.warning('合同已创建，但看板刷新失败，请手动刷新');
      });
    } catch (reason) {
      setFeedback(apiErrorMessage(reason, '新增合同失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  }

  function updateField(
    collection: 'fields' | 'supplierFields',
    fieldId: string,
    value: ContractCreateValue,
  ) {
    const selectedField =
      collection === 'fields'
        ? options?.fields.find((field) => field.fieldId === fieldId)
        : undefined;
    const ownerOpenId =
      selectedField?.name === '跟进人'
        ? typeof value === 'string'
          ? value
          : Array.isArray(value) && typeof value[0] === 'string'
            ? value[0]
            : ''
        : '';
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        [collection]: { ...current[collection], [fieldId]: value },
        paymentPlans: ownerOpenId
          ? current.paymentPlans.map((plan) =>
              plan.ownerOpenId ? plan : { ...plan, ownerOpenId },
            )
          : current.paymentPlans,
      };
    });
    setErrors((current) => {
      const next = { ...current };
      delete next[`${collection}.${fieldId}`];
      return next;
    });
  }

  function updatePaymentPlan(
    index: number,
    patch: Partial<ContractCreateDraft['paymentPlans'][number]>,
  ) {
    setDraft((current) =>
      current
        ? {
            ...current,
            paymentPlans: current.paymentPlans.map((plan, planIndex) =>
              planIndex === index ? { ...plan, ...patch } : plan,
            ),
          }
        : current,
    );
    setErrors((current) => {
      const next = { ...current };
      delete next.paymentPlans;
      Object.keys(patch).forEach((field) => {
        delete next[`paymentPlans.${index}.${field}`];
      });
      return next;
    });
  }

  function addPaymentPlan() {
    setDraft((current) => {
      if (!current || !options) return current;
      const ownerField = options.fields.find(
        (field) => field.name === '跟进人',
      );
      const value = ownerField ? current.fields[ownerField.fieldId] : undefined;
      const ownerOpenId =
        typeof value === 'string'
          ? value
          : Array.isArray(value) && typeof value[0] === 'string'
            ? value[0]
            : '';
      return {
        ...current,
        paymentPlans: [
          ...current.paymentPlans,
          { ...createEmptyPaymentPlan(), ownerOpenId },
        ],
      };
    });
  }

  function removePaymentPlan(index: number) {
    setDraft((current) =>
      current && current.paymentPlans.length > 1
        ? {
            ...current,
            paymentPlans: current.paymentPlans.filter(
              (_, planIndex) => planIndex !== index,
            ),
          }
        : current,
    );
    setErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([path]) => !path.startsWith('paymentPlans.'),
        ),
      ),
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-hidden p-0">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4 sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FilePlus2 className="h-5 w-5 text-blue-600" />
            新增合同
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            根据合同类型写入对应多维表，PDF 同步至加密 COS，并执行合同通知流程。
          </DialogDescription>
        </div>

        <div className="max-h-[calc(92vh-8.5rem)] overflow-y-auto px-5 py-5 sm:px-6">
          {result ? (
            <SuccessState result={result} />
          ) : !kind ? (
            <ContractKindStep onChoose={(value) => void chooseKind(value)} />
          ) : options && draft ? (
            <div className="space-y-6">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={resetKindSelection}
                  className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700 hover:text-blue-800"
                >
                  <ChevronLeft className="h-4 w-4" />
                  重新选择合同类型
                </button>
                <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                  {kind === 'framework' ? '框架合同' : '执行合同'}
                </span>
              </div>

              {loadingOptions && (
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在同步多维表动态选项，可先填写其他字段
                </div>
              )}

              {groupMeta.map((group) => {
                const fields = options.fields.filter(
                  (field) =>
                    field.group === group.key && field.control !== 'attachment',
                );
                return fields.length ? (
                  <FieldGroup key={group.key} label={group.label}>
                    {fields.map((field) => (
                      <DynamicField
                        key={field.fieldId}
                        field={field}
                        people={options.people}
                        value={draft.fields[field.fieldId]}
                        error={errors[`fields.${field.fieldId}`]}
                        onChange={(value) =>
                          updateField('fields', field.fieldId, value)
                        }
                      />
                    ))}
                  </FieldGroup>
                ) : null;
              })}

              {kind === 'execution' && (
                <FieldGroup label="执行合同关联">
                  <div className="space-y-3 md:col-span-2">
                    <label className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <span>
                        <span className="block text-sm font-semibold text-slate-800">
                          是否关联框架合同
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                          仅可选择当前生效的框架合同
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        checked={draft.linkFramework}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            linkFramework: event.target.checked,
                            frameworkRecordId: event.target.checked
                              ? draft.frameworkRecordId
                              : '',
                          })
                        }
                        className="h-5 w-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                    </label>
                    {draft.linkFramework && (
                      <SearchPicker
                        label="生效框架合同"
                        query={frameworkQuery}
                        placeholder="输入合同编号或名称模糊搜索"
                        error={errors.frameworkRecordId}
                        onQueryChange={setFrameworkQuery}
                        items={frameworkOptions.map((item) => ({
                          id: item.recordId,
                          primary: item.name,
                          secondary: `${item.code} · ${item.startDate} 至 ${item.endDate}`,
                        }))}
                        selectedId={draft.frameworkRecordId}
                        onSelect={(item) => {
                          const selected = options.frameworks.find(
                            (option) => option.recordId === item.id,
                          );
                          setDraft({ ...draft, frameworkRecordId: item.id });
                          setFrameworkQuery(
                            selected
                              ? `${selected.code} · ${selected.name}`
                              : item.primary,
                          );
                          setErrors((current) => ({
                            ...current,
                            frameworkRecordId: '',
                          }));
                        }}
                      />
                    )}
                  </div>

                  <div className="space-y-3 md:col-span-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-slate-800">
                        供应商
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            supplierMode:
                              draft.supplierMode === 'existing'
                                ? 'create'
                                : 'existing',
                            supplierRecordId: '',
                          })
                        }
                        className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-800"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {draft.supplierMode === 'existing'
                          ? '新增供应商'
                          : '选择已有供应商'}
                      </button>
                    </div>
                    {draft.supplierMode === 'existing' ? (
                      <SearchPicker
                        label="选择供应商"
                        query={supplierQuery}
                        placeholder="输入供应商名称模糊搜索"
                        error={errors.supplierRecordId}
                        onQueryChange={setSupplierQuery}
                        items={supplierOptions.map((item) => ({
                          id: item.recordId,
                          primary: item.name,
                          secondary: item.contacts
                            .map((contact) =>
                              [contact.name, contact.phone]
                                .filter(Boolean)
                                .join(' '),
                            )
                            .join('、'),
                        }))}
                        selectedId={draft.supplierRecordId}
                        onSelect={(item) => {
                          setDraft({ ...draft, supplierRecordId: item.id });
                          setSupplierQuery(item.primary);
                          setErrors((current) => ({
                            ...current,
                            supplierRecordId: '',
                          }));
                        }}
                      />
                    ) : (
                      <div className="grid gap-4 rounded-lg border border-blue-100 bg-blue-50/40 p-4 md:grid-cols-2">
                        {options.supplierFields.map((field) => (
                          <DynamicField
                            key={field.fieldId}
                            field={field}
                            people={options.people}
                            value={draft.supplierFields[field.fieldId]}
                            error={errors[`supplierFields.${field.fieldId}`]}
                            onChange={(value) =>
                              updateField(
                                'supplierFields',
                                field.fieldId,
                                value,
                              )
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </FieldGroup>
              )}

              {kind === 'execution' && (
                <FieldGroup label="付款计划">
                  <div className="space-y-3 md:col-span-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">
                          按付款计划多维表字段录入
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          合同编号自动关联；付款状态创建为“未付款”，实际付款信息在付款跟进时补充。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={addPaymentPlan}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 transition hover:bg-blue-100"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        新增付款节点
                      </button>
                    </div>
                    {errors.paymentPlans && (
                      <p className="text-xs font-medium text-rose-600">
                        {errors.paymentPlans}
                      </p>
                    )}
                    {draft.paymentPlans.map((plan, index) => (
                      <div
                        key={index}
                        className="rounded-lg border border-slate-200 bg-slate-50/70 p-4"
                      >
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <span className="text-sm font-bold text-slate-900">
                            付款节点 {index + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => removePaymentPlan(index)}
                            disabled={draft.paymentPlans.length === 1}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 hover:text-rose-700 disabled:cursor-not-allowed disabled:text-slate-400"
                            aria-label={`删除付款节点 ${index + 1}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            删除付款节点
                          </button>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-semibold text-slate-700">
                              付款周期
                              <span className="ml-1 text-rose-500">*</span>
                            </span>
                            <select
                              value={plan.period}
                              onChange={(event) =>
                                updatePaymentPlan(index, {
                                  period: event.target.value,
                                })
                              }
                              className={inputClassName(
                                Boolean(errors[`paymentPlans.${index}.period`]),
                              )}
                            >
                              <option value="">请选择</option>
                              {CONTRACT_PAYMENT_PERIODS.map((period) => (
                                <option key={period} value={period}>
                                  {period}
                                </option>
                              ))}
                            </select>
                            <FieldError
                              value={errors[`paymentPlans.${index}.period`]}
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-semibold text-slate-700">
                              计划付款金额
                              <span className="ml-1 text-rose-500">*</span>
                            </span>
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              value={plan.plannedAmount}
                              onChange={(event) =>
                                updatePaymentPlan(index, {
                                  plannedAmount:
                                    event.target.value === ''
                                      ? ''
                                      : Number(event.target.value),
                                })
                              }
                              className={inputClassName(
                                Boolean(
                                  errors[`paymentPlans.${index}.plannedAmount`],
                                ),
                              )}
                              placeholder="请输入金额"
                            />
                            <FieldError
                              value={
                                errors[`paymentPlans.${index}.plannedAmount`]
                              }
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-semibold text-slate-700">
                              计划付款日期
                              <span className="ml-1 text-rose-500">*</span>
                            </span>
                            <input
                              type="date"
                              value={plan.plannedPaymentDate}
                              onChange={(event) =>
                                updatePaymentPlan(index, {
                                  plannedPaymentDate: event.target.value,
                                })
                              }
                              className={inputClassName(
                                Boolean(
                                  errors[
                                    `paymentPlans.${index}.plannedPaymentDate`
                                  ],
                                ),
                              )}
                            />
                            <FieldError
                              value={
                                errors[
                                  `paymentPlans.${index}.plannedPaymentDate`
                                ]
                              }
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-semibold text-slate-700">
                              跟进人
                              <span className="ml-1 text-rose-500">*</span>
                            </span>
                            <select
                              value={plan.ownerOpenId}
                              onChange={(event) =>
                                updatePaymentPlan(index, {
                                  ownerOpenId: event.target.value,
                                })
                              }
                              className={inputClassName(
                                Boolean(
                                  errors[`paymentPlans.${index}.ownerOpenId`],
                                ),
                              )}
                            >
                              <option value="">请选择人员</option>
                              {options.people.map((person) => (
                                <option
                                  key={person.openId}
                                  value={person.openId}
                                >
                                  {person.name}
                                </option>
                              ))}
                            </select>
                            <FieldError
                              value={
                                errors[`paymentPlans.${index}.ownerOpenId`]
                              }
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-semibold text-slate-700">
                              付款状态
                            </span>
                            <input
                              value="未付款"
                              disabled
                              className={inputClassName(false, 'bg-slate-100')}
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                </FieldGroup>
              )}

              <FieldGroup label="合同附件">
                <label
                  className={cn(
                    'flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed bg-slate-50 px-4 py-6 text-center transition hover:border-blue-400 hover:bg-blue-50/50 md:col-span-2',
                    errors.attachments ? 'border-rose-400' : 'border-slate-300',
                  )}
                >
                  <UploadCloud className="h-7 w-7 text-blue-600" />
                  <span className="mt-2 text-sm font-semibold text-slate-800">
                    上传合同 PDF 原件
                  </span>
                  <span className="mt-1 text-xs text-slate-500">
                    最多 {options.upload.maxFiles} 份，每份不超过
                    20MB；创建后立即同步加密 COS
                  </span>
                  <input
                    type="file"
                    multiple
                    accept="application/pdf,.pdf"
                    className="sr-only"
                    onChange={(event) => {
                      const attachments = Array.from(event.target.files ?? []);
                      setDraft({ ...draft, attachments });
                      setErrors((current) => ({ ...current, attachments: '' }));
                    }}
                  />
                </label>
                <div className="space-y-2 md:col-span-2">
                  {draft.attachments.map((file) => (
                    <div
                      key={`${file.name}-${file.size}`}
                      className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                    >
                      <span className="flex min-w-0 items-center gap-2 font-medium text-slate-700">
                        <FileText className="h-4 w-4 shrink-0 text-rose-500" />
                        <span className="truncate">{file.name}</span>
                      </span>
                      <span className="shrink-0 text-slate-400">
                        {formatFileSize(file.size)}
                      </span>
                    </div>
                  ))}
                  {errors.attachments && (
                    <p className="text-xs font-medium text-rose-600">
                      {errors.attachments}
                    </p>
                  )}
                </div>
              </FieldGroup>
            </div>
          ) : (
            <div className="py-10 text-center text-sm text-rose-600">
              {feedback || '动态选项同步失败'}
            </div>
          )}

          {feedback && !result && (
            <p role="alert" className="mt-4 text-sm font-medium text-rose-600">
              {feedback}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
            className="h-9 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {result ? '关闭' : '取消'}
          </button>
          {options && draft && !result && (
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || !dynamicOptionsReady}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FilePlus2 className="h-4 w-4" />
              )}
              {submitting ? '正在创建并同步' : '确认新增合同'}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ContractKindStep({
  onChoose,
}: {
  onChoose: (kind: ContractCreateKind) => void;
}) {
  return (
    <div className="py-3">
      <div className="text-center">
        <h3 className="text-base font-bold text-slate-900">选择新增合同类型</h3>
        <p className="mt-1 text-sm text-slate-500">
          两种合同使用程序内置固定字段，并写入对应多维表。
        </p>
      </div>
      <div className="mx-auto mt-6 grid max-w-2xl gap-4 md:grid-cols-2">
        <KindCard
          icon={Building2}
          title="框架合同"
          description="建立采购或服务框架，供后续执行合同关联。"
          onClick={() => onChoose('framework')}
        />
        <KindCard
          icon={FileText}
          title="执行合同"
          description="登记具体履约合同，可关联生效框架与供应商。"
          onClick={() => onChoose('execution')}
        />
      </div>
    </div>
  );
}

function KindCard({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: typeof FileText;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group rounded-lg border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-400 hover:bg-blue-50/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 group-hover:bg-blue-600 group-hover:text-white">
        <Icon className="h-5 w-5" />
      </span>
      <span className="mt-4 block text-base font-bold text-slate-900">
        {title}
      </span>
      <span className="mt-1 block text-sm leading-6 text-slate-500">
        {description}
      </span>
    </button>
  );
}

function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      <h3 className="mb-4 text-sm font-bold text-slate-900">{label}</h3>
      <div className="grid gap-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

function DynamicField({
  field,
  people,
  value,
  error,
  onChange,
}: {
  field: ContractCreateFieldDefinition;
  people: ContractCreateOptionsResponse['people'];
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
    const values = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? [value]
        : [];
    return (
      <label className="block">
        {label}
        <select
          multiple={field.multiple}
          value={field.multiple ? values : values[0] || ''}
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

interface PickerItem {
  id: string;
  primary: string;
  secondary: string;
}

function SearchPicker({
  label,
  query,
  placeholder,
  items,
  selectedId,
  error,
  onQueryChange,
  onSelect,
}: {
  label: string;
  query: string;
  placeholder: string;
  items: PickerItem[];
  selectedId: string;
  error?: string;
  onQueryChange: (value: string) => void;
  onSelect: (item: PickerItem) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-semibold text-slate-700">
        {label}
        <span className="ml-1 text-rose-500">*</span>
      </span>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          className={inputClassName(Boolean(error), 'pl-9')}
        />
      </div>
      <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1">
        {items.length ? (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item)}
              className={cn(
                'block w-full rounded-lg px-3 py-2 text-left transition hover:bg-blue-50',
                selectedId === item.id && 'bg-blue-50 ring-1 ring-blue-200',
              )}
            >
              <span className="block text-sm font-semibold text-slate-800">
                {item.primary}
              </span>
              {item.secondary && (
                <span className="mt-0.5 block text-xs text-slate-500">
                  {item.secondary}
                </span>
              )}
            </button>
          ))
        ) : (
          <p className="px-3 py-4 text-center text-xs text-slate-500">
            未找到匹配项
          </p>
        )}
      </div>
      <FieldError value={error} />
    </div>
  );
}

function SuccessState({ result }: { result: ContractCreateResponse }) {
  return (
    <div className="mx-auto max-w-lg py-8 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
        <CheckCircle2 className="h-7 w-7" />
      </div>
      <h3 className="mt-4 text-lg font-bold text-slate-900">创建成功</h3>
      <p className="mt-2 text-sm leading-6 text-slate-500">{result.message}</p>
      <div className="mt-5 grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs sm:grid-cols-4">
        <ResultMetric
          label="付款计划"
          value={`${result.paymentRecordIds.length} 条`}
        />
        <ResultMetric
          label="PDF 安全存储"
          value={`${result.attachments.length} 份`}
        />
        <ResultMetric
          label="通知成功"
          value={`${result.notification.sent} 人`}
        />
        <ResultMetric
          label="通知失败"
          value={`${result.notification.failed} 人`}
        />
      </div>
    </div>
  );
}

function ResultMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-bold text-slate-900">{value}</p>
      <p className="mt-1 text-slate-500">{label}</p>
    </div>
  );
}

function FieldError({ value }: { value?: string }) {
  return value ? (
    <span className="mt-1 block text-xs font-medium text-rose-600">
      {value}
    </span>
  ) : null;
}

function inputClassName(error: boolean, extra = ''): string {
  return cn(
    'h-10 w-full rounded-lg border bg-white px-3 text-sm text-slate-900 outline-none transition focus:ring-2',
    error
      ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-100'
      : 'border-slate-300 focus:border-blue-500 focus:ring-blue-100',
    extra,
  );
}

function createRequestId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (value) => {
    const random = Math.floor(Math.random() * 16);
    return (value === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function formatFileSize(size: number): string {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
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
