import { useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CalendarDays,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  getContractExpiryDispositionTaskStatus,
  getContractPaymentFollowUpOptions,
  updateContractExpiryDisposition,
} from '@/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { CONTRACT_PAYMENT_PERIODS } from '@shared/contract-field-config';
import type {
  ContractCreatePersonOption,
  ContractExpiryDispositionAction,
  ContractManagementItem,
} from '@shared/contract-management.interface';

import {
  createEmptyPaymentPlan,
  toPaymentPlanInput,
  validatePaymentPlanDrafts,
  type ContractCreatePaymentPlanDraft,
} from './contract-creation.logic';

interface ContractExpiryDispositionDialogProps {
  contract: ContractManagementItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: (recordId: string) => void;
  onUpdated: () => void | Promise<void>;
}

const TASK_POLL_INTERVAL_MS = 1_000;
const TASK_POLL_TIMEOUT_MS = 90_000;

export function ContractExpiryDispositionDialog({
  contract,
  open,
  onOpenChange,
  onSubmitted,
  onUpdated,
}: ContractExpiryDispositionDialogProps) {
  const [action, setAction] =
    useState<ContractExpiryDispositionAction>('renew');
  const [renewalEndDate, setRenewalEndDate] = useState('');
  const [paymentPlans, setPaymentPlans] = useState<
    ContractCreatePaymentPlanDraft[]
  >([createEmptyPaymentPlan()]);
  const [people, setPeople] = useState<ContractCreatePersonOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(createRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const minimumRenewalDate = useMemo(
    () => nextDate(contract?.endDate),
    [contract?.endDate],
  );
  const contractRecordId = contract?.recordId;

  useEffect(() => {
    if (!open || !contractRecordId) return;
    let cancelled = false;
    setAction('renew');
    setRenewalEndDate('');
    setPaymentPlans([createEmptyPaymentPlan()]);
    setPeople([]);
    setOptionsLoading(true);
    setOptionsError('');
    setIdempotencyKey(createRequestId());
    setError('');

    void getContractPaymentFollowUpOptions(contractRecordId)
      .then((options) => {
        if (cancelled) return;
        if (options.contract.recordId !== contractRecordId) {
          throw new Error('付款计划返回的合同与当前合同不匹配，请重新打开');
        }
        const defaultOwnerOpenId =
          options.contract.ownerOpenId || options.people[0]?.openId || '';
        setPeople(options.people);
        setPaymentPlans((current) =>
          current.map((plan) => ({
            ...plan,
            ownerOpenId: plan.ownerOpenId || defaultOwnerOpenId,
          })),
        );
      })
      .catch((reason) => {
        if (!cancelled) {
          setOptionsError(
            apiErrorMessage(reason, '付款人员选项同步失败，请稍后重试'),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [contractRecordId, open]);

  function addPaymentPlan() {
    setPaymentPlans((current) => {
      if (current.length >= 4) return current;
      const defaultOwnerOpenId =
        current[0]?.ownerOpenId || people[0]?.openId || '';
      return [
        ...current,
        { ...createEmptyPaymentPlan(), ownerOpenId: defaultOwnerOpenId },
      ];
    });
  }

  function removePaymentPlan(index: number) {
    setPaymentPlans((current) =>
      current.length === 1
        ? current
        : current.filter((_, itemIndex) => itemIndex !== index),
    );
  }

  function updatePaymentPlan(
    index: number,
    patch: Partial<ContractCreatePaymentPlanDraft>,
  ) {
    setPaymentPlans((current) =>
      current.map((plan, itemIndex) =>
        itemIndex === index ? { ...plan, ...patch } : plan,
      ),
    );
  }

  async function handleSubmit() {
    if (!contract || busy) return;
    if (action === 'renew') {
      if (!renewalEndDate) {
        setError('请选择续期截止时间');
        return;
      }
      const paymentPlanError = validatePaymentPlanDrafts(paymentPlans)[0];
      if (paymentPlanError) {
        setError(paymentPlanError.message);
        return;
      }
    }
    setBusy(true);
    setError('');
    try {
      const response = await updateContractExpiryDisposition(
        contract.recordId,
        {
          action,
          renewalEndDate: action === 'renew' ? renewalEndDate : undefined,
          idempotencyKey,
          paymentPlans:
            action === 'renew'
              ? paymentPlans.map(toPaymentPlanInput)
              : undefined,
        },
      );
      toast.success(response.message);
      onSubmitted(contract.recordId);
      onOpenChange(false);
      void monitorBackgroundTask(response.taskId, onUpdated);
    } catch (reason) {
      setError(apiErrorMessage(reason, '合同到期处置失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl overflow-hidden p-0">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-blue-600" />
            合同到期人工确认
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            管理员与合同管理员均可续期或确认到期作废；结果将在后台同步到多维表。
          </DialogDescription>
        </div>

        <div className="max-h-[72vh] space-y-4 overflow-y-auto px-5 py-5">
          {contract && (
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-sm">
              <p className="font-semibold text-slate-900">{contract.name}</p>
              <p className="mt-1 text-xs text-slate-500">
                {contract.code || '编号待补充'} · 当前截止时间{' '}
                {contract.endDate || '待补充'}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <DispositionOption
              active={action === 'renew'}
              icon={RefreshCw}
              label="合同续期"
              description="更新截止时间并新增付款计划"
              onClick={() => setAction('renew')}
            />
            <DispositionOption
              active={action === 'void'}
              icon={Ban}
              label="到期作废"
              description="确认后移出风险卡片"
              danger
              onClick={() => setAction('void')}
            />
          </div>

          {action === 'renew' ? (
            <div className="space-y-4">
              <label className="block text-sm font-semibold text-slate-700">
                续期截止时间
                <span className="relative mt-2 block">
                  <CalendarDays className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    type="date"
                    min={minimumRenewalDate}
                    value={renewalEndDate}
                    onChange={(event) => setRenewalEndDate(event.target.value)}
                    className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </span>
              </label>

              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      付款计划
                    </h3>
                    <p className="mt-1 text-xs text-slate-500">
                      合同编号自动关联，付款状态统一创建为“未付款”。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addPaymentPlan}
                    disabled={paymentPlans.length >= 4}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    新增付款节点
                  </button>
                </div>

                {optionsLoading && (
                  <p className="mt-3 flex items-center gap-2 text-xs text-blue-700">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    正在同步跟进人员，可先填写期次、金额和日期
                  </p>
                )}
                {optionsError && (
                  <p
                    role="alert"
                    className="mt-3 text-xs font-medium text-rose-600"
                  >
                    {optionsError}
                  </p>
                )}

                <div className="mt-3 space-y-3">
                  {paymentPlans.map((plan, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-slate-200 bg-slate-50/70 p-3"
                    >
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-slate-900">
                          付款节点 {index + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => removePaymentPlan(index)}
                          disabled={paymentPlans.length === 1}
                          aria-label={`删除付款节点 ${index + 1}`}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 hover:text-rose-700 disabled:cursor-not-allowed disabled:text-slate-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除付款节点
                        </button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                        <PaymentField label="付款周期">
                          <select
                            value={plan.period}
                            onChange={(event) =>
                              updatePaymentPlan(index, {
                                period: event.target.value,
                              })
                            }
                            className={inputClassName()}
                          >
                            <option value="">请选择</option>
                            {CONTRACT_PAYMENT_PERIODS.map((period) => (
                              <option key={period} value={period}>
                                {period}
                              </option>
                            ))}
                          </select>
                        </PaymentField>
                        <PaymentField label="计划付款金额">
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
                            className={inputClassName()}
                            placeholder="请输入金额"
                          />
                        </PaymentField>
                        <PaymentField label="计划付款日期">
                          <input
                            type="date"
                            value={plan.plannedPaymentDate}
                            onChange={(event) =>
                              updatePaymentPlan(index, {
                                plannedPaymentDate: event.target.value,
                              })
                            }
                            className={inputClassName()}
                          />
                        </PaymentField>
                        <PaymentField label="跟进人">
                          <select
                            value={plan.ownerOpenId}
                            onChange={(event) =>
                              updatePaymentPlan(index, {
                                ownerOpenId: event.target.value,
                              })
                            }
                            className={inputClassName()}
                          >
                            <option value="">请选择人员</option>
                            {people.map((person) => (
                              <option key={person.openId} value={person.openId}>
                                {person.name}
                              </option>
                            ))}
                          </select>
                        </PaymentField>
                        <PaymentField label="付款状态">
                          <input
                            value="未付款"
                            disabled
                            className={inputClassName('bg-slate-100')}
                          />
                        </PaymentField>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-xs leading-5 text-rose-700">
              到期作废后，该合同不再出现在“合同到期风险”卡片中；此操作不会删除合同记录。
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm font-medium text-rose-600">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="h-9 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={
              busy ||
              (action === 'renew' && (!renewalEndDate || optionsLoading))
            }
            className={cn(
              'flex h-9 items-center gap-2 rounded-lg px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50',
              action === 'void'
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-blue-600 hover:bg-blue-700',
            )}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy
              ? action === 'renew'
                ? '正在提交续期'
                : '正在提交到期作废'
              : action === 'renew'
                ? '确认续期并新增付款计划'
                : '确认到期作废'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PaymentField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-slate-700">
        {label}
        {label !== '付款状态' && <span className="ml-1 text-rose-500">*</span>}
      </span>
      {children}
    </label>
  );
}

function DispositionOption({
  active,
  icon: Icon,
  label,
  description,
  danger = false,
  onClick,
}: {
  active: boolean;
  icon: typeof RefreshCw;
  label: string;
  description: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border p-3 text-left transition',
        active
          ? danger
            ? 'border-rose-400 bg-rose-50 ring-2 ring-rose-100'
            : 'border-blue-500 bg-blue-50 ring-2 ring-blue-100'
          : 'border-slate-200 bg-white hover:bg-slate-50',
      )}
    >
      <Icon
        className={cn('h-4 w-4', danger ? 'text-rose-600' : 'text-blue-600')}
      />
      <span className="mt-2 block text-sm font-semibold text-slate-900">
        {label}
      </span>
      <span className="mt-0.5 block text-[11px] text-slate-500">
        {description}
      </span>
    </button>
  );
}

function inputClassName(extra = ''): string {
  return cn(
    'h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100',
    extra,
  );
}

function nextDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

function apiErrorMessage(reason: unknown, fallback: string): string {
  const responseMessage = (
    reason as {
      response?: { data?: { message?: unknown } };
    }
  )?.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim()) {
    return responseMessage.trim();
  }
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function monitorBackgroundTask(
  taskId: string,
  onUpdated: () => void | Promise<void>,
): Promise<void> {
  const deadline = Date.now() + TASK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await getContractExpiryDispositionTaskStatus(taskId);
      const task = response.task;
      if (!response.success || !task) {
        toast.error(response.message || '合同到期处置后台任务不存在，请刷新后确认结果');
        refreshDashboardAfterTask(onUpdated);
        return;
      }
      if (task.status === 'completed') {
        toast.success(task.message || '合同到期处置已同步');
        refreshDashboardAfterTask(onUpdated);
        return;
      }
      if (task.status === 'failed') {
        toast.error(task.message || '合同到期处置后台同步失败，请稍后重试');
        refreshDashboardAfterTask(onUpdated);
        return;
      }
    } catch {
      // 后台任务仍会继续执行，下一次轮询再确认状态。
    }
    await wait(TASK_POLL_INTERVAL_MS);
  }
  toast.warning('合同到期处置仍在后台同步，请稍后刷新确认结果');
}

function refreshDashboardAfterTask(
  onUpdated: () => void | Promise<void>,
): void {
  void Promise.resolve(onUpdated()).catch(() => {
    toast.warning('合同到期处置已同步，但看板刷新失败，请手动刷新');
  });
}

function wait(duration: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, duration));
}
