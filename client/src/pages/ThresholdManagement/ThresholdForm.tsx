import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ThresholdDialogContent as DialogContent } from './ThresholdDialogContent';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  THRESHOLD_KINDS,
  type ThresholdCommand,
  type ThresholdInput,
  type ThresholdMutationResult,
  type ThresholdRecord,
} from '@shared/threshold-management.interface';
import { thresholdContentFingerprint } from '@shared/threshold-bitable';

export function ThresholdDirectEdit({ record, submit, onClose, onSaved }: {
  record: ThresholdRecord;
  submit: (command: ThresholdCommand, optimistic: ThresholdRecord | null, key: string) => Promise<ThresholdMutationResult>;
  onClose: () => void;
  onSaved: (result: ThresholdMutationResult) => void;
}) {
  const attempt = useRef<ThresholdCommand | null>(null);
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [failure, setFailure] = useState({ message: '', uncertain: false });

  async function execute(operation: 'update' | 'delete', input?: ThresholdInput) {
    if (inFlight.current || (attempt.current && attempt.current.operation !== operation)) return;
    const command = attempt.current ?? {
      operation,
      clientMutationId: `threshold-direct-${crypto.randomUUID()}`,
      id: record.id,
      expectedVersion: record.version,
      expectedContent: thresholdContentFingerprint(record),
      ...(input ? { record: input } : {}),
    };
    attempt.current = command;
    inFlight.current = true;
    setSaving(true);
    setFailure({ message: '', uncertain: false });
    try {
      const optimistic = command.operation === 'delete' ? null : { ...record, ...command.record };
      const result = await submit(command, optimistic, record.id);
      onSaved(result);
    } catch (error) {
      const cause = error as { message?: string; uncertain?: boolean };
      if (!cause.uncertain) attempt.current = null;
      setFailure({ message: cause.message || (operation === 'delete' ? '删除失败，请重试' : '保存失败，请重试'), uncertain: Boolean(cause.uncertain) });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const close = () => { if (!inFlight.current) onClose(); };
  const cancelDeletion = () => {
    if (inFlight.current) return;
    if (failure.uncertain) return close();
    setFailure({ message: '', uncertain: false });
    setConfirmingDelete(false);
  };
  if (confirmingDelete) return (
    <Dialog open onOpenChange={(open) => { if (!open) cancelDeletion(); }}>
      <DialogContent className="threshold-dialog">
        <DialogHeader>
          <DialogTitle>删除阈值</DialogTitle>
          <DialogDescription>{[record.profession, record.device, record.building, record.parameter].filter(Boolean).join(' · ')}</DialogDescription>
        </DialogHeader>
        <p>删除后，该规则将从阈值台账移除。</p>
        {failure.message && <p className="threshold-error" role="alert">{failure.message}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={cancelDeletion}>
            {failure.uncertain ? '关闭' : '取消'}
          </Button>
          <Button type="button" variant="destructive" disabled={saving} onClick={() => void execute('delete')}>
            {saving ? '删除中…' : failure.uncertain ? '重试删除' : '确认删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return <ThresholdForm initial={record} editing error={failure.message} uncertain={failure.uncertain}
    saving={saving} onClose={close} onSave={(input) => void execute('update', input)}
    onDelete={() => { setFailure({ message: '', uncertain: false }); setConfirmingDelete(true); }} />;
}

export function ThresholdForm({
  initial,
  editing,
  error,
  uncertain,
  saving,
  onClose,
  onSave,
  onDelete,
}: {
  initial: ThresholdInput;
  editing: boolean;
  error: string;
  uncertain: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (input: ThresholdInput) => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [validation, setValidation] = useState('');
  const locked = uncertain || saving;
  const field = (
    key: keyof ThresholdInput,
    label: string,
    required = false,
  ) => (
    <div className="threshold-field">
      <Label htmlFor={`threshold-${key}`}>
        {label}
        {required ? ' *' : ''}
      </Label>
      <Input
        id={`threshold-${key}`}
        value={draft[key] ?? ''}
        maxLength={160}
        required={required}
        disabled={locked}
        readOnly={editing && key === 'profession'}
        onChange={(event) =>
          setDraft((current) => ({ ...current, [key]: event.target.value }))
        }
      />
    </div>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="threshold-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑阈值' : '新增阈值'}</DialogTitle>
          <DialogDescription className="sr-only">
            填写设备参数及阈值
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !draft.profession.trim() ||
              !draft.device.trim() ||
              !draft.parameter.trim()
            ) {
              setValidation('专业、设备和参数不能为空');
              return;
            }
            setValidation('');
            onSave(draft);
          }}
        >
          {(validation || error) && (
            <p className="threshold-error" role="alert">
              {validation || error}
            </p>
          )}
          <div className="threshold-form-grid">
            {field('profession', '专业', true)}
            {field('device', '设备', true)}
            {field('parameter', '参数', true)}
            {field('section', '参数分组')}
            {field('model', '设备型号')}
            {field('brand', '品牌')}
            <div className="threshold-field">
              <Label htmlFor="threshold-kind">参数类型</Label>
              <NativeSelect
                id="threshold-kind"
                value={draft.kind}
                disabled={locked}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    kind: event.target.value as ThresholdInput['kind'],
                  }))
                }
              >
                {THRESHOLD_KINDS.map((kind) => (
                  <NativeSelectOption key={kind} value={kind}>
                    {kind}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="threshold-field">
              <Label htmlFor="threshold-building">楼栋</Label>
              <NativeSelect
                id="threshold-building"
                value={draft.building}
                disabled={locked}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    building: event.target.value,
                  }))
                }
              >
                <NativeSelectOption value="">待核对</NativeSelectOption>
                {['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'].map(
                  (building) => (
                    <NativeSelectOption key={building}>
                      {building}
                    </NativeSelectOption>
                  ),
                )}
              </NativeSelect>
            </div>
            {field('location', '位置')}
            {field('unit', '单位')}
            <div className="threshold-field threshold-span">
              <Label htmlFor="threshold-value">设定值</Label>
              <Textarea
                id="threshold-value"
                rows={3}
                maxLength={4000}
                value={draft.value}
                disabled={locked}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    value: event.target.value,
                  }))
                }
              />
            </div>
            {field('enabled', '告警使能')}
            {field('range', '运行范围')}
            <div className="threshold-field threshold-span">
              <Label htmlFor="threshold-note">备注</Label>
              <Textarea
                id="threshold-note"
                rows={2}
                maxLength={4000}
                value={draft.note}
                disabled={locked}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    note: event.target.value,
                  }))
                }
              />
            </div>
          </div>
          <DialogFooter className="mt-5">
            {onDelete && <Button type="button" variant="destructive" disabled={locked} onClick={onDelete}>删除阈值</Button>}
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>{saving ? '保存中…' : uncertain ? '重试保存' : '保存'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
