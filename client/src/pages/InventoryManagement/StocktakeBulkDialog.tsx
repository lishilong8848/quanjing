import { StocktakeDraftJournal } from './stocktake-draft-journal';
import { useEffect, useRef, useState } from 'react';
import { useAccess } from '@/access/AccessProvider';
import { canUseStocktakeLines } from './stocktake-action-access';
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
  StocktakeBulkFailure,
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
  confirmedStocktakeBulkDraftIds,
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
  const journal = drafts instanceof StocktakeDraftJournal ? drafts : null;
  const journalKey = `bulk:review:${sheet.month}:${sheet.building}`;
  type Recovery = { retry: {signature: string; request: StocktakeBulkRequest} | null; accepted: StocktakeBulkTask | null };
  const restored = journal?.readTask<Recovery>(journalKey);
  const savedRequest = restored?.retry?.request;
  const validRestored = !restored || Boolean((savedRequest && savedRequest.month === sheet.month && savedRequest.building === sheet.building && savedRequest.scope === 'review' && typeof savedRequest.clientMutationId === 'string' && Array.isArray(savedRequest.lines)) || (!savedRequest && restored.accepted?.month === sheet.month && restored.accepted?.building === sheet.building && typeof restored.accepted?.id === 'string'));
  const [person, setPerson] = useState<PurchaseApplicationApplicant | null>(
    validRestored ? savedRequest?.confirmer || null : null,
  );
  const [phase, setPhase] = useState<
    'ready' | 'submitting' | 'accepted' | 'success' | 'error'
  >('ready');
  const [error, setError] = useState('');
  // Per-line failures from a partial bulk confirm; each stays draft and recoverable.
  const [bulkFailures, setBulkFailures] = useState<StocktakeBulkFailure[]>([]);
  const lock = useRef(false);
  const accepted = useRef<StocktakeBulkTask | null>(validRestored ? restored?.accepted || null : null);
  const retry = useRef<{
    signature: string;
    request: StocktakeBulkRequest;
  } | null>(validRestored ? restored?.retry || null : null);
  const pending = sheet.lines.filter((line) => line.status === 'draft');
  const canConfirm = canUseStocktakeLines(useAccess(), 'confirm', pending);
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
  const finish = (result: StocktakeSheet) => {
    const failures = accepted.current?.status === 'success'
      ? accepted.current.failures ?? []
      : result.latestBulk?.failures ?? [];
    const submittedIds = retry.current?.request.lines.map(line => line.recordId)
      ?? pending.map(line => line.inventory.recordId);
    for (const id of confirmedStocktakeBulkDraftIds(result.lines, submittedIds, failures)) {
      drafts.delete(keyFor(id));
    }
    retry.current = null;
    accepted.current = null;
    journal?.deleteTask(journalKey);
    onSaved(result);
    setBulkFailures(failures);
    setPhase('success');
  };
  async function submit() {
    if (lock.current) return;
    if (!validRestored || journal?.recoveryBlocked(journalKey)) { setError(journal?.issue(journalKey) || '原批量请求记录无法核验，请联系管理员；原记录已保留'); setPhase('error'); return; }
    const hadPendingRequest = Boolean(retry.current || accepted.current);
    setError('');
    try {
      const progress = (task: StocktakeBulkTask) => {
        accepted.current = task.status === 'error' ? null : task;
        journal?.saveTask(journalKey, {retry: retry.current, accepted: accepted.current});
        setPhase('accepted');
        onAccepted?.(task);
      };
      if (accepted.current) {
        lock.current = true;
        setPhase('accepted');
        onSubmitting(true);
        const result = await waitStocktakeBulkTask(accepted.current, progress);
        finish(result);
        return;
      }
      if (!retry.current && pending.some(line => drafts.get(keyFor(line.inventory.recordId))?.retry)) throw new Error('请先核对原单条盘点请求，再办理批量确认');
      if (!canConfirm) throw new Error('当前权限不能确认所选盘点条目');
      if (!person) throw new Error('请从在职员工中选择确认人');
      const lines = retry.current?.request.lines || buildStocktakeBulkLines(sheet, drafts);
      const payload = {
        scope: 'review' as const,
        month: sheet.month,
        building: sheet.building,
        expectedVersion: sheet.version,
        confirmer: person,
        lines,
      };
      const signature = JSON.stringify(payload);
      if (!retry.current)
        retry.current = {
          signature,
          request: { ...payload, clientMutationId: crypto.randomUUID() },
        };
      journal?.saveTask(journalKey, {retry: retry.current, accepted: accepted.current});
      journal?.assertSaved(journalKey);
      lock.current = true;
      setPhase('submitting');
      onSubmitting(true);
      const result = await bulkConfirmStocktake(
        retry.current.request,
        progress,
      );
      finish(result);
    } catch (caught) {
      const status = (caught as {response?: {status?: number}})?.response?.status;
      if (!hadPendingRequest && !accepted.current && status && [400, 403, 404, 409, 422].includes(status)) { retry.current = null; journal?.deleteTask(journalKey); }
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
          {phase === 'success'
            ? bulkFailures.length ? '核盘部分确认' : '核盘已确认'
            : '一键确认库存核盘'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          确认当前楼栋全部待确认库存条目
        </DialogDescription>
        {phase === 'success' ? (
          bulkFailures.length ? (
            <div className="space-y-2">
              <p role="status" className="text-sm text-amber-700">
                {sheet.building}库存核盘部分确认：{bulkFailures.length} 项未确认，仍为草稿可单独重试；已确认项飞书同步中
              </p>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                {bulkFailures.map((failure) => (
                  <li key={failure.recordId}>
                    {failure.name}：{failure.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p role="status" className="text-sm text-green-700">
              {sheet.building}库存核盘已确认，飞书同步中
            </p>
          )
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
                disabled={phase === 'submitting' || phase === 'accepted' || Boolean(retry.current)}
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
                (!accepted.current && !canConfirm) ||
                (!pending.length && !accepted.current && !retry.current)
              }
              onClick={() => void submit()}
            >
              {phase === 'accepted'
                ? '处理中…'
                : phase === 'submitting'
                  ? '正在提交…'
                  : accepted.current
                    ? '查询处理结果'
                    : retry.current ? '核对原批量请求' : '确认本楼全部条目'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
