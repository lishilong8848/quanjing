import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type {
  StocktakeBulkRequest,
  StocktakeSheet,
  StocktakeBulkTask,
} from '@shared/inventory-stocktake.interface';
import type { PurchaseApplicationApplicant } from '@shared/purchase-application.interface';
import type { StocktakeLocalDraft } from './InventoryStocktakeRow';
import {
  StocktakeEmployeePicker,
  type StocktakePeopleSearch,
} from './StocktakeEmployeePicker';
import {
  bulkConfirmStocktake,
  waitStocktakeBulkTask,
} from './inventory-stocktake.api';
import {
  buildStocktakeBulkLines,
  stocktakeError,
} from './inventory-stocktake.logic';

export function StocktakeBulkDialog({
  open,
  onOpenChange,
  sheet,
  drafts,
  searchPeople,
  onSubmitting,
  onSaved,
  onAccepted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheet: StocktakeSheet;
  drafts: Map<string, StocktakeLocalDraft>;
  searchPeople: StocktakePeopleSearch;
  onSubmitting: (value: boolean) => void;
  onSaved: (sheet: StocktakeSheet) => void;
  onAccepted?: (task: StocktakeBulkTask) => void;
}) {
  const [person, setPerson] = useState<PurchaseApplicationApplicant | null>(
    null,
  );
  const [phase, setPhase] = useState<
    'ready' | 'submitting' | 'accepted' | 'success' | 'error'
  >('ready');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const accepted = useRef<StocktakeBulkTask | null>(null);
  const retry = useRef<{
    signature: string;
    request: StocktakeBulkRequest;
  } | null>(null);
  const pending = sheet.lines.filter((line) => line.status === 'draft');
  useEffect(() => {
    if (open) {
      setPhase('ready');
      setError('');
      if (
        sheet.bulkTask &&
        ['queued', 'running'].includes(sheet.bulkTask.status)
      ) {
        accepted.current = sheet.bulkTask;
        setPerson(sheet.bulkTask.confirmer || null);
        void submit();
      } else if (sheet.bulkTask?.confirmer) setPerson(sheet.bulkTask.confirmer);
    }
  }, [open]);
  const keyFor = (recordId: string) =>
    `review:${sheet.month}:${sheet.building}:${recordId}`;
  async function submit() {
    if (lock.current) return;
    setError('');
    try {
      const progress = (task: StocktakeBulkTask) => {
        accepted.current = task.status === 'error' ? null : task;
        setPhase('accepted');
        onAccepted?.(task);
      };
      if (accepted.current) {
        lock.current = true;
        setPhase('accepted');
        onSubmitting(true);
        const result = await waitStocktakeBulkTask(accepted.current, progress);
        pending.forEach((line) =>
          drafts.delete(keyFor(line.inventory.recordId)),
        );
        accepted.current = null;
        retry.current = null;
        onSaved(result);
        setPhase('success');
        return;
      }
      if (!person) throw new Error('请从在职员工中选择确认人');
      const lines = buildStocktakeBulkLines(sheet, drafts);
      const payload = {
        scope: 'review' as const,
        month: sheet.month,
        building: sheet.building,
        expectedVersion: sheet.version,
        confirmer: person,
        lines,
      };
      const signature = JSON.stringify(payload);
      if (retry.current?.signature !== signature)
        retry.current = {
          signature,
          request: { ...payload, clientMutationId: crypto.randomUUID() },
        };
      lock.current = true;
      setPhase('submitting');
      onSubmitting(true);
      const result = await bulkConfirmStocktake(
        retry.current.request,
        progress,
      );
      pending.forEach((line) => drafts.delete(keyFor(line.inventory.recordId)));
      retry.current = null;
      accepted.current = null;
      onSaved(result);
      setPhase('success');
    } catch (caught) {
      setError(stocktakeError(caught));
      setPhase('error');
    } finally {
      lock.current = false;
      onSubmitting(false);
    }
  }
  const close = (value: boolean) => {
    if (phase === 'submitting' || phase === 'accepted') return;
    if (value) {
      setPhase('ready');
      setError('');
    }
    onOpenChange(value);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showCloseButton={false}
        className="border-blue-100 bg-white"
      >
        <DialogTitle>
          {phase === 'success' ? '核盘已确认' : '一键确认库存核盘'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          确认当前楼栋全部待确认库存条目
        </DialogDescription>
        {phase === 'success' ? (
          <p role="status" className="text-sm text-green-700">
            {sheet.building}库存核盘已确认，飞书同步中
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-lg bg-blue-50 px-4 py-3 text-sm">
              <span>
                {sheet.month} · {sheet.building}
              </span>
              <strong>{pending.length} 项待确认</strong>
            </div>
            <p className="text-sm text-slate-600">
              确认本楼全部待确认条目（含其他分页）。手填数量保留，空白数量按台账补齐。
            </p>
            <label className="space-y-2 text-sm">
              <span>批量确认人</span>
              <StocktakeEmployeePicker
                label="批量确认人"
                value={person}
                onChange={setPerson}
                search={searchPeople}
                disabled={phase === 'submitting' || phase === 'accepted'}
              />
            </label>
            {phase === 'accepted' && (
              <p role="status" className="text-sm text-blue-600">
                请求已受理，正在核查人员和库存…
              </p>
            )}
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
            disabled={phase === 'submitting' || phase === 'accepted'}
            onClick={() => close(false)}
          >
            {phase === 'success' ? '关闭' : '取消'}
          </Button>
          {phase !== 'success' && (
            <Button
              disabled={
                phase === 'submitting' ||
                phase === 'accepted' ||
                !pending.length
              }
              onClick={() => void submit()}
            >
              {phase === 'accepted'
                ? '处理中…'
                : phase === 'submitting'
                  ? '正在提交…'
                  : accepted.current
                    ? '查询处理结果'
                    : '确认本楼全部条目'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
