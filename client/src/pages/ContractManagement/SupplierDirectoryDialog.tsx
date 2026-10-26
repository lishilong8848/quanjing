import { ArrowRight, Building2, X } from 'lucide-react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { ContractSupplierDirectory } from '@shared/contract-management.interface';

import { SupplierDirectoryPanel } from './SupplierDirectoryPanel';

export function SupplierDirectoryDialog({
  directory,
  sourceIssue,
}: {
  directory: ContractSupplierDirectory;
  sourceIssue: string | null;
}) {
  const { summary } = directory;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="打开供应商名录"
          className="group h-full w-full rounded-lg border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-blue-300 hover:bg-blue-50/30 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          <span className="flex h-full items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-cyan-600 text-white shadow-md shadow-cyan-200">
              <Building2 className="h-6 w-6" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-slate-600">
                  供应商名录
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-blue-500 transition-transform group-hover:translate-x-0.5" />
              </span>
              <strong className="mt-1 block truncate text-2xl font-bold tabular-nums text-slate-950">
                {sourceIssue
                  ? '--'
                  : `${formatNumber(summary.totalSuppliers)} 家`}
              </strong>
              <span className="mt-2 block text-xs leading-5 text-slate-500">
                {sourceIssue
                  ? '供应商名录数据暂不可用'
                  : `${formatNumber(summary.directoryEntries)} 条联系人记录 · ${formatNumber(summary.linkedContracts)} 份关联合同`}
              </span>
            </span>
          </span>
        </button>
      </DialogTrigger>

      <DialogContent
        showCloseButton={false}
        className="h-[100dvh] max-h-[100dvh] max-sm:max-w-none gap-0 overflow-hidden rounded-none border-0 bg-white p-0 sm:h-[92dvh] sm:max-h-[92dvh] sm:max-w-[1440px] sm:rounded-lg sm:border"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <DialogTitle className="text-base font-bold text-slate-950 sm:text-lg">
                供应商名录
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-5 text-slate-500 sm:text-sm">
                按公司聚合供应商联系人、园区对接人和关联执行合同
              </DialogDescription>
            </div>
            <DialogClose
              aria-label="关闭供应商名录"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              <X className="h-4 w-4" />
            </DialogClose>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {sourceIssue ? (
              <div
                role="alert"
                className="m-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-5 text-sm text-amber-800 sm:m-6"
              >
                <p className="font-semibold">供应商名录数据暂不可用</p>
                <p className="mt-1 text-xs leading-5">{sourceIssue}</p>
              </div>
            ) : (
              <SupplierDirectoryPanel directory={directory} embedded />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}
