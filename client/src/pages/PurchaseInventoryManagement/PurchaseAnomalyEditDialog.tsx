import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  Loader2,
  PackageSearch,
  Save,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAccess } from '@/access/AccessProvider';
import { canEditPurchaseRecord } from '@/access/access-policy';
import { purchaseUiPrincipal, purchaseUiPrincipalKey } from './purchase-ui-principal';
import {
  searchPurchaseApplicationApplicants,
  updatePurchaseInventoryRecord,
} from '@/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { PurchaseApplicationApplicant } from '@shared/purchase-application.interface';
import type {
  PurchaseInventoryRequestItem,
  PurchaseRecordEditableStatus,
} from '@shared/purchase-inventory.interface';
import {
  buildPurchaseRecordChangedFields,
  createPurchaseRecordSubmissionGate,
  resolvePurchaseRecordRefresh,
  type PurchaseRecordEditDraft,
} from './purchase-record-edit.logic';
import { PurchasePrincipalRequestGate } from './purchase-principal-request-gate';

const BUILDINGS = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站'];
const STATUS_OPTIONS: Array<{
  value: PurchaseRecordEditableStatus;
  label: string;
}> = [
  { value: 'application', label: '待提交' },
  { value: 'approval', label: '审批中' },
  { value: 'executing', label: '待下单' },
  { value: 'receiving', label: '待到货签收' },
  { value: 'warehouse', label: '待入库确认' },
  { value: 'stocked', label: '已入库闭环' },
];
const STATUS_RANK = new Map(
  STATUS_OPTIONS.map((option, index) => [option.value, index]),
);

type EditDraft = PurchaseRecordEditDraft;

interface PurchaseRecordEditDialogProps {
  item: PurchaseInventoryRequestItem | null;
  issues?: string[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<boolean>;
}

export function PurchaseRecordEditDialog({
  item,
  issues = [],
  onOpenChange,
  onSaved,
}: PurchaseRecordEditDialogProps) {
  const access = useAccess();
  const principal = useMemo(
    () => purchaseUiPrincipal(access),
    [access],
  );
  const principalIdentityKey = `${purchaseUiPrincipalKey(principal)}:${item?.recordId || ''}`;
  const [principalRequestGate] = useState(
    () => new PurchasePrincipalRequestGate(principalIdentityKey),
  );
  const [submissionGate] = useState(() => createPurchaseRecordSubmissionGate());
  principalRequestGate.syncPrincipal(principalIdentityKey);
  const isPurchaseApplicant = principal.role === 'purchase_applicant';
  const canEditRecord = Boolean(item && canEditPurchaseRecord(principal, item));
  const initialDraft = useMemo(() => toDraft(item), [item]);
  const [draft, setDraft] = useState<EditDraft>(initialDraft);
  const [selectedApplicant, setSelectedApplicant] =
    useState<PurchaseApplicationApplicant | null>(null);
  const [applicantResults, setApplicantResults] = useState<
    PurchaseApplicationApplicant[]
  >([]);
  const [applicantLoading, setApplicantLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(initialDraft);
    setSelectedApplicant(null);
    setApplicantResults([]);
    setApplicantLoading(false);
    setSaving(false);
    setError('');
  }, [initialDraft]);

  useEffect(
    () => () => {
      principalRequestGate.invalidate();
    },
    [principalRequestGate],
  );

