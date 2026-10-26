import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BellRing,
  CheckCircle2,
  ClipboardCheck,
  Database,
  Loader2,
  Search,
  ShoppingCart,
  Truck,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';

import { getPurchaseWorkflowOperationalStatus } from '@/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type {
  PurchaseInventoryRequestItem,
  PurchaseInventoryResponse,
} from '@shared/purchase-inventory.interface';
import type { PurchaseWorkflowOperationalStatus } from '@shared/purchase-workflow.interface';

import {
  filterPurchaseWorkflowCenterItems,
  getPurchaseWorkflowCenterItem,
  purchaseWorkflowCenterGroups,
  type PurchaseWorkflowCenterGroup,
  type PurchaseWorkflowCenterKey,
  type PurchaseWorkflowCenterMode,
} from './purchase-workflow-center.logic';

interface PurchaseWorkflowCenterDialogProps {
  open: boolean;
  dashboard: PurchaseInventoryResponse | null;
  onOpenChange: (open: boolean) => void;
  onOpenRecord: (item: PurchaseInventoryRequestItem) => void;
}

const groupStyles: Record<
  PurchaseWorkflowCenterGroup['key'],
  { icon: LucideIcon; active: string; iconClass: string }
> = {
  application: {
    icon: ClipboardCheck,
    active: 'border-blue-300 bg-blue-50 text-blue-800',
    iconClass: 'bg-blue-100 text-blue-600',
  },
  execution: {
    icon: ShoppingCart,
    active: 'border-orange-300 bg-orange-50 text-orange-800',
    iconClass: 'bg-orange-100 text-orange-600',
  },
  receipt: {
    icon: Truck,
    active: 'border-emerald-300 bg-emerald-50 text-emerald-800',
    iconClass: 'bg-emerald-100 text-emerald-600',
  },
};

const modeStyles: Record<PurchaseWorkflowCenterMode, string> = {
  人工处理: 'border-blue-200 bg-blue-50 text-blue-700',
  状态联动: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  定时提醒: 'border-amber-200 bg-amber-50 text-amber-700',
};

