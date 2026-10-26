import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type {
  StocktakeOverview,
  StocktakeScope,
} from '@shared/inventory-stocktake.interface';
import type { WarehouseBuilding } from '@shared/inventory-management.interface';
import type { StocktakeFilter } from './inventory-stocktake.logic';

const outcomes = [
  { key: 'matched', label: '账实一致', tone: 'text-green-700' },
  { key: 'surplus', label: '盘盈', tone: 'text-blue-700' },
  { key: 'shortage', label: '盘亏', tone: 'text-red-600' },
  { key: 'pending', label: '待盘', tone: 'text-slate-600' },
] as const;
type Outcome = (typeof outcomes)[number]['key'];
export function StocktakeOutcomeSummary({
  overview,
  onOpen,
}: {
  overview: StocktakeOverview | null;
  onOpen?: (
    scope: StocktakeScope,
    building?: WarehouseBuilding,
    filter?: StocktakeFilter,
  ) => void;
}) {
  const [detail, setDetail] = useState<Outcome | null>(null);
  const rows =
    overview?.buildings.flatMap((building) =>
      (['sample', 'review'] as const).flatMap((scope) => {
        const value = scope === 'sample' ? building : building.review;
        return value && value.status !== 'not_started'
          ? [
              {
                ...value,
                scope,
                building: building.building,
                pending: value.total - value.confirmed,
                matched: value.matched ?? value.confirmed - value.differences,
                surplus: value.surplus ?? null,
                shortage: value.shortage ?? null,
              },
            ]
          : [];
      }),
    ) || [];
  if (!rows.length)
    return (
      <p className="mt-3 text-xs text-slate-500">该月未记录盘盈、盘亏明细</p>
    );
  const totals = (key: Outcome) =>
    rows.some((row) => row[key] === null)
      ? null
      : rows.reduce((sum, row) => sum + (row[key] || 0), 0);
  return (
    <div className="mt-3 space-y-3">
      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        aria-label="盘点结果"
      >
        {outcomes.map((outcome) => (
          <Button
            key={outcome.key}
            variant="outline"
            className="h-auto min-w-0 flex-col gap-1 border-slate-100 py-3 disabled:opacity-100"
            disabled={!onOpen || !totals(outcome.key)}
            onClick={() => setDetail(outcome.key)}
          >
            <span className="text-xs text-slate-500">{outcome.label}</span>
            <strong className={`text-lg tabular-nums ${outcome.tone}`}>
              {totals(outcome.key) ?? '—'}
              <small className="ml-1 text-xs font-normal">项</small>
            </strong>
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2" aria-label="分类盘点进度">
        {(['sample', 'review'] as const).map((scope) => {
          const group = rows.filter((row) => row.scope === scope);
          const total = group.reduce((sum, row) => sum + row.total, 0),
            confirmed = group.reduce((sum, row) => sum + row.confirmed, 0);
          return (
            <button
              type="button"
              key={scope}
              disabled={!onOpen}
              onClick={() => onOpen?.(scope)}
              className="flex flex-wrap items-center justify-between gap-1 rounded-lg border border-blue-100 bg-blue-50/40 px-3 py-2 text-xs text-slate-700 enabled:hover:bg-blue-50"
            >
              <span>{scope === 'sample' ? '重点抽盘' : '库存核盘'}</span>
              <strong className="tabular-nums">
                {confirmed} / {total}
              </strong>
            </button>
          );
        })}
      </div>
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[80vh] overflow-y-auto border-blue-100 bg-white"
        >
          <div className="flex items-center justify-between">
            <DialogTitle>
              {outcomes.find((outcome) => outcome.key === detail)?.label}明细
            </DialogTitle>
            <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>
              关闭
            </Button>
          </div>
          <DialogDescription className="sr-only">
            按楼栋和盘点类型查看条目
          </DialogDescription>
          <div className="divide-y divide-slate-100">
            {rows
              .filter((row) => detail && (row[detail] || 0) > 0)
              .map((row) => (
                <button
                  type="button"
                  key={`${row.scope}:${row.building}`}
                  className="flex w-full items-center justify-between gap-3 py-3 text-left text-sm enabled:hover:text-blue-700"
                  onClick={() => {
                    if (detail) onOpen?.(row.scope, row.building, detail);
                    setDetail(null);
                  }}
                >
                  <span>
                    {row.building} ·{' '}
                    {row.scope === 'sample' ? '重点抽盘' : '库存核盘'}
                  </span>
                  <strong>{detail ? row[detail] : 0} 项 ›</strong>
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