  useEffect(() => {
    if (!item || selectedApplicant || isPurchaseApplicant) return;
    const query = draft.applicantQuery.trim();
    if (!query || query === item.requester) {
      setApplicantResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      const requestToken = principalRequestGate.capture();
      setApplicantLoading(true);
      try {
        const results = await searchPurchaseApplicationApplicants({
          query,
          limit: 20,
        });
        if (!principalRequestGate.isCurrent(requestToken)) return;
        setApplicantResults(results);
      } catch {
        if (!principalRequestGate.isCurrent(requestToken)) return;
        setApplicantResults([]);
        toast.error('在职人员搜索失败');
      } finally {
        if (principalRequestGate.isCurrent(requestToken)) {
          setApplicantLoading(false);
        }
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    draft.applicantQuery,
    isPurchaseApplicant,
    item,
    principalRequestGate,
    selectedApplicant,
  ]);

  if (!item || !canEditRecord) return null;

  const requesterName =
    (isPurchaseApplicant ? item.requester : selectedApplicant?.name) ||
    (draft.applicantQuery.trim() === item.requester ? item.requester : '');
  const statusChanged = draft.status !== initialDraft.status;
  const statusMovedBackward =
    statusChanged &&
    (STATUS_RANK.get(draft.status) ?? 0) <
      (STATUS_RANK.get(initialDraft.status) ?? 0);
  const availableStatuses = item.executionRecordId
    ? STATUS_OPTIONS.filter((option) => option.value !== 'application')
    : STATUS_OPTIONS.filter(
        (option) =>
          option.value === 'application' || option.value === 'approval',
      );

  function updateDraft<K extends keyof EditDraft>(key: K, value: EditDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError('');
  }

  function selectApplicant(applicant: PurchaseApplicationApplicant) {
    setSelectedApplicant(applicant);
    setApplicantResults([]);
    setDraft((current) => ({
      ...current,
      applicantQuery: applicant.name,
      building: BUILDINGS.includes(applicant.building)
        ? applicant.building
        : current.building,
    }));
    setError('');
  }

  async function handleSave() {
    if (!canEditRecord) return;
    const validationMessage = validateDraft(
      draft,
      requesterName,
      !isPurchaseApplicant,
    );
    if (validationMessage) {
      setError(validationMessage);
      toast.warning(validationMessage);
      return;
    }

    const fields = buildPurchaseRecordChangedFields(
      principal,
      draft,
      initialDraft,
      selectedApplicant?.openId,
    );
    if (!Object.keys(fields).length) {
      setError('请至少修改一项采购数据后再提交');
      return;
    }
    if (!submissionGate.tryStart()) {
      return;
    }

    const recordId =
      item.executionRecordId || item.submissionRecordId || item.recordId;
    const requestToken = principalRequestGate.capture();
    setSaving(true);
    setError('');
    try {
      const result = await updatePurchaseInventoryRecord(recordId, {
        submissionRecordId: item.submissionRecordId,
        executionRecordId: item.executionRecordId,
        fields,
      });
      if (!principalRequestGate.isCurrent(requestToken)) return;
      const pageRefreshed = await resolvePurchaseRecordRefresh(onSaved);
      if (!principalRequestGate.isCurrent(requestToken)) return;
      if (pageRefreshed) {
        toast.success(
          `提交成功，已同步飞书多维表并刷新页面，用时 ${result.durationMs}ms`,
        );
      } else {
        toast.warning(
          '提交成功，飞书多维表已同步，但页面刷新失败，请点击“重新加载”',
        );
      }
      onOpenChange(false);
    } catch (saveError) {
      if (!principalRequestGate.isCurrent(requestToken)) return;
      const message = apiError(saveError, '提交失败，请稍后重试');
      setError(message);
      toast.error(message);
    } finally {
      submissionGate.finish();
      if (principalRequestGate.isCurrent(requestToken)) {
        setSaving(false);
      }
    }
  }

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 max-sm:h-[calc(100dvh-2rem)]">
        <DialogHeader className="border-b border-blue-100 bg-blue-50/70 px-5 py-4 pr-14 text-left sm:px-6">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-200">
              <PackageSearch className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-lg text-slate-950">
                {issues.length ? '采购异常详情与修复' : '采购记录编辑'}
              </DialogTitle>
              <DialogDescription className="mt-1 truncate text-xs text-slate-500">
                采购单号：{item.requestCode || '待生成'} · {item.statusLabel}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto">
          <section className="grid gap-3 border-b border-slate-100 bg-white px-5 py-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
            <Detail label="申请人" value={item.requester || '未填写'} />
            <Detail label="楼栋" value={item.building || '未匹配'} />
            <Detail
              label="采购分类"
              value={
                [item.primaryCategory, item.secondaryCategory]
                  .filter(Boolean)
                  .join(' · ') || '暂无'
              }
            />
            <Detail label="当前供应商" value={item.supplier || '暂无'} />
          </section>

          {issues.length > 0 && (
            <section className="border-b border-rose-100 bg-rose-50/55 px-5 py-3 sm:px-6">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-rose-700">
                  <AlertTriangle className="h-4 w-4" />
                  异常原因
                </span>
                {issues.map((issue) => (
                  <span
                    key={issue}
                    className="rounded-md border border-rose-200 bg-white px-2 py-1 text-[11px] font-semibold text-rose-700"
                  >
                    {issue}
                  </span>
                ))}
              </div>
            </section>
          )}

          <form
            className="grid gap-x-5 gap-y-4 bg-slate-50/65 px-5 py-5 sm:grid-cols-2 sm:px-6 lg:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <Field label="物品名称" required className="lg:col-span-2">
              <Input
                value={draft.itemName}
                disabled={saving}
                placeholder="填写准确的采购物品名称"
                onChange={(event) =>
                  updateDraft('itemName', event.target.value)
                }
              />
            </Field>

            <Field label="数量" required>
              <Input
                type="number"
                min="0.01"
                step="any"
                value={draft.quantity}
                disabled={saving}
                placeholder="填写采购数量"
                onChange={(event) =>
                  updateDraft('quantity', event.target.value)
                }
              />
            </Field>

            <Field label="计数单位" required>
              <Input
                value={draft.unit}
                disabled={saving}
                placeholder="如：件、盒、米"
                onChange={(event) => updateDraft('unit', event.target.value)}
              />
            </Field>

            {!isPurchaseApplicant ? (
              <Field label="申请楼栋" required>
                <Select
                  value={draft.building}
                  disabled={saving}
                  onValueChange={(value) => updateDraft('building', value)}
                >
                  <SelectTrigger className="w-full bg-white">
                    <Building2 className="h-4 w-4 text-slate-400" />
                    <SelectValue placeholder="选择楼栋" />
                  </SelectTrigger>
                  <SelectContent>
                    {BUILDINGS.map((building) => (
                      <SelectItem key={building} value={building}>
                        {building}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            <Field label="供应商">
              <Input
                value={draft.supplier}
                disabled={saving}
                placeholder="暂无"
                onChange={(event) =>
                  updateDraft('supplier', event.target.value)
                }
              />
            </Field>

            {!isPurchaseApplicant ? (
              <Field label="申请人" required className="relative lg:col-span-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={draft.applicantQuery}
                    disabled={saving}
                    className="pl-9"
                    placeholder="输入姓名模糊查找在职人员"
                    onChange={(event) => {
                      setSelectedApplicant(null);
                      updateDraft('applicantQuery', event.target.value);
                    }}
                  />
                  {applicantLoading && (
                    <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-blue-500" />
                  )}
                </div>
                {applicantResults.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white p-1 shadow-xl">
                    {applicantResults.map((applicant) => (
                      <button
                        key={applicant.recordId}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-xs hover:bg-blue-50"
                        onClick={() => selectApplicant(applicant)}
                      >
                        <span className="min-w-0">
                          <strong className="block truncate text-slate-800">
                            {applicant.name}
                          </strong>
                          <span className="mt-0.5 block truncate text-slate-400">
                            {applicant.position || '岗位暂无'}
                          </span>
                        </span>
                        <span className="shrink-0 text-blue-600">
                          {applicant.building || '楼栋暂无'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            ) : null}

            <Field label="计划到货日期">
              <div className="relative">
                <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  type="date"
                  value={draft.expectedArrival}
                  disabled={saving}
                  className="pl-9"
                  onChange={(event) =>
                    updateDraft('expectedArrival', event.target.value)
                  }
                />
              </div>
            </Field>

            {principal.role === 'admin' ? (
              <Field label="采购状态">
                <Select
                  value={draft.status}
                  disabled={saving}
                  onValueChange={(value) =>
                    updateDraft('status', value as PurchaseRecordEditableStatus)
                  }
                >
                  <SelectTrigger className="w-full bg-white">
                    <ShieldCheck className="h-4 w-4 text-blue-500" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableStatuses.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            <Field label="补充备注" className="sm:col-span-2 lg:col-span-3">
              <Textarea
                value={draft.notes}
                disabled={saving}
                className="min-h-20 resize-y bg-white"
                placeholder="填写采购补充信息"
                onChange={(event) => updateDraft('notes', event.target.value)}
              />
            </Field>

            {statusMovedBackward && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:col-span-2 lg:col-span-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>状态回退会清除后续节点、完成标记和相关时间。</span>
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 sm:col-span-2 lg:col-span-3"
              >
                <span>{error}</span>
              </div>
            )}
          </form>
        </div>

        <DialogFooter className="border-t border-slate-100 bg-white px-5 py-4 sm:px-6">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={saving || !canEditRecord}
            onClick={() => void handleSave()}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? '提交中' : '提交'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required = false,
  className = '',
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={className}>
      <span className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-slate-700">
        {label}
        {required && <span className="text-rose-500">*</span>}
      </span>
      {children}
    </label>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="block text-[11px] text-slate-400">{label}</span>
      <span className="mt-1 block truncate text-xs font-semibold text-slate-700">
        {value}
      </span>
    </div>
  );
}

function toDraft(item: PurchaseInventoryRequestItem | null): EditDraft {
  return {
    itemName: item?.title === '未命名物品' ? '' : item?.title || '',
    quantity: item && item.quantity > 0 ? String(item.quantity) : '',
    unit: item?.unit || '',
    building: item?.building || '',
    supplier: item?.supplier || '',
    expectedArrival: toDateInput(item?.expectedArrival || null),
    notes: item?.notes || '',
    applicantQuery: item?.requester || '',
    status: toEditableStatus(item),
  };
}

function toEditableStatus(
  item: PurchaseInventoryRequestItem | null,
): PurchaseRecordEditableStatus {
  if (!item) return 'application';
  if (item.stage === 'rejected') return 'approval';
  if (
    item.stage === 'inbound' ||
    (item.stage === 'receiving' && item.statusLabel.includes('入库'))
  ) {
    return 'warehouse';
  }
  return item.stage;
}

function validateDraft(
  draft: EditDraft,
  requesterName: string,
  requireProtectedFields: boolean,
): string {
  if (!draft.itemName.trim()) return '请填写物品名称';
  if (!Number.isFinite(Number(draft.quantity)) || Number(draft.quantity) <= 0) {
    return '采购数量必须大于 0';
  }
  if (!draft.unit.trim()) return '请填写计数单位';
  if (requireProtectedFields && !BUILDINGS.includes(draft.building)) {
    return '请选择申请楼栋';
  }
  if (requireProtectedFields && !requesterName.trim()) {
    return '请从在职人员表选择申请人';
  }
  return '';
}

function toDateInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function apiError(error: unknown, fallback: string): string {
  const candidate = error as {
    message?: string;
    response?: { data?: { message?: string | { message?: string } } };
  };
  const responseMessage = candidate?.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim()) {
    return responseMessage;
  }
  if (
    responseMessage &&
    typeof responseMessage === 'object' &&
    typeof responseMessage.message === 'string'
  ) {
    return responseMessage.message;
  }
  return candidate?.message || fallback;
}
