import { useEffect, useRef, useState } from 'react';
import { useAccess } from '@/access/AccessProvider';
import { canUndoStocktakeBatch } from './stocktake-action-access';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type {
  StocktakeSheet,
  StocktakeUndoRequest,
} from '@shared/inventory-stocktake.interface';
import { undoBulkStocktake } from './inventory-stocktake.api';
import { stocktakeError } from './inventory-stocktake.logic';

export function StocktakeUndoDialog({
  open,
  onOpenChange,
  sheet,
  onSubmitting,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  sheet: StocktakeSheet;
  onSubmitting: (value: boolean) => void;
  onSaved: (value: StocktakeSheet) => void;
}) {
  const canUndo = canUndoStocktakeBatch(useAccess(), sheet);
  const [phase, setPhase] = useState<
    'ready' | 'submitting' | 'success' | 'error'
  >('ready');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const retry = useRef<StocktakeUndoRequest | null>(null);
  useEffect(() => {
    if (open) {
      setPhase('ready');
      setError('');
      retry.current = null;
    }
  }, [open]);
  const batch = sheet.latestBulk;
  async function submit() {
    if (!canUndo || lock.current || !batch || batch.status !== 'confirmed') return;
    lock.current = true;
    setPhase('submitting');
    setError('');
    onSubmitting(true);
    try {
      retry.current ||= {
        month: sheet.month,
        building: sheet.building,
        scope: 'review',
        expectedVersion: sheet.version,
        batchId: batch.id,
        clientMutationId: crypto.randomUUID(),
      };
      onSaved(await undoBulkStocktake(retry.current));
      setPhase('success');
    } catch (caught) {
      setError(stocktakeError(caught));
      setPhase('error');
    } finally {
      lock.current = false;
      onSubmitting(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!lock.current) onOpenChange(value);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="border-blue-100 bg-white"
      >
        <DialogTitle>
          {phase === 'success' ? '批量确认已撤销' : '撤销最近一次批量确认'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          恢复本批条目的确认前草稿，保留其他确认记录
        </DialogDescription>
        {phase === 'success' ? (
          <p role="status" className="text-sm text-green-700">
            已恢复待盘，飞书同步中
          </p>
        ) : (
          <>
            <div className="flex flex-wrap justify-between gap-2 rounded-lg bg-blue-50 px-4 py-3 text-sm">
              <span>
                {sheet.month} · {sheet.building}
              </span>
              <strong>{batch?.count || 0} 项</strong>
            </div>
            <p className="text-sm text-slate-600">
              确认人：{batch?.confirmer.name} ·{' '}
              {batch?.confirmedAt
                ? new Date(batch.confirmedAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })
                : '—'}
            </p>
            <p className="text-sm text-slate-600">
              恢复这批条目确认前的数量、确认人和待盘状态。此前逐项确认的记录保留。
            </p>
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
          </>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={phase === 'submitting'}
            onClick={() => onOpenChange(false)}
          >
            {phase === 'success' ? '关闭' : '取消'}
          </Button>
          {phase !== 'success' && (
            <Button
              disabled={!canUndo || phase === 'submitting' || batch?.status !== 'confirmed'}
              onClick={() => void submit()}
            >
              {phase === 'submitting' ? '正在撤销…' : '撤销本批确认'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
