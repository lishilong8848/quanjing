import { CalendarDays, RefreshCw, Server, X } from 'lucide-react';
import { useDeferredValue, useId, useLayoutEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';

import { RackUsageDetailChart } from './charts';
import type { PanoramaRackSummary } from './data';

interface RackUsageDetailDialogProps {
  summary: PanoramaRackSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stale: boolean;
  retrying: boolean;
  onRetry: () => void;
  restoreFocusTo?: HTMLElement | null;
}

function formatCapacityDate(value: string | null): string {
  if (!value) return '暂无容量日期';
  return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '暂无容量日期';
}

export function RackUsageDetailDialog({
  summary,
  open,
  onOpenChange,
  stale,
  retrying,
  onRetry,
  restoreFocusTo,
}: RackUsageDetailDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const hasBuildingData = summary.buildingUsages.length > 0;
  const chartReady = useDeferredValue(open);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      return;
    }

    if (dialog.open) dialog.close();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    root.style.overflow = 'hidden';
    body.style.overflow = 'hidden';

    return () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="today-panorama-detail-dialog today-panorama-rack-usage-dialog w-[min(920px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-slate-200 p-0"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => {
        if (open) onOpenChange(false);
        restoreFocusTo?.focus();
      }}
    >
      <div className="today-panorama-rack-usage-head flex flex-row items-start gap-3 text-left">
        <span className="today-panorama-rack-usage-icon" aria-hidden="true">
          <Server />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId}>各楼机柜上架率</h2>
          <div
            id={descriptionId}
            className="today-panorama-rack-usage-description"
          >
            <span>
              <CalendarDays aria-hidden="true" />
              容量日期 {formatCapacityDate(summary.capacityDate)}
            </span>
            <span>已上架沿用实际上电数量口径</span>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="today-panorama-dialog-close shrink-0"
          aria-label="关闭各楼机柜上架率"
          onClick={() => onOpenChange(false)}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="today-panorama-rack-usage-body">
        <div
          className="today-panorama-rack-usage-summary"
          aria-label={`总体已上架 ${summary.online.toLocaleString('zh-CN')}，设计机柜 ${summary.total.toLocaleString('zh-CN')}，机柜上架率 ${summary.usageRate.toFixed(1)}%`}
        >
          <span>
            总体已上架 <strong>{summary.online.toLocaleString('zh-CN')}</strong>
          </span>
          <span>
            设计机柜 <strong>{summary.total.toLocaleString('zh-CN')}</strong>
          </span>
          <span>
            上架率 <strong>{summary.usageRate.toFixed(1)}%</strong>
          </span>
        </div>

        {stale ? (
          <div className="today-panorama-rack-usage-stale" role="status">
            <span>当前展示最近一次成功同步的数据</span>
            <Button
              type="button"
              variant="outline"
              className="today-panorama-rack-usage-retry"
              onClick={onRetry}
              disabled={retrying}
              aria-busy={retrying}
            >
              <RefreshCw
                className={
                  retrying
                    ? 'animate-spin motion-reduce:animate-none'
                    : undefined
                }
                aria-hidden="true"
              />
              {retrying ? '读取中…' : '重新读取'}
            </Button>
          </div>
        ) : null}

        {hasBuildingData && chartReady ? (
          <div className="today-panorama-rack-usage-chart">
            <RackUsageDetailChart data={summary.buildingUsages} />
          </div>
        ) : hasBuildingData ? (
          <div className="today-panorama-rack-usage-empty" role="status">
            正在绘制各楼机柜图表…
          </div>
        ) : (
          <div className="today-panorama-rack-usage-empty" role="status">
            暂无各楼机柜容量数据
          </div>
        )}
      </div>
    </dialog>
  );
}
