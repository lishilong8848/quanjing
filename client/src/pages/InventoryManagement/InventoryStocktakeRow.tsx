import { StocktakeDraftJournal, prepareStocktakeLineRetry, settleStocktakeLineDraft, discardEditableStocktakeDraft } from './stocktake-draft-journal';
import { memo, useEffect, useRef, useState } from 'react';
import { useAccess } from '@/access/AccessProvider';
import { canUseStocktakeAction } from './stocktake-action-access';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type {
  StocktakeLine,
  StocktakeLineRequest,
  StocktakeScope,
} from '@shared/inventory-stocktake.interface';
import type { PurchaseApplicationApplicant } from '@shared/purchase-application.interface';
import {
  StocktakeEmployeePicker,
  type StocktakePeopleSearch,
} from './StocktakeEmployeePicker';
import { writeStocktakeLine } from './inventory-stocktake.api';
import {
  parseStocktakeQuantity,
  stocktakeError,
  isStocktakeDraftDirty,
} from './inventory-stocktake.logic';

export interface StocktakeLocalDraft {
  baseVersion?: number;
  quantity: string;
  person: PurchaseApplicationApplicant | null;
  note: string;
  dirty: boolean;
  retry: { signature: string; request: StocktakeLineRequest } | null;
}
export const InventoryStocktakeRow = memo(function InventoryStocktakeRow({
  line,
  month,
  scope = 'sample',
  readOnly,
  searchPeople,
  onSaved,
  onBusy,
  drafts,
}: {
  line: StocktakeLine;
  month: string;
  scope?: StocktakeScope;
  readOnly: boolean;
  searchPeople: StocktakePeopleSearch;
  onSaved: (line: StocktakeLine, sheetVersion: number) => void;
  onBusy: (recordId: string, busy: boolean) => void;
  drafts: Map<string, StocktakeLocalDraft>;
}) {
  const principal = useAccess();
  const canUpdate = canUseStocktakeAction(principal, 'update', line.inventory);
  const canConfirm = canUseStocktakeAction(principal, 'confirm', line.inventory);
  const draftKey = `${scope}:${month}:${line.inventory.building}:${line.inventory.recordId}`;
  const cached = line.status === 'confirmed' || readOnly || (!canUpdate && !canConfirm) ? undefined : drafts.get(draftKey);
  const [quantity, setQuantity] = useState(
    cached?.quantity ??
      (line.actualQuantity === null ? '' : String(line.actualQuantity)),
  );
  const [person, setPerson] = useState(cached ? cached.person : line.confirmer);
  const [note, setNote] = useState(cached?.note ?? line.note);
  const [, refreshJournal] = useState(0);
  const [phase, setPhase] = useState<
    'ready' | 'submitting' | 'success' | 'error'
  >(cached?.retry ? 'error' : 'ready');
  const [error, setError] = useState(cached?.retry ? '上次保存结果待核对，请使用原请求重试。' : '');
  const dirty = isStocktakeDraftDirty(line, { quantity, person, note });
  const inFlight = useRef(false);
  const retry = useRef<{
    signature: string;
    request: StocktakeLineRequest;
  } | null>(cached?.retry ?? null);
  useEffect(() => {
    if (!dirty && !retry.current) {
      drafts.delete(draftKey);
      return;
    }
    drafts.set(draftKey, {
      baseVersion: cached?.baseVersion ?? line.version,
      quantity,
      person,
      note,
      dirty,
      retry: retry.current,
    });
    const issue = drafts instanceof StocktakeDraftJournal ? drafts.issue(draftKey) : '';
    if (issue) { setError(issue); setPhase('error'); }
  }, [drafts, draftKey, quantity, person, note, dirty]);
  useEffect(() => {
    if (line.status === 'confirmed') {
      setQuantity(String(line.actualQuantity));
      setPerson(line.confirmer);
      setNote(line.note);
      if (drafts instanceof StocktakeDraftJournal) drafts.clearConfirmed(draftKey);
      else drafts.delete(draftKey);
    }
  }, [
    line.status,
    line.actualQuantity,
    line.confirmer,
    line.note,
    drafts,
    draftKey,
  ]);
  const unresolved = Boolean(retry.current);
  let retryMode: 'draft' | 'confirm' | 'refresh-line' | undefined;
  try { retryMode = retry.current ? JSON.parse(retry.current.signature)[0] : undefined; } catch { /* Keep malformed pending requests locked. */ }
  const journalIssue = drafts instanceof StocktakeDraftJournal ? drafts.issue(draftKey) : '';
  const bulkPending = scope === 'review' && drafts instanceof StocktakeDraftJournal && Boolean(drafts.readTask(`bulk:review:${month}:${line.inventory.building}`));
  const staleDraft = cached?.baseVersion !== undefined && cached.baseVersion !== line.version && !unresolved;
  const actionLocked = Boolean(bulkPending) || readOnly || (!canUpdate && !canConfirm) || line.status === 'confirmed' || phase === 'submitting' || (drafts instanceof StocktakeDraftJournal && drafts.recoveryBlocked(draftKey)) || staleDraft;
  const canDiscardStaleDraft = !readOnly && (canUpdate || canConfirm) && !bulkPending && !unresolved && phase !== 'submitting' && !(drafts instanceof StocktakeDraftJournal && drafts.recoveryBlocked(draftKey));
  const locked = Boolean(bulkPending) || unresolved || staleDraft || Boolean(journalIssue) ||
    readOnly || (!canUpdate && !canConfirm) || line.status === 'confirmed' || phase === 'submitting';
  const difference =
    quantity.trim() && Number.isFinite(Number(quantity))
      ? Math.round((Number(quantity) - line.inventory.quantity) * 1000) / 1000
      : null;
  const edit = () => {
    setPhase('ready');
    setError('');
  };
  async function submit(mode: 'draft' | 'confirm' | 'refresh-line') {
    if (inFlight.current || actionLocked) return;
    if (retry.current && retryMode !== mode) return;
    const hadPendingRequest = Boolean(retry.current);
    if (mode === 'confirm' ? !canConfirm : !canUpdate) return;
    let actualQuantity: number | null;
    try {
      actualQuantity = retry.current ? retry.current.request.actualQuantity : parseStocktakeQuantity(quantity);
      if (mode === 'confirm' && !retry.current) {
        if (actualQuantity === null) throw new Error('请填写实际数量');
        if (!person) throw new Error('请从在职员工中选择确认人');
        if (difference !== 0 && !note.trim()) throw new Error('请填写差异说明');
      }
    } catch (caught) {
      setPhase('error');
      setError(stocktakeError(caught));
      return;
    }
    const payload = {
      scope,
      month,
      building: line.inventory.building as StocktakeLineRequest['building'],
      recordId: line.inventory.recordId,
      expectedVersion: line.version,
      actualQuantity,
      confirmer: person,
      note,
    };
    retry.current = prepareStocktakeLineRetry(mode, payload, retry.current, () => crypto.randomUUID());
    drafts.set(draftKey, {
      quantity,
      person,
      note,
      dirty,
      retry: retry.current,
    });
    try { if (drafts instanceof StocktakeDraftJournal) drafts.assertSaved(draftKey); }
    catch (caught) { setPhase('error'); setError(stocktakeError(caught)); return; }
    inFlight.current = true;
    setPhase('submitting');
    setError('');
    onBusy(line.inventory.recordId, true);
    try {
      const result = await writeStocktakeLine(mode, retry.current.request);
      retry.current = null;
      settleStocktakeLineDraft(drafts, draftKey, result.line, {quantity, person, note});
      onSaved(result.line, result.sheetVersion);
      const persistenceIssue = drafts instanceof StocktakeDraftJournal ? drafts.issue(draftKey) : '';
      setError(persistenceIssue);
      setPhase(persistenceIssue ? 'error' : 'success');
    } catch (caught) {
      const status = (caught as {response?: {status?: number}})?.response?.status;
      if (!hadPendingRequest && status && [400, 403, 404, 409, 422].includes(status)) {
        retry.current = null;
        drafts.set(draftKey, {baseVersion: line.version, quantity, person, note, dirty, retry: null});
      }
      setPhase('error');
      setError(stocktakeError(caught));
    } finally {
      inFlight.current = false;
      onBusy(line.inventory.recordId, false);
    }
  }
  return (
    <article
      className="stocktake-row"
      aria-label={`${line.inventory.name}盘点`}
    >
      <div className="stocktake-item">
        <strong>{line.inventory.name}</strong>
        <small>
          {[line.inventory.sku, line.inventory.specification]
            .filter(Boolean)
            .join(' · ')}
        </small>
        <span className="stocktake-mobile-location">
          {line.inventory.location}
        </span>
      </div>
      <span className="stocktake-location">
        {line.inventory.location || '—'}
      </span>
      <div className="stocktake-reasons">
        {line.reasons.map((reason) => (
          <Badge
            variant="outline"
            className={
              reason === 'random'
                ? 'border-blue-100 bg-blue-50 text-blue-700'
                : 'border-amber-200 bg-amber-50 text-amber-800'
            }
            key={reason}
          >
            {reason === 'random' ? '抽查' : '变动'}
          </Badge>
        ))}
      </div>
      <div className="stocktake-number">
        <span className="stocktake-mobile-label">台账</span>
        {line.inventory.quantity}
        <small>{line.inventory.unit}</small>
      </div>
      <label>
        <span className="stocktake-mobile-label">实盘</span>
        <Input
          aria-label={`${line.inventory.name}实际数量`}
          inputMode="decimal"
          value={quantity}
          placeholder="数量"
          disabled={locked}
          onChange={(e) => {
            setQuantity(e.target.value);
            edit();
          }}
        />
      </label>
      <div
        className={`stocktake-number ${difference ? 'stocktake-difference' : ''}`}
      >
        <span className="stocktake-mobile-label">差异</span>
        {difference === null
          ? '—'
          : difference > 0
            ? `+${difference}`
            : difference}
      </div>
      <div className="stocktake-confirmer">
        <span className="stocktake-mobile-label">确认人</span>
        {line.status === 'confirmed' ? (
          <span>
            {line.confirmer?.name}
            <small className="stocktake-confirmed-time">
              {line.confirmedAt
                ? new Date(line.confirmedAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'Asia/Shanghai',
                  })
                : ''}
            </small>
          </span>
        ) : (
          <StocktakeEmployeePicker
            label={`${line.inventory.name}确认人`}
            value={person}
            disabled={locked}
            search={searchPeople}
            onChange={(p) => {
              setPerson(p);
              edit();
            }}
          />
        )}
      </div>
      <div className="stocktake-row-actions">
        {line.status === 'confirmed' ? (
          <Badge
            variant="outline"
            className="border-green-200 bg-green-50 text-green-700"
          >
            已确认
          </Badge>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={actionLocked || !canUpdate || (unresolved && retryMode !== 'draft')}
              onClick={() => void submit('draft')}
            >
              {unresolved && retryMode === 'draft' ? '核对原暂存' : '暂存'}
            </Button>
            <Button
              size="sm"
              disabled={actionLocked || !canConfirm || (unresolved && retryMode !== 'confirm')}
              onClick={() => void submit('confirm')}
            >
              {phase === 'submitting' ? '保存中' : unresolved && retryMode === 'confirm' ? '核对原确认' : '确认'}
            </Button>
          </>
        )}
      </div>
      {difference !== null && difference !== 0 && (
        <label className="stocktake-line-note">
          <span>差异说明</span>
          <Input
            aria-label={`${line.inventory.name}差异说明`}
            value={note}
            disabled={locked}
            maxLength={1000}
            onChange={(e) => {
              setNote(e.target.value);
              edit();
            }}
          />
        </label>
      )}
      {bulkPending && <div role="status" className="stocktake-line-feedback">本楼批量请求结果待核对，请打开批量确认查询原任务。</div>}
      {unresolved && retryMode === 'refresh-line' && <Button size="sm" variant="outline" disabled={actionLocked || !canUpdate} onClick={() => void submit('refresh-line')}>核对原台账刷新</Button>}
      {journalIssue && <div role="alert" className="stocktake-line-feedback">{journalIssue}
        {drafts instanceof StocktakeDraftJournal && drafts.canDiscardObsoleteDraft(draftKey) && <Button size="sm" variant="outline" disabled={readOnly || (!canUpdate && !canConfirm) || Boolean(bulkPending) || unresolved || phase === 'submitting'} onClick={() => {
          if (readOnly || (!canUpdate && !canConfirm) || bulkPending || unresolved || phase === 'submitting') return;
          if (!drafts.discardObsoleteDraft(draftKey)) { setError('旧草稿未能清理，原记录已保留'); setPhase('error'); return; }
          setQuantity(line.actualQuantity === null ? '' : String(line.actualQuantity)); setPerson(line.confirmer); setNote(line.note); setError(''); setPhase('ready'); refreshJournal(value => value + 1);
        }}>放弃旧草稿，重新核对</Button>}
      </div>}
      {staleDraft && <div role="alert">服务器盘点数据已更新，原草稿已保留。<Button variant="outline" size="sm" disabled={!canDiscardStaleDraft} onClick={() => { if (!discardEditableStocktakeDraft(drafts, draftKey, canDiscardStaleDraft)) { setError('原草稿未能清理，内容已保留，请重试'); setPhase('error'); return; } setQuantity(line.actualQuantity === null ? '' : String(line.actualQuantity)); setPerson(line.confirmer); setNote(line.note); setError(''); setPhase('ready'); }}>使用服务器最新数据</Button></div>}
      {(dirty || phase === 'error' || phase === 'success') &&
        line.status !== 'confirmed' && (
          <div
            className="stocktake-line-feedback"
            role={phase === 'error' ? 'alert' : 'status'}
          >
            {phase === 'error' ? (
              <>
                <span>{error}</span>
                {canUpdate && !unresolved && error.includes('库存已变化') && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void submit('refresh-line')}
                  >
                    更新台账数量
                  </Button>
                )}
              </>
            ) : phase === 'success' && !dirty ? (
              '草稿已保存'
            ) : dirty ? (
              '未保存'
            ) : null}
          </div>
        )}
    </article>
  );
});