export function PurchaseWorkflowCenterDialog({
  open,
  dashboard,
  onOpenChange,
  onOpenRecord,
}: PurchaseWorkflowCenterDialogProps) {
  const [selectedKey, setSelectedKey] =
    useState<PurchaseWorkflowCenterKey>('content-review');
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] =
    useState<PurchaseWorkflowOperationalStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStatusLoading(true);
    void getPurchaseWorkflowOperationalStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setStatusLoading(false));
  }, [open]);

  const requests = dashboard?.requests ?? [];
  const selectedWorkflow = getPurchaseWorkflowCenterItem(selectedKey);
  const visibleItems = useMemo(
    () => filterPurchaseWorkflowCenterItems(requests, selectedKey, keyword),
    [keyword, requests, selectedKey],
  );
  const totalWorkflowCount = purchaseWorkflowCenterGroups.reduce(
    (sum, group) => sum + group.workflows.length,
    0,
  );

  function handleOpenRecord(item: PurchaseInventoryRequestItem) {
    onOpenChange(false);
    onOpenRecord(item);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="fixed inset-0 !flex h-dvh w-screen !max-w-none items-center justify-center border-0 bg-transparent p-4 shadow-none sm:p-6"
        style={{ transform: 'none', translate: 'none' }}
      >
        <div className="flex max-h-[calc(100dvh-2rem)] min-h-0 w-full max-w-[1500px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-[#f6f8fc] shadow-2xl sm:max-h-[calc(100dvh-3rem)]">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 sm:px-6">
            <div className="flex min-w-0 items-start gap-3">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm">
                <Workflow className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-lg font-bold text-slate-950 sm:text-xl">
                    采购工作流
                  </DialogTitle>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold',
                      status?.enabled
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-amber-200 bg-amber-50 text-amber-700',
                    )}
                  >
                    {statusLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : status?.enabled ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <BellRing className="h-3 w-3" />
                    )}
                    {status?.enabled ? '程序执行' : '并行保护'}
                  </span>
                </div>
                <DialogDescription className="mt-1 text-xs text-slate-500">
                  {totalWorkflowCount} 个在用流程已接入 ·
                  待办数据来自采购管理多维表
                </DialogDescription>
              </div>
            </div>
            <button
              type="button"
              title="关闭"
              aria-label="关闭采购工作流"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-800"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="grid min-h-0 flex-1 lg:grid-cols-[360px_minmax(0,1fr)]">
            <aside className="min-h-0 overflow-y-auto border-b border-slate-200 bg-white p-4 lg:border-b-0 lg:border-r">
              <div className="space-y-5">
                {purchaseWorkflowCenterGroups.map((group) => {
                  const style = groupStyles[group.key];
                  const GroupIcon = style.icon;
                  return (
                    <section key={group.key}>
                      <h3 className="mb-2 flex items-center gap-2 text-xs font-bold text-slate-500">
                        <span
                          className={cn(
                            'inline-flex h-6 w-6 items-center justify-center rounded-md',
                            style.iconClass,
                          )}
                        >
                          <GroupIcon className="h-3.5 w-3.5" />
                        </span>
                        {group.label}
                      </h3>
                      <div className="space-y-1.5">
                        {group.workflows.map((workflow) => {
                          const active = workflow.key === selectedKey;
                          const count = requests.filter((item) =>
                            workflow.stages.includes(item.stage),
                          ).length;
                          return (
                            <button
                              key={workflow.key}
                              type="button"
                              onClick={() => {
                                setSelectedKey(workflow.key);
                                setKeyword('');
                              }}
                              className={cn(
                                'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition',
                                active
                                  ? style.active
                                  : 'border-transparent bg-slate-50 text-slate-700 hover:border-slate-200 hover:bg-white',
                              )}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold">
                                  {workflow.programLabel}
                                </span>
                                <span className="mt-0.5 block truncate text-[11px] opacity-65">
                                  {workflow.sourceTitle}
                                </span>
                              </span>
                              <span className="min-w-7 rounded-md bg-white/80 px-1.5 py-1 text-center text-xs font-bold tabular-nums shadow-sm">
                                {count}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            </aside>

            <section className="flex min-h-0 min-w-0 flex-col">
              <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-base font-bold text-slate-950">
                        {selectedWorkflow.programLabel}
                      </h2>
                      <span
                        className={cn(
                          'rounded-md border px-2 py-0.5 text-[11px] font-semibold',
                          modeStyles[selectedWorkflow.mode],
                        )}
                      >
                        {selectedWorkflow.mode}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      来源：{selectedWorkflow.sourceTitle} · 当前{' '}
                      {visibleItems.length} 项
                    </p>
                  </div>
                  <label className="relative block w-full sm:w-72">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                      value={keyword}
                      onChange={(event) => setKeyword(event.target.value)}
                      placeholder="搜索单号、物品、人员"
                      className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                {visibleItems.length ? (
                  <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                    {visibleItems.map((item) => {
                      const actionable = Boolean(item.executionRecordId);
                      return (
                        <button
                          key={item.recordId}
                          type="button"
                          disabled={!actionable}
                          onClick={() => handleOpenRecord(item)}
                          className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-slate-100 px-4 py-3.5 text-left transition last:border-b-0 enabled:hover:bg-blue-50/45 disabled:cursor-not-allowed disabled:opacity-60 sm:grid-cols-[minmax(0,1.2fr)_minmax(120px,0.6fr)_minmax(110px,0.5fr)_auto]"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-slate-900">
                              {item.title || '未命名物品'}
                            </span>
                            <span className="mt-1 block truncate text-xs text-slate-400">
                              {item.requestCode || '单号待生成'} ·{' '}
                              {item.statusLabel}
                            </span>
                          </span>
                          <span className="hidden min-w-0 sm:block">
                            <span className="block truncate text-xs font-medium text-slate-700">
                              {item.requester || '申请人待补充'}
                            </span>
                            <span className="mt-1 block truncate text-[11px] text-slate-400">
                              {item.building || '楼栋未匹配'}
                            </span>
                          </span>
                          <span className="hidden min-w-0 sm:block">
                            <span className="block truncate text-xs font-medium text-slate-700">
                              {item.purchaser || '采购人待分配'}
                            </span>
                            <span className="mt-1 block truncate text-[11px] text-slate-400">
                              {formatCurrency(
                                item.actualAmount ?? item.estimatedAmount,
                              )}
                            </span>
                          </span>
                          <span className="inline-flex items-center gap-2 text-xs font-semibold text-blue-600">
                            {actionable ? '进入处理' : '待生成执行单'}
                            {actionable && <ArrowRight className="h-4 w-4" />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-4 text-center">
                    <Database className="h-8 w-8 text-slate-300" />
                    <p className="mt-3 text-sm font-semibold text-slate-600">
                      当前流程暂无匹配待办
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      数据随采购管理多维表同步更新
                    </p>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value);
}
