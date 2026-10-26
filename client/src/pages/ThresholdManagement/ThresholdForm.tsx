import { useState } from 'react';
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
  type ThresholdInput,
} from '@shared/threshold-management.interface';

export function ThresholdForm({
  initial,
  editing,
  error,
  uncertain,
  onClose,
  onSave,
}: {
  initial: ThresholdInput;
  editing: boolean;
  error: string;
  uncertain: boolean;
  onClose: () => void;
  onSave: (input: ThresholdInput) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [validation, setValidation] = useState('');
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
        disabled={uncertain}
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
                disabled={uncertain}
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
                disabled={uncertain}
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
                disabled={uncertain}
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
                disabled={uncertain}
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
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit">{uncertain ? '重试保存' : '保存'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
