import { useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck,
  Ban,
  CalendarDays,
  CircleDollarSign,
  ClipboardEdit,
  ListPlus,
  Loader2,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  adjustContractPaymentPlan,
  confirmContractPaymentPlan,
  createContractPaymentPlan,
  getContractPaymentFollowUpOptions,
} from '@/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { createFixedPaymentFollowUpOptions } from '@shared/contract-field-config';
import type {
  ContractPaymentFollowUpItem,
  ContractPaymentFollowUpOptionsResponse,
  ContractPaymentPlanOption,
} from '@shared/contract-management.interface';
import {
  availablePaymentActions,
  initialPaymentAction,
  pendingPlanAmount,
  type ContractPaymentDialogAction,
} from './contract-payment-follow-up.logic';

interface ContractPaymentFollowUpDialogProps {
  item: ContractPaymentFollowUpItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void | Promise<void>;
  onNoPaymentRequired: (
    item: ContractPaymentFollowUpItem,
  ) => void | Promise<void>;
}

export function ContractPaymentFollowUpDialog({
  item,
  open,
  onOpenChange,
  onCompleted,
  onNoPaymentRequired,
}: ContractPaymentFollowUpDialogProps) {
  const [options, setOptions] =
    useState<ContractPaymentFollowUpOptionsResponse | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [dynamicOptionsReady, setDynamicOptionsReady] = useState(false);
  const [action, setAction] = useState<ContractPaymentDialogAction>('create');
  const [selectedPaymentId, setSelectedPaymentId] = useState('');
  const [period, setPeriod] = useState('');
  const [plannedAmount, setPlannedAmount] = useState('');
  const [actualAmount, setActualAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [ownerOpenId, setOwnerOpenId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const createIdempotencyKey = useMemo(createRequestId, [
    item?.contractRecordId,
    open,
    ownerOpenId,
    paymentDate,
    period,
    plannedAmount,
  ]);
  const fixedOptions = useMemo(
    () => (item ? createFixedPaymentFollowUpOptions(item) : null),
    [item],
  );
  const effectiveOptions =
    options?.contract.recordId === item?.contractRecordId
      ? options
      : fixedOptions;

  const permissions = useMemo(
    () => availablePaymentActions(effectiveOptions?.plans || []),
    [effectiveOptions?.plans],
  );
  const selectablePlans = useMemo(
    () =>
      action === 'confirm'
        ? (effectiveOptions?.plans || []).filter(
            (plan) => plan.status !== '已付款',
          )
        : effectiveOptions?.plans || [],
    [action, effectiveOptions?.plans],
  );
  const selectedPlan = useMemo(
    () =>
      selectablePlans.find((plan) => plan.recordId === selectedPaymentId) ||
      null,
    [selectablePlans, selectedPaymentId],
  );

  useEffect(() => {
    if (!open || !item) {
      setLoadingOptions(false);
      setDynamicOptionsReady(false);
      return;
    }
    let cancelled = false;
    const initialOptions = createFixedPaymentFollowUpOptions(item);
    setOptions(initialOptions);
    setDynamicOptionsReady(false);
    setLoadingOptions(true);
    setError('');
    setAction('create');
    setSelectedPaymentId('');
    setActualAmount('');
    initializeCreateFields(initialOptions, {
      setPeriod,
      setPlannedAmount,
      setPaymentDate,
      setOwnerOpenId,
    });
    void getContractPaymentFollowUpOptions(item.contractRecordId)
      .then((response) => {
        if (cancelled) return;
        if (response.contract.recordId !== item.contractRecordId) {
          setError('付款计划返回的合同与当前合同不匹配，请重新打开');
          return;
        }
        setOptions(response);
        setDynamicOptionsReady(true);
        const nextAction = initialPaymentAction(item.reason, response.plans);
        setAction(nextAction);
        initializeCreateFields(response, {
          setPeriod,
          setPlannedAmount,
          setPaymentDate,
          setOwnerOpenId,
        });
        const firstPlan =
          nextAction === 'confirm'
            ? response.plans.find((plan) => plan.status !== '已付款')
            : response.plans[0];
        setSelectedPaymentId(firstPlan?.recordId || '');
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(
          apiErrorMessage(reason, '付款计划动态选项同步失败，请稍后重试'),
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item, open]);

  useEffect(() => {
    if (!selectedPlan || action === 'create') return;
    if (action === 'adjust') {
      setPeriod(selectedPlan.period || effectiveOptions?.periods[0] || '');
      setPlannedAmount(String(selectedPlan.plannedAmount || ''));
      setPaymentDate(selectedPlan.plannedPaymentDate || todayInShanghai());
      setOwnerOpenId(
        selectedPlan.ownerOpenId ||
          effectiveOptions?.contract.ownerOpenId ||
          '',
      );
    } else {
      setActualAmount(String(pendingPlanAmount(selectedPlan) || ''));
      setPaymentDate(todayInShanghai());
    }
  }, [action, effectiveOptions, selectedPlan]);

  function selectAction(nextAction: ContractPaymentDialogAction) {
    if (!permissions[nextAction]) return;
    setAction(nextAction);
    setError('');
    if (nextAction === 'create' && effectiveOptions) {
      initializeCreateFields(effectiveOptions, {
        setPeriod,
        setPlannedAmount,
        setPaymentDate,
        setOwnerOpenId,
      });
      setSelectedPaymentId('');
      return;
    }
    const plan =
      nextAction === 'confirm'
        ? effectiveOptions?.plans.find((entry) => entry.status !== '已付款')
        : effectiveOptions?.plans[0];
    setSelectedPaymentId(plan?.recordId || '');
  }

  async function handleNoPaymentRequired() {
    if (!item || busy || !permissions.noPaymentRequired) return;
    if (item.planCount !== 0) return;
    setBusy(true);
    setError('');
    onOpenChange(false);
    try {
      await onNoPaymentRequired(item);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit() {
    if (!item || !effectiveOptions || busy || !dynamicOptionsReady) return;
    const validation = validateForm({
      action,
      selectedPaymentId,
      period,
      plannedAmount,
      actualAmount,
      paymentDate,
      ownerOpenId,
    });
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response =
        action === 'create'
          ? await createContractPaymentPlan(item.contractRecordId, {
              idempotencyKey: createIdempotencyKey,
              period,
              plannedAmount: Number(plannedAmount),
              plannedPaymentDate: paymentDate,
              ownerOpenId,
            })
          : action === 'adjust'
            ? await adjustContractPaymentPlan(
                item.contractRecordId,
                selectedPaymentId,
                {
                  period,
                  plannedAmount: Number(plannedAmount),
                  plannedPaymentDate: paymentDate,
                  ownerOpenId,
                },
              )
            : await confirmContractPaymentPlan(
                item.contractRecordId,
                selectedPaymentId,
                {
                  actualAmount: Number(actualAmount),
                  paymentDate,
                },
              );
      if (response.notification.failed) toast.warning(response.message);
      else toast.success(response.message);
      onOpenChange(false);
      void Promise.resolve(onCompleted()).catch(() => {
        toast.warning('付款计划已同步，但看板刷新失败，请手动刷新');
      });
    } catch (reason) {
      setError(apiErrorMessage(reason, '付款跟进操作失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] w-[min(96vw,760px)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <header className="shrink-0 border-b border-blue-100 bg-blue-50 px-5 py-3.5">
          <DialogTitle className="flex items-center gap-2 text-base text-slate-900">
            <CircleDollarSign className="h-5 w-5 text-blue-600" />
            付款跟进
          </DialogTitle>
          <DialogDescription className="mt-1 truncate text-xs text-slate-600">
            {item?.contractCode || '编号待补充'} ·{' '}
            {item?.contractName || '合同待选择'} · 数据同步至付款计划多维表
          </DialogDescription>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {effectiveOptions ? (
            <div className="space-y-4">
              {loadingOptions && (
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在同步付款计划与人员数据，可先查看表单
                </div>
              )}
              <div
                className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                role="tablist"
              >
                <ActionTab
                  active={action === 'create'}
                  disabled={!permissions.create}
                  icon={ListPlus}
                  label="新增付款计划"
                  onClick={() => selectAction('create')}
                />
                <ActionTab
                  active={action === 'adjust'}
                  disabled={!permissions.adjust}
                  icon={ClipboardEdit}
                  label="调整付款计划"
                  onClick={() => selectAction('adjust')}
                />
                <ActionTab
                  active={action === 'confirm'}
                  disabled={!permissions.confirm}
                  icon={BadgeCheck}
                  label="付款确认"
                  onClick={() => selectAction('confirm')}
                />
                <ActionTab
                  active={false}
                  disabled={
                    !permissions.noPaymentRequired ||
                    Boolean(item?.planCount) ||
                    busy
                  }
                  icon={Ban}
                  label="无需付款"
                  onClick={() => void handleNoPaymentRequired()}
                />
              </div>

              {!permissions.adjust && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  当前合同没有付款条目，请先新增付款计划；新增后即可调整或确认付款。
                </p>
              )}

              {action !== 'create' && (
                <Field label="付款计划" icon={CircleDollarSign}>
                  <select
                    value={selectedPaymentId}
                    onChange={(event) =>
                      setSelectedPaymentId(event.target.value)
                    }
                    className={inputClassName()}
                  >
                    {selectablePlans.map((plan) => (
                      <option key={plan.recordId} value={plan.recordId}>
                        {plan.label} · {plan.status} · ¥
                        {plan.plannedAmount.toLocaleString('zh-CN')}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              {action !== 'confirm' ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="付款周期" icon={CircleDollarSign}>
                    <select
                      value={period}
                      onChange={(event) => setPeriod(event.target.value)}
                      className={inputClassName()}
                    >
                      {effectiveOptions.periods.map((entry) => (
                        <option key={entry} value={entry}>
                          {entry}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="计划付款金额" icon={CircleDollarSign}>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={plannedAmount}
                      onChange={(event) => setPlannedAmount(event.target.value)}
                      className={inputClassName()}
                      placeholder="请输入计划金额"
                    />
                  </Field>
                  <Field label="计划付款日期" icon={CalendarDays}>
                    <input
                      type="date"
                      value={paymentDate}
                      onChange={(event) => setPaymentDate(event.target.value)}
                      className={inputClassName()}
                    />
                  </Field>
                  <Field label="跟进人" icon={UserRound}>
                    <select
                      value={ownerOpenId}
                      onChange={(event) => setOwnerOpenId(event.target.value)}
                      className={inputClassName()}
                    >
                      {effectiveOptions.people.map((person) => (
                        <option key={person.openId} value={person.openId}>
                          {person.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    付款状态：
                    {action === 'create'
                      ? '未付款'
                      : selectedPlan?.status || '保持原状态'}
                    。付款计划、付款总占比等公式字段由多维表自动计算。
                  </div>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="实际付款金额" icon={CircleDollarSign}>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={actualAmount}
                      onChange={(event) => setActualAmount(event.target.value)}
                      className={inputClassName()}
                      placeholder="请输入实际付款金额"
                    />
                  </Field>
                  <Field label="付款日期" icon={CalendarDays}>
                    <input
                      type="date"
                      value={paymentDate}
                      onChange={(event) => setPaymentDate(event.target.value)}
                      className={inputClassName()}
                    />
                  </Field>
                  <div className="sm:col-span-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                    确认后付款状态将强制更新为“已付款”；计划金额 ¥
                    {selectedPlan?.plannedAmount.toLocaleString('zh-CN') || '0'}
                    ，当前未付 ¥
                    {selectedPlan
                      ? pendingPlanAmount(selectedPlan).toLocaleString('zh-CN')
                      : '0'}
                    。
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {error && (
            <p role="alert" className="mt-3 text-sm font-medium text-rose-600">
              {error}
            </p>
          )}
        </div>

        {effectiveOptions && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
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
                !dynamicOptionsReady ||
                (action !== 'create' && !selectedPaymentId)
              }
              className="flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy
                ? '正在提交付款操作'
                : action === 'create'
                  ? '新增付款计划'
                  : action === 'adjust'
                    ? '保存计划调整'
                    : '确认已付款'}
            </button>
          </footer>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ActionTab({
  active,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: typeof ListPlus;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-center text-xs font-semibold transition',
        active
          ? 'border-blue-500 bg-blue-50 text-blue-700 ring-2 ring-blue-100'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function Field({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: typeof CircleDollarSign;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm font-semibold text-slate-700">
      <span className="mb-1.5 flex items-center gap-1.5">
        <Icon className="h-4 w-4 text-slate-400" />
        {label}
      </span>
      {children}
    </label>
  );
}

function initializeCreateFields(
  options: ContractPaymentFollowUpOptionsResponse,
  setters: {
    setPeriod: (value: string) => void;
    setPlannedAmount: (value: string) => void;
    setPaymentDate: (value: string) => void;
    setOwnerOpenId: (value: string) => void;
  },
) {
  setters.setPeriod(options.periods[0] || '');
  setters.setPlannedAmount('');
  setters.setPaymentDate(todayInShanghai());
  setters.setOwnerOpenId(
    options.contract.ownerOpenId || options.people[0]?.openId || '',
  );
}

function validateForm(input: {
  action: ContractPaymentDialogAction;
  selectedPaymentId: string;
  period: string;
  plannedAmount: string;
  actualAmount: string;
  paymentDate: string;
  ownerOpenId: string;
}): string {
  if (input.action !== 'create' && !input.selectedPaymentId) {
    return '请选择付款计划';
  }
  if (!input.paymentDate) {
    return input.action === 'confirm' ? '请选择付款日期' : '请选择计划付款日期';
  }
  if (input.action === 'confirm') {
    return Number(input.actualAmount) > 0 ? '' : '实际付款金额必须大于 0';
  }
  if (!input.period) return '请选择付款周期';
  if (!(Number(input.plannedAmount) > 0)) return '计划付款金额必须大于 0';
  if (!input.ownerOpenId) return '请选择跟进人';
  return '';
}

function inputClassName(extra = ''): string {
  return cn(
    'h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100',
    extra,
  );
}

function todayInShanghai(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function apiErrorMessage(reason: unknown, fallback: string): string {
  const responseMessage = (
    reason as { response?: { data?: { message?: unknown } } }
  )?.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim()) {
    return responseMessage.trim();
  }
  return reason instanceof Error && reason.message ? reason.message : fallback;
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
