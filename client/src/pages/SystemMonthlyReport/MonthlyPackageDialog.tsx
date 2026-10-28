import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import {
  AlertCircle,
  Archive,
  CalendarClock,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Send,
} from 'lucide-react';
import type { SystemMonthlyReportPackageTask } from '@shared/system-monthly-report.interface';
import type { SystemMonthlyReportPackagePeriodOption } from './overview.logic';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';

export function MonthlyPackageDialog({
  open,
  accepting,
  task,
  error,
  periods,
  selectedPeriodKey,
  onOpenChange,
  onPeriodChange,
  onStart,
  onRetry,
  onDownload,
}: {
  open: boolean;
  accepting: boolean;
  task: SystemMonthlyReportPackageTask | null;
  error: string;
  periods: SystemMonthlyReportPackagePeriodOption[];
  selectedPeriodKey: string;
  onOpenChange: (open: boolean) => void;
  onPeriodChange: (periodKey: string) => void;
  onStart: () => void;
  onRetry: () => void;
  onDownload: () => void;
}) {
  const access = useAccess();
  const canExport = canUsePageAction(access, 'system_reports', 'export', true);
  const canRetry = canUsePageAction(access, 'system_reports', 'update', true);
  const busy =
    accepting ||
    Boolean(
      task &&
      ['accepted', 'packaging', 'uploading', 'notifying'].includes(task.status),
    );
  const progress =
    task?.status === 'packaging'
      ? 35
      : task?.status === 'uploading'
        ? 65
        : task?.status === 'notifying'
          ? 88
          : task && ['success', 'partial'].includes(task.status)
            ? 100
            : accepting || task?.status === 'accepted'
              ? 15
              : 0;
  const selected = periods.find((period) => period.value === selectedPeriodKey);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="h-5 w-5 text-blue-600" />
            终版附件打包
          </DialogTitle>
          <DialogDescription className="sr-only">
            {task
              ? `${task.year}年${task.month}月终版附件打包任务`
              : '选择终版附件打包月份'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!task ? (
            <section className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
              <label
                className="text-sm font-semibold text-slate-800"
                htmlFor="monthly-package-period"
              >
                打包月份
              </label>
              <div className="relative mt-2">
                <select
                  id="monthly-package-period"
                  value={selectedPeriodKey}
                  onChange={(event) => onPeriodChange(event.target.value)}
                  disabled={accepting || !periods.length}
                  className="h-11 w-full appearance-none rounded-lg border border-slate-200 bg-white py-2 pl-11 pr-9 text-sm font-medium text-slate-800 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {periods.map((period) => (
                    <option key={period.value} value={period.value}>
                      {period.label} · 终版 {period.completedRooms}/
                      {period.totalRooms}
                    </option>
                  ))}
                </select>
                <CalendarClock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              </div>
              {selected ? (
                <div className="mt-3 flex items-center justify-between rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs">
                  <span className="text-slate-600">
                    预计汇总 {selected.totalRooms} 个机房的终版附件
                  </span>
                  <Badge
                    variant="outline"
                    className={
                      selected.completedRooms === selected.totalRooms
                        ? 'border-teal-200 bg-teal-50 text-teal-700'
                        : 'border-orange-200 bg-orange-50 text-orange-700'
                    }
                  >
                    已归档 {selected.completedRooms}/{selected.totalRooms}
                  </Badge>
                </div>
              ) : (
                <p className="mt-3 text-xs text-orange-700">
                  当前没有可打包的月度数据。
                </p>
              )}
            </section>
          ) : null}

          {busy || task ? <Progress value={progress} className="h-2" /> : null}
          {error ? (
            <p role="alert" className="text-sm text-rose-700">
              {error}
            </p>
          ) : null}
          {busy ? (
            <div className="flex gap-3 rounded-lg border border-blue-100 bg-blue-50 p-4">
              <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-blue-600" />
              <p className="font-semibold text-blue-900">正在汇总终版附件</p>
            </div>
          ) : task?.packageReady ? (
            <div className="rounded-lg border border-teal-100 bg-teal-50 p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-teal-600" />
                <p className="font-semibold text-teal-900">压缩包已生成</p>
                {task.status === 'partial' ? (
                  <Badge
                    variant="outline"
                    className="border-orange-200 text-orange-700"
                  >
                    缺件包
                  </Badge>
                ) : null}
              </div>
              {task.missingRooms.length ? (
                <p className="mt-2 text-xs text-orange-700">
                  缺少机房：{task.missingRooms.join('、')}
                </p>
              ) : null}
              <p className="mt-2 flex items-center gap-1 text-xs text-slate-500">
                <Send className="h-3.5 w-3.5" />
                {task.notified ? '下载链接已推送给马进宇' : '链接推送未完成'}
              </p>
            </div>
          ) : task?.status === 'error' || error ? (
            <div className="flex gap-3 rounded-lg border border-rose-100 bg-rose-50 p-4">
              <AlertCircle className="mt-0.5 h-5 w-5 text-rose-600" />
              <div>
                <p className="font-semibold text-rose-900">打包未完成</p>
                <p className="mt-1 text-sm text-rose-700">
                  请重试，仍未完成时联系管理员。
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {!task ? (
            <Button onClick={onStart} disabled={!canExport || accepting || !selected}>
              {accepting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Archive className="h-4 w-4" />
              )}
              开始打包并推送
            </Button>
          ) : null}
          {task?.status === 'error' ? (
            <Button variant="outline" onClick={onRetry} disabled={!canRetry}>
              <RefreshCw className="h-4 w-4" />
              {task.packageReady ? '重试飞书通知' : '重新打包'}
            </Button>
          ) : null}
          {task?.packageReady ? (
            <Button onClick={onDownload} disabled={!canExport}>
              <Download className="h-4 w-4" />
              下载 ZIP
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
