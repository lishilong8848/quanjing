import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ThresholdDialogContent as DialogContent } from './ThresholdDialogContent';
import type { ThresholdRecord } from '@shared/threshold-management.interface';
import type {
  ThresholdAdjustment,
  ThresholdAdjustmentContext,
  ThresholdAdjustmentInput,
} from '@shared/threshold-adjustment.interface';
import { THRESHOLD_ADJUSTMENT_LABELS } from '@shared/threshold-adjustment.interface';
import { thresholdContentFingerprint } from '@shared/threshold-bitable';
import { isUncertainThresholdError, thresholdError } from './api';

export function ThresholdAdjustmentForm({
  record,
  context,
  canDelegate,
  onSubmit,
  onClose,
  onRefreshContext,
}: {
  record: ThresholdRecord;
  context: ThresholdAdjustmentContext;
  canDelegate: boolean;
  onSubmit: (input: ThresholdAdjustmentInput) => Promise<ThresholdAdjustment>;
  onClose: () => void;
  onRefreshContext: () => void;
}) {
  const [value, setValue] = useState(record.value),
    [reason, setReason] = useState(''),
    [planned, setPlanned] = useState(() => {
      const next = new Date(Date.now() + 3600000);
      next.setMinutes(0, 0, 0);
      return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}T${String(next.getHours()).padStart(2, '0')}:00`;
    });
  const [engineer, setEngineer] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const request = useRef<ThresholdAdjustmentInput | undefined>(undefined);
  const inFlight = useRef(false);
  const engineers = useMemo(
    () =>
      context.engineers.filter(
        (p) =>
          p.profession === record.profession &&
          p.buildings.includes(record.building),
      ),
    [context.engineers, record.profession, record.building],
  );
  const selected = canDelegate
    ? engineer || engineers[0]?.openId || ''
    : context.applicant?.openId || '';
  const buildingApprovers = context.roles.filter(
    (p) =>
      ['设施运维示例人员001', 'H楼值班示例人员001'].includes(p.position) &&
      p.buildings.includes(record.building),
  );
  const professionalApprovers = context.roles.filter(
    (p) =>
      [
        `${record.profession}示例人员001`,
        `${record.profession}专业示例人员001`,
        `${record.profession}示例人员001工程师`,
      ].includes(p.position) && p.professions.includes(record.profession),
  );
  const eligible =
    context.applicant &&
    engineers.some((p) => p.openId === selected) &&
    buildingApprovers.length === 1 &&
    professionalApprovers.length === 1;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    if (
      !uncertain &&
      (value === record.value ||
        !reason.trim() ||
        !Number.isFinite(Date.parse(planned)) ||
        !eligible)
    ) {
      setError('请填写新的阈值、预计调整时间、调整原因，并选择对应工程师');
      return;
    }
    const command = request.current || {
      clientMutationId: `threshold-${crypto.randomUUID()}`,
      thresholdId: record.id,
      expectedVersion: record.version,
      expectedContent: thresholdContentFingerprint(record),
      value,
      reason: reason.trim(),
      plannedAt: new Date(planned).toISOString(),
      engineerOpenId: selected,
    };
    request.current = command;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await onSubmit(command);
      onClose();
    } catch (cause) {
      const unknown = isUncertainThresholdError(cause);
      setUncertain(unknown);
      setError(thresholdError(cause));
      if (!unknown) request.current = undefined;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="threshold-dialog threshold-adjustment-dialog">
        <DialogHeader>
          <DialogTitle>阈值调整申请</DialogTitle>
          <DialogDescription className="sr-only">
            填写新阈值、预计调整时间与原因，楼长和专业示例人员001审批后由工程师确认完成。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => void submit(event)}
          className="threshold-adjustment-form"
        >
          <div className="threshold-adjustment-object">
            <strong>{record.parameter}</strong>
            <span>
              {[
                record.profession,
                record.building,
                record.device,
                record.location,
                record.model,
                record.brand,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          <div className="threshold-adjustment-values">
            <div>
              <span>原阈值{record.unit ? `（${record.unit}）` : ''}</span>
              <pre>{record.value || '空白'}</pre>
            </div>
            <label>
              新阈值{record.unit ? `（${record.unit}）` : ''}
              <Textarea
                aria-label="新阈值"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                readOnly={busy || uncertain}
                maxLength={4000}
                rows={3}
              />
            </label>
          </div>
          <div className="threshold-adjustment-fields">
            <label>
              调整工程师
              <NativeSelect
                aria-label="调整工程师"
                value={selected}
                disabled={!canDelegate || busy || uncertain}
                onChange={(event) => setEngineer(event.target.value)}
              >
                <NativeSelectOption value="">选择工程师</NativeSelectOption>
                {engineers.map((p) => (
                  <NativeSelectOption key={p.openId} value={p.openId}>
                    {p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label>
              预计调整时间
              <Input
                aria-label="预计调整时间"
                type="datetime-local"
                required={!uncertain}
                value={planned}
                disabled={busy || uncertain}
                onChange={(event) => setPlanned(event.target.value)}
              />
            </label>
          </div>
          <label>
            调整原因
            <Textarea
              aria-label="调整原因"
              required={!uncertain}
              value={reason}
              readOnly={busy || uncertain}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              rows={3}
            />
          </label>
          <div className="threshold-approval-route">
            <div>
              <span>申请人</span>
              <strong>
                {context.applicant?.name || '请使用本人飞书账号登录'}
              </strong>
            </div>
            <div>
              <span>楼长审批</span>
              <strong>
                {buildingApprovers.map((p) => p.name).join('、') || '未配置'}
              </strong>
            </div>
            <div>
              <span>专业示例人员001审批</span>
              <strong>
                {professionalApprovers.map((p) => p.name).join('、') ||
                  '未配置'}
              </strong>
            </div>
          </div>
          {context.error && (
            <div className="threshold-error" role="alert">
              {context.error}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRefreshContext}
              >
                重试人员读取
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="threshold-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy || !eligible}>
              {busy ? '正在提交' : uncertain ? '核对并重试' : '提交审批'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function ThresholdAdjustmentHistory({
  records,
  error,
  onClose,
  onRetry,
}: {
  records: ThresholdAdjustment[];
  error: string;
  onClose: () => void;
  onRetry: (id: string) => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="threshold-dialog threshold-adjustment-history">
        <DialogHeader>
          <DialogTitle>阈值调整记录</DialogTitle>
          <DialogDescription className="sr-only">
            调整申请的审批、工程师确认与生效状态。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="threshold-error">
            {error}
          </p>
        )}
        <div className="threshold-adjustment-history-list">
          {records.length ? (
            records.map((a) => (
              <article key={a.id}>
                <div className="threshold-adjustment-history-heading">
                  <strong>
                    {a.before.building} · {a.before.device} ·{' '}
                    {a.before.parameter}
                  </strong>
                  <span>{THRESHOLD_ADJUSTMENT_LABELS[a.state]}</span>
                </div>
                <div className="threshold-adjustment-history-values">
                  {a.before.value || '空白'} → {a.value || '空白'}
                </div>
                <p>
                  申请：{a.applicant.name} · 调整：{a.engineer.name} · 预计：
                  {new Date(a.plannedAt).toLocaleString('zh-CN', {
                    hour12: false,
                  })}
                </p>
                <p>
                  {a.stages
                    .map(
                      (s) =>
                        `${s.role === 'building' ? '楼长' : '专业示例人员001'} ${s.approver.name}：${s.decision ? (s.decision.action === 'approve' ? '通过' : '驳回') : '待审批'}`,
                    )
                    .join(' · ')}
                </p>
                {a.stages
                  .filter((s) => s.decision?.action === 'reject')
                  .map((s) => (
                    <p key={s.role}>驳回原因：{s.decision!.reason}</p>
                  ))}
                {a.execution?.replies.map((r) => (
                  <p key={r.eventId}>
                    {r.actor.name}：{r.completed ? '已完成' : '尚未完成'} ·{' '}
                    {new Date(r.at).toLocaleString('zh-CN', { hour12: false })}
                  </p>
                ))}
                {a.error && (
                  <div className="threshold-error" role="alert">
                    {a.error}
                    {a.state !== 'conflict' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onRetry(a.id)}
                      >
                        重试同步
                      </Button>
                    )}
                  </div>
                )}
              </article>
            ))
          ) : (
            <p>暂无调整记录</p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
