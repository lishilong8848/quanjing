import { isProfessionalBusinessPrincipal, canPerformBusinessAction } from '@shared/business-permissions';
import { accessBuildings } from '@shared/building-access';
import { PROFESSIONAL_SPECIALTIES } from '@shared/professional-access';
import { useAccess } from '@/access/AccessProvider';
import { hasAuthenticatedAccessIdentity } from '../../access/access-policy';
import { isPersonalAccessAccount } from '@shared/self-service-applicant';
import { canUseInventoryAction } from './inventory-action-access';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarClock,
  CheckCircle2,
  History,
  Loader2,
  MapPin,
  PackageSearch,
  Search,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  createInventoryMovement,
  getInventoryMovementOptions,
  searchInventoryApplicants,
} from '@/api';
import { Badge } from '@/components/ui/badge';
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
import { Label } from '@/components/ui/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { WarehouseStorageLocationField } from './WarehouseStorageLocationField';
import type {
  InventoryExistingInboundMovementCreateRequest,
  InventoryInboundItemMode,
  InventoryMovementCreateRequest,
  InventoryMovementItem,
  InventoryMovementOptionItem,
  InventoryMovementType,
  InventoryNewInboundMovementCreateRequest,
  InventoryNewItemInput,
  InventoryOutboundMovementCreateRequest,
  InventoryOutboundMovementItem,
  WarehouseBuilding,
  WarehouseStorageLocation,
} from '@shared/inventory-management.interface';
import {
  INVENTORY_NEW_ITEM_CATEGORY_OPTIONS,
  WAREHOUSE_BUILDINGS,
  getInventorySecondaryCategoryOptions,
} from '@shared/inventory-management.interface';
import type { PurchaseApplicationApplicant } from '@shared/purchase-application.interface';

const TYPE_META = {
  inbound: {
    title: '办理入库',
    description: '登记到货物品、入库数量和所属楼栋',
    icon: ArrowDownToLine,
    accent: 'bg-emerald-500',
  },
  outbound: {
    title: '办理出库',
    description: '登记领用人、出库用途、来源楼栋和数量',
    icon: ArrowUpFromLine,
    accent: 'bg-blue-500',
  },
  borrow: {
    title: '发起借调',
    description: '登记申请人、经办人、借调原因和预计归还时间',
    icon: History,
    accent: 'bg-amber-500',
  },
} as const;

export const INVENTORY_OUTBOUND_REASON_MAX_LENGTH = 2_000;
// The movement-options API reserves zero for an untruncated building snapshot.
const INVENTORY_OPTION_SNAPSHOT_LIMIT = 0;
const INVENTORY_STALE_SNAPSHOT_WARNING =
  '库存更新失败，当前展示缓存数据；提交时系统会再次校验';
const INVENTORY_OPTION_PICKER_LIMIT = 100;
const inventoryMovementOptionSnapshotCache = new Map<
  string,
  InventoryMovementOptionItem[]
>();
const INVENTORY_OUTBOUND_REASON_REQUIRED_ERROR = '请填写出库原因或使用地点';
const INVENTORY_OUTBOUND_REASON_MAX_LENGTH_ERROR =
  '出库原因或使用地点不能超过 2000 个字符';

export interface InventoryInboundDraft {
  clientMutationId?: string;
  mode: InventoryInboundItemMode;
  building: WarehouseBuilding;
  quantity: string;
  occurredAt: string;
  itemQuery: string;
  selectedItem: InventoryMovementOptionItem | null;
  newItem: InventoryNewItemInput;
}

export interface InventoryInboundSubmission {
  clientMutationId: string;
  startedAt: number;
  request:
    | InventoryExistingInboundMovementCreateRequest
    | InventoryNewInboundMovementCreateRequest;
  optimisticMovement: InventoryMovementItem;
  draft: InventoryInboundDraft;
}

export interface InventoryOutboundDraft {
  clientMutationId?: string;
  building: WarehouseBuilding;
  quantity: string;
  occurredAt: string;
  itemQuery: string;
  selectedItem: InventoryMovementOptionItem | null;
  applicant: PurchaseApplicationApplicant | null;
  reason: string;
}

export interface InventoryOutboundSubmission {
  clientMutationId: string;
  startedAt: number;
  request: InventoryOutboundMovementCreateRequest;
  optimisticMovement: InventoryOutboundMovementItem;
  draft: InventoryOutboundDraft;
}

interface InventoryMovementCreateDialogProps {
  type: InventoryMovementType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialBuilding?: WarehouseBuilding;
  initialDraft?: InventoryInboundDraft;
  initialOutboundDraft?: InventoryOutboundDraft;
  retryLocked?: boolean;
  onAbandonRetry?: () => void;
  onSubmit?: (submission: InventoryInboundSubmission) => boolean | void;
  onOutboundSubmit?: (
    submission: InventoryOutboundSubmission,
  ) => Promise<boolean> | boolean | void;
  onOutboundBatchSubmit?: (submissions: InventoryOutboundSubmission[]) => boolean;
  outboundBatchBlocked?: boolean;
  onCreated: () => void;
}

interface FormState {
  building: WarehouseBuilding;
  destinationBuilding: WarehouseBuilding | '';
  quantity: string;
  occurredAt: string;
  reason: string;
  expectedReturnAt: string;
}

interface MutableGuard {
  current: boolean;
}

interface MutableSequence {
  current: number;
}

export async function handoffSubmissionOnce<T>(
  guard: MutableGuard,
  createSubmission: () => T,
  handoff: (submission: T) => Promise<boolean> | boolean | void,
): Promise<boolean> {
  if (guard.current) return false;
  guard.current = true;
  try {
    const accepted = await handoff(createSubmission());
    if (accepted === false) {
      guard.current = false;
      return false;
    }
    return true;
  } catch (error) {
    guard.current = false;
    throw error;
  }
}

export function beginLatestRequest(sequence: MutableSequence): number {
  sequence.current += 1;
  return sequence.current;
}

export function invalidateLatestRequest(sequence: MutableSequence): void {
  sequence.current += 1;
}

export function isLatestRequest(
  sequence: MutableSequence,
  requestSequence: number,
): boolean {
  return sequence.current === requestSequence;
}

const EMPTY_NEW_ITEM: InventoryNewItemInput = {
  primaryCategory: '',
  secondaryCategory: '',
  name: '',
  specification: '',
  location: '',
  locationRecordId: '',
};

export function validateInventoryInboundDraft(
  draft: InventoryInboundDraft,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const quantity = Number(draft.quantity);
  const occurredAt = Date.parse(draft.occurredAt);

  if (!draft.building) errors.building = '请选择入库楼栋';
  if (!Number.isInteger(quantity) || quantity <= 0) {
    errors.quantity = '数量必须为正整数';
  }
  if (!draft.occurredAt || !Number.isFinite(occurredAt)) {
    errors.occurredAt = '请选择有效的办理时间';
  }

  if (draft.mode === 'existing') {
    if (!draft.selectedItem) {
      errors.item = '请选择已有物品';
    } else if (draft.selectedItem.building !== draft.building) {
      errors.item = '请选择当前入库楼栋的物品';
    } else if (
      !draft.selectedItem.inventoryRecordId.trim() ||
      !draft.selectedItem.location.trim()
    ) {
      errors.item = '所选物品未配置库存库位，请先配置库位';
    } else if (
      !draft.selectedItem.catalogRecordId.trim() ||
      !draft.selectedItem.sku.trim()
    ) {
      errors.item = '所选物品数据不完整，请重新选择';
    }
  } else {
    if (!draft.newItem.primaryCategory.trim()) {
      errors.primaryCategory = '请填写一级分类';
    }
    if (!draft.newItem.secondaryCategory.trim()) {
      errors.secondaryCategory = '请填写二级分类';
    }
    if (!draft.newItem.name.trim()) errors.name = '请填写物品名称';
    if (!draft.newItem.specification.trim()) {
      errors.specification = '请填写规格型号';
    }
    if (!draft.newItem.location.trim()) {
      errors.location = '请填写存放位置';
    } else if (!draft.newItem.locationRecordId?.trim()) {
      errors.location = '请从库位底表选择存放位置';
    }
  }

  return errors;
}

export function buildInventoryInboundSubmission({
  draft,
  clientMutationId,
  startedAt,
}: {
  draft: InventoryInboundDraft;
  clientMutationId: string;
  startedAt: number;
}): InventoryInboundSubmission {
  const validationErrors = validateInventoryInboundDraft(draft);
  const firstError = Object.values(validationErrors)[0];
  if (firstError) throw new Error(firstError);

  const mutationId = clientMutationId.trim();
  if (!mutationId) throw new Error('缺少客户端变更编号');

  const quantity = Number(draft.quantity);
  const occurredAt = new Date(draft.occurredAt).toISOString();
  const draftSnapshot: InventoryInboundDraft = {
    ...draft,
    clientMutationId: mutationId,
    selectedItem: draft.selectedItem ? { ...draft.selectedItem } : null,
    newItem: { ...draft.newItem },
  };

  let request: InventoryInboundSubmission['request'];
  let optimisticFields: Pick<
    InventoryMovementItem,
    'sku' | 'name' | 'specification' | 'unit' | 'location'
  >;

  if (draft.mode === 'existing') {
    const selectedItem = draft.selectedItem;
    if (!selectedItem) throw new Error('请选择已有物品');
    request = {
      type: 'inbound',
      clientMutationId: mutationId,
      mode: 'existing',
      catalogRecordId: selectedItem.catalogRecordId.trim(),
      sku: selectedItem.sku.trim(),
      building: draft.building,
      quantity,
      occurredAt,
    };
    optimisticFields = {
      sku: selectedItem.sku.trim(),
      name: selectedItem.name.trim(),
      specification: selectedItem.specification.trim(),
      unit: selectedItem.unit.trim() || '件',
      location: selectedItem.location.trim(),
    };
  } else {
    const newItem: InventoryNewInboundMovementCreateRequest['newItem'] = {
      specialty: draft.newItem.specialty?.trim() || undefined,
      primaryCategory: draft.newItem.primaryCategory.trim(),
      secondaryCategory: draft.newItem.secondaryCategory.trim(),
      name: draft.newItem.name.trim(),
      specification: draft.newItem.specification.trim(),
      location: draft.newItem.location.trim(),
      locationRecordId: draft.newItem.locationRecordId!.trim(),
    };
    request = {
      type: 'inbound',
      clientMutationId: mutationId,
      mode: 'new',
      building: draft.building,
      quantity,
      occurredAt,
      newItem,
    };
    optimisticFields = {
      sku: '系统生成中',
      name: newItem.name,
      specification: newItem.specification,
      unit: '件',
      location: newItem.location,
    };
  }

  return {
    clientMutationId: mutationId,
    startedAt,
    request,
    optimisticMovement: {
      recordId: `pending:${mutationId}`,
      clientMutationId: mutationId,
      pendingSync: true,
      type: 'inbound',
      ...optimisticFields,
      quantity,
      building: draft.building,
      destinationBuilding: '',
      reason: '',
      operator: '',
      applicant: '',
      status: '同步中',
      occurredAt,
      expectedReturnAt: null,
      overdue: false,
    },
    draft: draftSnapshot,
  };
}

export function filterInventoryOutboundOptions(
  items: InventoryMovementOptionItem[],
  building: WarehouseBuilding,
): InventoryMovementOptionItem[] {
  return items.filter((item) => item.building === building);
}

export function reconcileInventoryMovementSelection(
  selectedItem: InventoryMovementOptionItem | null,
  items: InventoryMovementOptionItem[],
): InventoryMovementOptionItem | null {
  if (!selectedItem) return null;
  return (
    items.find(
      (item) =>
        item.catalogRecordId === selectedItem.catalogRecordId &&
        item.building === selectedItem.building &&
        item.sku.trim().toUpperCase() ===
          selectedItem.sku.trim().toUpperCase(),
    ) || null
  );
}

export function filterInventoryMovementOptionsForPicker(
  items: InventoryMovementOptionItem[],
  type: InventoryMovementType,
  building: WarehouseBuilding,
  query: string,
  limit = INVENTORY_OPTION_PICKER_LIMIT,
): InventoryMovementOptionItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const buildingItems =
    type === 'outbound'
      ? filterInventoryOutboundOptions(items, building)
      : items.filter(
          (item) =>
            item.building === building &&
            (type === 'inbound' || item.availableQuantity > 0),
        );
  return buildingItems
    .filter((item) => {
      if (!normalizedQuery) return true;
      return [
        item.sku,
        item.name,
        item.specification,
        item.brand,
        item.primaryCategory,
        item.secondaryCategory,
        item.location,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .slice(0, Math.max(1, limit));
}

function inventoryMovementOptionSnapshotKey(
  type: InventoryMovementType,
  building: WarehouseBuilding,
): string {
  return `${type}:${building}`;
}

export function inventoryOptionErrorAfterLocalSelection(error: string): string {
  return error === INVENTORY_STALE_SNAPSHOT_WARNING ? error : '';
}

export function getInventoryOutboundReasonError(reason: string): string {
  if (reason.length > INVENTORY_OUTBOUND_REASON_MAX_LENGTH) {
    return INVENTORY_OUTBOUND_REASON_MAX_LENGTH_ERROR;
  }
  if (!reason.trim()) return INVENTORY_OUTBOUND_REASON_REQUIRED_ERROR;
  return '';
}

export function validateInventoryOutboundDraft(
  draft: InventoryOutboundDraft,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const quantity = Number(draft.quantity);
  const occurredAt = Date.parse(draft.occurredAt);
  const item = draft.selectedItem;

  if (!draft.building) errors.building = '请选择来源楼栋';
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    errors.quantity = '数量必须为正整数';
  }
  if (!draft.occurredAt || !Number.isFinite(occurredAt)) {
    errors.occurredAt = '请选择有效的办理时间';
  }
  if (!item) {
    errors.item = '请选择物品';
  } else {
    const itemError = getInventoryOutboundSelectedItemError(
      item,
      draft.building,
    );
    if (itemError) errors.item = itemError;
  }
  if (
    item &&
    Number.isSafeInteger(quantity) &&
    quantity > item.availableQuantity
  ) {
    errors.quantity = `不能超过可用库存 ${item.availableQuantity}`;
  }
  if (!draft.applicant?.openId.trim()) {
    errors.applicant = '请选择物品申请人';
  }
  const reasonError = getInventoryOutboundReasonError(draft.reason);
  if (reasonError) errors.reason = reasonError;

  return errors;
}

export function getInventoryOutboundSelectedItemError(
  item: InventoryMovementOptionItem,
  building: WarehouseBuilding,
): string {
  if (item.building !== building) return '请选择来源楼栋库存内的物品';
  if (item.stockConsistencyError) return item.stockConsistencyError;
  if (item.availableQuantity <= 0) return '所选物品当前无可用库存';
  if (!item.catalogRecordId.trim() || !item.sku.trim()) {
    return '所选物品数据不完整，请重新选择';
  }
  if (!item.location.trim()) {
    return '当前楼栋库存台账缺少存放位置，请先配置库位';
  }
  return '';
}

export function buildInventoryOutboundSubmission({
  draft,
  clientMutationId,
  startedAt,
}: {
  draft: InventoryOutboundDraft;
  clientMutationId: string;
  startedAt: number;
}): InventoryOutboundSubmission {
  const validationErrors = validateInventoryOutboundDraft(draft);
  const firstError = Object.values(validationErrors)[0];
  if (firstError) throw new Error(firstError);

  const mutationId = clientMutationId.trim();
  if (!mutationId) throw new Error('缺少客户端变更编号');
  const selectedItem = draft.selectedItem;
  const applicant = draft.applicant;
  if (!selectedItem) throw new Error('请选择物品');
  if (!applicant?.openId.trim()) throw new Error('请选择物品申请人');

  const quantity = Number(draft.quantity);
  const occurredAt = new Date(draft.occurredAt).toISOString();
  const reason = draft.reason.trim();
  const draftSnapshot: InventoryOutboundDraft = {
    ...draft,
    clientMutationId: mutationId,
    selectedItem: { ...selectedItem },
    applicant: { ...applicant },
  };
  const request: InventoryOutboundMovementCreateRequest = {
    type: 'outbound',
    clientMutationId: mutationId,
    catalogRecordId: selectedItem.catalogRecordId.trim(),
    sku: selectedItem.sku.trim(),
    building: draft.building,
    quantity,
    occurredAt,
    applicantOpenId: applicant.openId.trim(),
    reason,
  };

  return {
    clientMutationId: mutationId,
    startedAt,
    request,
    optimisticMovement: {
      recordId: `pending:${mutationId}`,
      clientMutationId: mutationId,
      pendingSync: true,
      type: 'outbound',
      sku: selectedItem.sku.trim(),
      name: selectedItem.name.trim(),
      specification: selectedItem.specification.trim(),
      quantity,
      unit: selectedItem.unit.trim() || '件',
      building: draft.building,
      destinationBuilding: '',
      location: selectedItem.location.trim(),
      reason,
      operator: '',
      applicant: applicant.name.trim(),
      status: '待审批',
      occurredAt,
      expectedReturnAt: null,
      overdue: false,
    },
    draft: draftSnapshot,
  };
}

export function InventoryMovementCreateDialog({
  type,
  open,
  onOpenChange,
  initialBuilding,
  initialDraft,
  initialOutboundDraft,
  retryLocked = false,
  onAbandonRetry,
  onSubmit,
  onOutboundSubmit,
  onOutboundBatchSubmit,
  outboundBatchBlocked = false,
  onCreated,
}: InventoryMovementCreateDialogProps) {
  const principal = useAccess();
  const canCreate = canUseInventoryAction(principal, 'create');
  const scope = accessBuildings(principal);
  const allowedBuildings = WAREHOUSE_BUILDINGS.filter(value => !scope || scope.includes(value));
  const [form, setForm] = useState<FormState>(() =>
    createInitialForm(allowedBuildings.includes(initialBuilding) ? initialBuilding : allowedBuildings[0]),
  );
  const specialtyOptions = isProfessionalBusinessPrincipal(principal) ? PROFESSIONAL_SPECIALTIES.filter(specialty => canPerformBusinessAction(principal, { module: 'inventory', action: 'create', building: form.building, specialty })) : PROFESSIONAL_SPECIALTIES;
  const [inboundMode, setInboundMode] = useState<InventoryInboundItemMode>(
    initialDraft?.mode || 'existing',
  );
  const [newItem, setNewItem] = useState<InventoryNewItemInput>(() => ({
    ...(initialDraft?.newItem || EMPTY_NEW_ITEM),
  }));
  const [retryClientMutationId, setRetryClientMutationId] = useState(
    initialDraft?.clientMutationId || initialOutboundDraft?.clientMutationId,
  );
  const [itemQuery, setItemQuery] = useState('');
  const itemQueryRef = useRef('');
  const [itemPickerOpen, setItemPickerOpen] = useState(false);
  const [optionSnapshot, setOptionSnapshot] = useState<
    InventoryMovementOptionItem[]
  >([]);
  const [items, setItems] = useState<InventoryMovementOptionItem[]>([]);
  const [selectedItem, setSelectedItem] =
    useState<InventoryMovementOptionItem | null>(null);
  const [outboundBatchMode, setOutboundBatchMode] = useState(false);
  const [outboundBatchLines, setOutboundBatchLines] = useState<
    { item: InventoryMovementOptionItem; quantity: string }[]
  >([]);
  const [itemLoading, setItemLoading] = useState(false);
  const [itemError, setItemError] = useState('');
  const [applicant, setApplicant] =
    useState<PurchaseApplicationApplicant | null>(null);
  const [operator, setOperator] = useState<PurchaseApplicationApplicant | null>(
    null,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [creatingStorageLocation, setCreatingStorageLocation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const requestSequence = useRef(0);
  const inboundSubmitGuard = useRef(false);
  const outboundSubmitGuard = useRef(false);
  const meta = TYPE_META[type];
  const reasonMaxLength =
    type === 'outbound' ? INVENTORY_OUTBOUND_REASON_MAX_LENGTH : undefined;

  useEffect(() => {
    if (!open) return;
    requestSequence.current += 1;
    inboundSubmitGuard.current = false;
    outboundSubmitGuard.current = false;
    const restoredDraft = type === 'inbound' ? initialDraft : undefined;
    const restoredOutboundDraft =
      type === 'outbound' ? initialOutboundDraft : undefined;
    const restoredBuilding =
      restoredDraft?.building ||
      restoredOutboundDraft?.building ||
      initialBuilding ||
      'A楼';
    const restoredQuery =
      restoredDraft?.itemQuery || restoredOutboundDraft?.itemQuery || '';
    const cachedSnapshot =
      inventoryMovementOptionSnapshotCache.get(
        inventoryMovementOptionSnapshotKey(type, restoredBuilding),
      ) || [];
    setForm({
      ...createInitialForm(allowedBuildings.includes(initialBuilding) ? initialBuilding : allowedBuildings[0]),
      ...(restoredDraft
        ? {
            building: restoredDraft.building,
            quantity: restoredDraft.quantity,
            occurredAt: restoredDraft.occurredAt,
          }
        : restoredOutboundDraft
          ? {
              building: restoredOutboundDraft.building,
              quantity: restoredOutboundDraft.quantity,
              occurredAt: restoredOutboundDraft.occurredAt,
              reason: restoredOutboundDraft.reason,
            }
          : {}),
    });
    setInboundMode(restoredDraft?.mode || 'existing');
    setNewItem({ ...(restoredDraft?.newItem || EMPTY_NEW_ITEM) });
    if (restoredOutboundDraft) {
      setRetryClientMutationId(restoredOutboundDraft.clientMutationId);
    } else {
      setRetryClientMutationId(restoredDraft?.clientMutationId);
    }
    setItemQuery(restoredQuery);
    itemQueryRef.current = restoredQuery;
    setItemPickerOpen(false);
    setOptionSnapshot(cachedSnapshot);
    setItems(
      filterInventoryMovementOptionsForPicker(
        cachedSnapshot,
        type,
        restoredBuilding,
        restoredQuery,
      ),
    );
    setSelectedItem(
      restoredDraft?.selectedItem
        ? { ...restoredDraft.selectedItem }
        : restoredOutboundDraft?.selectedItem
          ? { ...restoredOutboundDraft.selectedItem }
          : null,
    );
    setOutboundBatchMode(false);
    setOutboundBatchLines([]);
    setItemLoading(false);
    setApplicant(
      restoredOutboundDraft?.applicant
        ? { ...restoredOutboundDraft.applicant }
        : null,
    );
    setOperator(null);
    const restoredReasonError = restoredOutboundDraft
      ? getInventoryOutboundReasonError(restoredOutboundDraft.reason)
      : '';
    setErrors(restoredReasonError ? { reason: restoredReasonError } : {});
    setItemError('');
    setCreatingStorageLocation(false);
  }, [initialBuilding, initialDraft, initialOutboundDraft, open, type]);

  useEffect(() => {
    if (
      !open ||
      !form.building ||
      (type === 'inbound' && inboundMode === 'new')
    ) {
      requestSequence.current += 1;
      setItemLoading(false);
      setItems([]);
      setItemError('');
      return;
    }
    const sequence = beginLatestRequest(requestSequence);
    const cacheKey = inventoryMovementOptionSnapshotKey(type, form.building);
    const cachedSnapshot =
      inventoryMovementOptionSnapshotCache.get(cacheKey) || [];
    let hasUsableSnapshot = cachedSnapshot.length > 0;

    if (hasUsableSnapshot) {
      setOptionSnapshot(cachedSnapshot);
      setItems(
        filterInventoryMovementOptionsForPicker(
          cachedSnapshot,
          type,
          form.building,
          itemQueryRef.current,
        ),
      );
    }
    setItemLoading(!hasUsableSnapshot);
    setItemError('');

    const applySnapshot = (result: InventoryMovementOptionItem[]) => {
      if (!isLatestRequest(requestSequence, sequence)) return;
      const scopedResult =
        type === 'outbound'
          ? filterInventoryOutboundOptions(result, form.building)
          : result.filter((item) => item.building === form.building);
      hasUsableSnapshot = hasUsableSnapshot || scopedResult.length > 0;
      inventoryMovementOptionSnapshotCache.set(cacheKey, scopedResult);
      setOptionSnapshot(scopedResult);
      setSelectedItem((current) =>
        reconcileInventoryMovementSelection(current, scopedResult),
      );
      setItems(
        filterInventoryMovementOptionsForPicker(
          scopedResult,
          type,
          form.building,
          itemQueryRef.current,
        ),
      );
      setItemLoading(false);
      setItemError('');
    };

    const loadSnapshots = async () => {
      try {
        applySnapshot(
          await getInventoryMovementOptions({
            type,
            building: form.building,
            query: '',
            limit: INVENTORY_OPTION_SNAPSHOT_LIMIT,
          }),
        );
        return;
      } catch (error) {
        if (isLatestRequest(requestSequence, sequence)) {
          setItemLoading(false);
          setItemError(
            hasUsableSnapshot
              ? INVENTORY_STALE_SNAPSHOT_WARNING
              : errorMessage(error, '物品数据加载失败，请稍后重试'),
          );
        }
      }
    };

    void loadSnapshots();
    return () => invalidateLatestRequest(requestSequence);
  }, [form.building, inboundMode, open, type]);

  useEffect(() => {
    if (type !== 'outbound' || !selectedItem) return;
    const itemError = getInventoryOutboundSelectedItemError(
      selectedItem,
      form.building,
    );
    setErrors((current) =>
      current.item === itemError ? current : { ...current, item: itemError },
    );
  }, [form.building, selectedItem, type]);

  const quantity = Number(form.quantity);
  const overStock =
    type !== 'inbound' &&
    Boolean(selectedItem) &&
    Number.isFinite(quantity) &&
    quantity > (selectedItem?.availableQuantity || 0);

  const submitLabel = useMemo(() => {
    if (submitting) return '正在提交';
    return type === 'inbound'
      ? '确认入库'
      : type === 'outbound'
        ? '确认出库'
        : '确认借调';
  }, [submitting, type]);

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    if (type === 'inbound') invalidateInboundRetryClientMutationId();
    if (type === 'outbound') invalidateOutboundRetryClientMutationId();
    setForm((current) => ({ ...current, [key]: value }));
    const fieldError =
      key === 'reason' && type === 'outbound'
        ? getInventoryOutboundReasonError(String(value))
        : '';
    setErrors((current) => ({
      ...current,
      [key]: fieldError,
      submit: '',
    }));
  }

  function handleReasonPaste(
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ): void {
    if (type !== 'outbound') return;
    const target = event.currentTarget;
    const pastedText = event.clipboardData.getData('text');
    const nextReason = `${form.reason.slice(0, target.selectionStart)}${pastedText}${form.reason.slice(target.selectionEnd)}`;
    if (nextReason.length <= INVENTORY_OUTBOUND_REASON_MAX_LENGTH) return;

    event.preventDefault();
    updateForm('reason', nextReason);
  }

  function updateNewItem<K extends keyof InventoryNewItemInput>(
    key: K,
    value: InventoryNewItemInput[K],
  ) {
    invalidateInboundRetryClientMutationId();
    setNewItem((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: '', submit: '' }));
  }

  function changeNewItemPrimaryCategory(primaryCategory: string) {
    invalidateInboundRetryClientMutationId();
    const secondaryCategories =
      getInventorySecondaryCategoryOptions(primaryCategory);
    setNewItem((current) => ({
      ...current,
      primaryCategory,
      secondaryCategory: secondaryCategories.some(
        (option) => option === current.secondaryCategory,
      )
        ? current.secondaryCategory
        : '',
    }));
    setErrors((current) => ({
      ...current,
      primaryCategory: '',
      secondaryCategory: '',
      submit: '',
    }));
  }

  function changeStorageLocation(item: WarehouseStorageLocation | null) {
    invalidateInboundRetryClientMutationId();
    setNewItem((current) => ({
      ...current,
      location: item?.name || '',
      locationRecordId: item?.recordId || '',
    }));
    setErrors((current) => ({ ...current, location: '', submit: '' }));
  }

  function invalidateInboundRetryClientMutationId() {
    setRetryClientMutationId(undefined);
  }

  function invalidateOutboundRetryClientMutationId() {
    setRetryClientMutationId(undefined);
  }

  function createInboundDraft(): InventoryInboundDraft {
    return {
      clientMutationId: retryClientMutationId?.trim() || undefined,
      mode: inboundMode,
      building: form.building,
      quantity: form.quantity,
      occurredAt: form.occurredAt,
      itemQuery,
      selectedItem,
      newItem,
    };
  }

  function createOutboundDraft(): InventoryOutboundDraft {
    return {
      clientMutationId: retryClientMutationId?.trim() || undefined,
      building: form.building,
      quantity: form.quantity,
      occurredAt: form.occurredAt,
      itemQuery,
      selectedItem,
      applicant,
      reason: form.reason,
    };
  }

  function changeInboundMode(mode: InventoryInboundItemMode) {
    if (mode === inboundMode) return;
    invalidateInboundRetryClientMutationId();
    requestSequence.current += 1;
    setInboundMode(mode);
    setItemPickerOpen(false);
    setItems([]);
    setOptionSnapshot([]);
    setSelectedItem(null);
    setItemLoading(false);
    setItemError('');
    setErrors((current) => ({
      ...current,
      item: '',
      primaryCategory: '',
      secondaryCategory: '',
      name: '',
      specification: '',
      location: '',
      submit: '',
    }));
  }

  function changeBuilding(value: WarehouseBuilding) {
    if (type === 'inbound') invalidateInboundRetryClientMutationId();
    if (type === 'outbound') invalidateOutboundRetryClientMutationId();
    requestSequence.current += 1;
    setForm((current) => ({ ...current, building: value }));
    setItemQuery('');
    itemQueryRef.current = '';
    setItemPickerOpen(false);
    setSelectedItem(null);
    setOutboundBatchLines([]);
    if (type === 'inbound') {
      setNewItem((current) => ({
        ...current,
        location: '',
        locationRecordId: '',
      }));
    }
    setItems([]);
    setOptionSnapshot([]);
    setItemLoading(false);
    setItemError('');
    setErrors((current) => ({
      ...current,
      building: '',
      item: '',
      location: '',
      submit: '',
    }));
  }

  function changeItemQuery(value: string) {
    if (type === 'inbound') invalidateInboundRetryClientMutationId();
    if (type === 'outbound') invalidateOutboundRetryClientMutationId();
    setItemQuery(value);
    itemQueryRef.current = value;
    setItemPickerOpen(true);
    setSelectedItem(null);
    setItems(
      filterInventoryMovementOptionsForPicker(
        optionSnapshot,
        type,
        form.building,
        value,
      ),
    );
    setItemError(inventoryOptionErrorAfterLocalSelection);
    setErrors((current) => ({ ...current, item: '', submit: '' }));
  }

  function selectItem(item: InventoryMovementOptionItem) {
    if (type === 'inbound') {
      if (item.building !== form.building) {
        setErrors((current) => ({
          ...current,
          item: '请选择当前入库楼栋的物品',
          submit: '',
        }));
        return;
      }
      if (!item.inventoryRecordId.trim() || !item.location.trim()) {
        setErrors((current) => ({
          ...current,
          item: '所选物品未配置库存库位，请先配置库位',
          submit: '',
        }));
        return;
      }
    }
    if (type === 'outbound') {
      if (item.building !== form.building) {
        setErrors((current) => ({
          ...current,
          item: '请选择来源楼栋库存内的物品',
          submit: '',
        }));
        return;
      }
    }
    if (type === 'inbound') invalidateInboundRetryClientMutationId();
    if (type === 'outbound') invalidateOutboundRetryClientMutationId();
    if (type === 'outbound' && outboundBatchMode) {
      const selectedError = getInventoryOutboundSelectedItemError(item, form.building);
      if (selectedError) {
        setErrors((current) => ({ ...current, item: selectedError }));
        return;
      }
      setOutboundBatchLines((current) =>
        current.some((line) => line.item.catalogRecordId === item.catalogRecordId)
          ? current
          : [...current, { item, quantity: '1' }],
      );
      setItemQuery('');
      itemQueryRef.current = '';
      setItemPickerOpen(false);
      setItems(filterInventoryMovementOptionsForPicker(optionSnapshot, type, form.building, ''));
      setErrors((current) => ({ ...current, item: '', submit: '' }));
      return;
    }
    const selectedLabel = `${item.name} · ${item.sku}`;
    setSelectedItem(item);
    setItemQuery(selectedLabel);
    itemQueryRef.current = selectedLabel;
    setItemPickerOpen(false);
    setItems([]);
    setItemLoading(false);
    setItemError(inventoryOptionErrorAfterLocalSelection);
    setErrors((current) => ({
      ...current,
      item:
        type === 'outbound'
          ? getInventoryOutboundSelectedItemError(item, form.building)
          : '',
      quantity: '',
      submit: '',
    }));
  }

  function validateBorrow(): boolean {
    const next: Record<string, string> = {};
    if (!selectedItem) next.item = '请选择物品';
    if (!Number.isInteger(quantity) || quantity <= 0)
      next.quantity = '数量必须为正整数';
    if (overStock)
      next.quantity = `不能超过可用库存 ${selectedItem?.availableQuantity || 0}`;
    if (!form.occurredAt) next.occurredAt = '请选择业务时间';
    if (!applicant) next.applicant = '请选择物品申请人';
    if (!form.reason.trim()) next.reason = '请填写借调原因';
    if (!operator) next.operator = '请选择经办人';
    if (!form.destinationBuilding) {
      next.destinationBuilding = '请选择去向楼栋';
    }
    const expected = Date.parse(form.expectedReturnAt);
    if (!form.expectedReturnAt || !Number.isFinite(expected)) {
      next.expectedReturnAt = '请选择预计归还时间';
    } else if (expected <= Date.now()) {
      next.expectedReturnAt = '预计归还时间必须晚于当前时间';
    } else if (expected <= Date.parse(form.occurredAt)) {
      next.expectedReturnAt = '预计归还时间必须晚于借调时间';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function submitInbound() {
    if (!canCreate) { setErrors({ submit: '当前权限不能新增入库' }); return; }
    if (inboundSubmitGuard.current || creatingStorageLocation) return;

    const draft = createInboundDraft();
    if (!canUseInventoryAction(principal, 'create', { building: draft.building, specialty: draft.mode === 'new' ? draft.newItem.specialty : draft.selectedItem?.specialty })) { setErrors({ submit: '当前权限不能操作所选物品和楼栋' }); return; }
    const nextErrors = validateInventoryInboundDraft(draft);
    if (isProfessionalBusinessPrincipal(principal) && draft.mode === 'new' && !draft.newItem.specialty) nextErrors.submit = '请选择物品专业';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (!onSubmit) {
      setErrors({
        ...nextErrors,
        submit: '入库提交处理器未配置，请联系管理员',
      });
      return;
    }

    inboundSubmitGuard.current = true;
    try {
      const clientMutationId =
        retryClientMutationId?.trim() || createClientMutationId();
      setRetryClientMutationId(clientMutationId);
      const submission = buildInventoryInboundSubmission({
        draft,
        clientMutationId,
        startedAt: Date.now(),
      });
      const accepted = onSubmit(submission);
      if (accepted === false) {
        inboundSubmitGuard.current = false;
        return;
      }
    } catch (error) {
      inboundSubmitGuard.current = false;
      setErrors({
        submit: errorMessage(error, '入库提交失败，请重试'),
      });
      return;
    }
    onOpenChange(false);
  }

  async function submitOutbound() {
    if (!canCreate) { setErrors({ submit: '当前权限不能新增出库' }); return; }
    if (outboundSubmitGuard.current) return;

    if (outboundBatchMode) {
      const lines = outboundBatchLines;
      if (lines.length < 2) {
        setErrors({ submit: '请至少选择两种物品进行批量出库' });
        return;
      }
      if (!onOutboundBatchSubmit) {
        setErrors({ submit: '批量出库处理器未配置' });
        return;
      }
      try {
        const submissions = lines.map((line) =>
          buildInventoryOutboundSubmission({
            draft: {
              ...createOutboundDraft(),
              selectedItem: line.item,
              quantity: line.quantity,
            },
            clientMutationId: createClientMutationId(),
            startedAt: Date.now(),
          }),
        );
        if (!onOutboundBatchSubmit(submissions)) {
          setErrors({ submit: '批量任务未发送，请先处理页面提示的上一批任务' });
          return;
        }
        outboundSubmitGuard.current = true;
        onOpenChange(false);
      } catch (error) {
        setErrors({ submit: errorMessage(error, '批量出库数据有误，请检查各项数量') });
      }
      return;
    }

    const draft = createOutboundDraft();
    const nextErrors = validateInventoryOutboundDraft(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (!onOutboundSubmit) {
      setErrors({
        ...nextErrors,
        submit: '出库提交处理器未配置，请联系管理员',
      });
      return;
    }

    try {
      const clientMutationId =
        retryClientMutationId?.trim() || createClientMutationId();
      setRetryClientMutationId(clientMutationId);
      const accepted = await handoffSubmissionOnce(
        outboundSubmitGuard,
        () =>
          buildInventoryOutboundSubmission({
            draft,
            clientMutationId,
            startedAt: Date.now(),
          }),
        onOutboundSubmit,
      );
      if (!accepted) {
        setErrors({
          ...nextErrors,
          submit: '出库任务未发送，请根据页面提示处理后重试。',
        });
        return;
      }
    } catch (error) {
      outboundSubmitGuard.current = false;
      setErrors({
        submit: errorMessage(error, '出库提交失败，请重试'),
      });
      return;
    }
    onOpenChange(false);
  }

  async function submitBorrow() {
    if (!canCreate || !canUseInventoryAction(principal, 'create', { building: form.building, specialty: selectedItem?.specialty })) { setErrors({ submit: '当前权限不能借调所选物品' }); return; }
    if (
      type !== 'borrow' ||
      !validateBorrow() ||
      !selectedItem ||
      !form.destinationBuilding
    ) {
      return;
    }
    const request: InventoryMovementCreateRequest = {
      type: 'borrow',
      catalogRecordId: selectedItem.catalogRecordId,
      sku: selectedItem.sku,
      building: form.building,
      quantity,
      occurredAt: new Date(form.occurredAt).toISOString(),
      applicantOpenId: applicant?.openId,
      reason: form.reason.trim(),
      destinationBuilding: form.destinationBuilding,
      operatorOpenId: operator?.openId,
      expectedReturnAt: new Date(form.expectedReturnAt).toISOString(),
    };
    setSubmitting(true);
    try {
      const result = await createInventoryMovement(request);
      toast.success(result.message);
      onOpenChange(false);
      onCreated();
    } catch (error) {
      toast.error(errorMessage(error, `${meta.title}失败，请检查数据后重试`));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (type === 'borrow' && submitting) return;
        onOpenChange(value);
      }}
    >
      <DialogContent
        style={{
          animationDuration: type === 'outbound' ? '10ms' : undefined,
        }}
        className="max-sm:h-[100dvh] max-sm:max-w-none max-sm:rounded-none max-sm:border-0 sm:max-w-3xl overflow-hidden p-0 gap-0"
      >
        <DialogHeader className="border-b border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 px-5 py-4 pr-12 text-left">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white shadow-sm',
                meta.accent,
              )}
            >
              <meta.icon className="h-5 w-5" />
            </span>
            <div>
              <DialogTitle className="text-base text-slate-900">
                {meta.title}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-5">
                {meta.description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <fieldset
          disabled={type !== 'borrow' && retryLocked}
          className="max-h-[calc(90vh-142px)] min-w-0 flex-1 overflow-y-auto border-0 px-5 py-5 max-sm:max-h-none"
        >
          {type !== 'borrow' && retryLocked && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              {type === 'inbound'
                ? '恢复草稿已锁定，请使用原入库编号重试，避免重复写入库存。'
                : '恢复草稿已锁定，请使用原出库编号重试，避免重复生成申请。'}
            </div>
          )}
          <div className="grid gap-5 sm:grid-cols-2">
            {type === 'outbound' && !initialOutboundDraft && (
              <div className="sm:col-span-2 flex items-center gap-2">
                <Button
                  type="button"
                  variant={outboundBatchMode ? 'default' : 'outline'}
                  aria-pressed={outboundBatchMode}
                  disabled={outboundBatchBlocked}
                  onClick={() => {
                    setOutboundBatchMode((current) => !current);
                    setOutboundBatchLines([]);
                    setSelectedItem(null);
                    setItemQuery('');
                    itemQueryRef.current = '';
                    setErrors({});
                  }}
                >批量出库</Button>
                {outboundBatchBlocked && <span className="text-xs text-amber-700">上一批任务处理中</span>}
                {outboundBatchMode && <span className="text-xs text-slate-500">已选 {outboundBatchLines.length} 种物品</span>}
              </div>
            )}
            {type === 'inbound' && (
              <div
                className="sm:col-span-2 grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1"
                role="radiogroup"
                aria-label="入库物品方式"
              >
                <Button
                  type="button"
                  variant={inboundMode === 'existing' ? 'default' : 'outline'}
                  role="radio"
                  aria-checked={inboundMode === 'existing'}
                  onClick={() => changeInboundMode('existing')}
                  className={cn(
                    'shadow-none',
                    inboundMode === 'existing' &&
                      'bg-blue-600 hover:bg-blue-700',
                  )}
                >
                  已有物品
                </Button>
                <Button
                  type="button"
                  variant={inboundMode === 'new' ? 'default' : 'outline'}
                  role="radio"
                  aria-checked={inboundMode === 'new'}
                  onClick={() => changeInboundMode('new')}
                  className={cn(
                    'shadow-none',
                    inboundMode === 'new' && 'bg-blue-600 hover:bg-blue-700',
                  )}
                >
                  新增物品
                </Button>
              </div>
            )}

            <FieldBlock
              label={type === 'inbound' ? '入库楼栋' : '来源楼栋'}
              required
              error={errors.building}
            >
              <NativeSelect
                value={form.building}
                onChange={(event) =>
                  changeBuilding(event.target.value as WarehouseBuilding)
                }
                aria-label={type === 'inbound' ? '入库楼栋' : '来源楼栋'}
              >
                {allowedBuildings.map((building) => (
                  <NativeSelectOption key={building} value={building}>
                    {building}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <p className="text-[11px] text-slate-400">
                {type === 'inbound'
                  ? '物品将入库到该楼栋'
                  : '库存将从该楼栋扣减'}
              </p>
            </FieldBlock>

            <FieldBlock label="办理时间" required error={errors.occurredAt}>
              <Input
                type="datetime-local"
                value={form.occurredAt}
                onChange={(event) =>
                  updateForm('occurredAt', event.target.value)
                }
              />
            </FieldBlock>

            {type === 'borrow' && (
              <FieldBlock
                label="去向楼栋"
                required
                error={errors.destinationBuilding}
              >
                <NativeSelect
                  value={form.destinationBuilding}
                  onChange={(event) =>
                    updateForm(
                      'destinationBuilding',
                      event.target.value as WarehouseBuilding | '',
                    )
                  }
                  aria-label="去向楼栋"
                >
                  <NativeSelectOption value="">
                    请选择去向楼栋
                  </NativeSelectOption>
                  {allowedBuildings.map((building) => (
                    <NativeSelectOption key={building} value={building}>
                      {building}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FieldBlock>
            )}

            {(type !== 'inbound' || inboundMode === 'existing') && (
              <div className="sm:col-span-2">
                <FieldBlock
                  label={outboundBatchMode ? '添加物品' : '选择物品'}
                  required={!outboundBatchMode || outboundBatchLines.length === 0}
                  error={errors.item || itemError}
                >
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <Input
                      value={itemQuery}
                      onFocus={() => setItemPickerOpen(true)}
                      onChange={(event) => changeItemQuery(event.target.value)}
                      placeholder="输入物品名称、类别号、规格或库位"
                      className="pl-9 pr-9"
                    />
                    {itemLoading && (
                      <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-blue-500" />
                    )}
                    {itemPickerOpen &&
                      (!selectedItem || outboundBatchMode) &&
                      !itemLoading &&
                      (items.length > 0 || itemQuery.trim()) && (
                        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-blue-100 bg-white p-1 shadow-xl">
                          {items.length ? (
                            items.map((item) => (
                              <button
                                key={item.catalogRecordId}
                                type="button"
                                onClick={() => selectItem(item)}
                                className="flex w-full items-start justify-between gap-3 rounded-md px-3 py-2.5 text-left hover:bg-blue-50 focus:bg-blue-50 focus:outline-none"
                              >
                                <span className="min-w-0">
                                  <strong className="block truncate text-sm text-slate-800">
                                    {item.name}
                                  </strong>
                                  <small className="mt-0.5 block truncate text-slate-400">
                                    {item.sku} ·{' '}
                                    {item.specification || '规格未填写'} ·{' '}
                                    {item.location || '库位未配置'}
                                  </small>
                                </span>
                                {type !== 'inbound' && (
                                  <Badge
                                    className={cn(
                                      'shrink-0',
                                      item.availableQuantity <= 0
                                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                                        : 'border-blue-100 bg-blue-50 text-blue-700',
                                    )}
                                  >
                                    {item.stockConsistencyError
                                        ? '台账冲突'
                                        : `${item.availableQuantity} ${item.unit}`}
                                  </Badge>
                                )}
                              </button>
                            ))
                          ) : (
                            <p className="px-3 py-4 text-center text-xs text-slate-400">
                              当前楼栋没有匹配物品
                            </p>
                          )}
                        </div>
                      )}
                  </div>
                </FieldBlock>
              </div>
            )}

            {type === 'outbound' && outboundBatchMode && outboundBatchLines.length > 0 && (
              <div className="sm:col-span-2 space-y-2" aria-label="批量出库物品清单">
                {outboundBatchLines.map((line) => (
                  <div key={line.item.catalogRecordId} className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/40 p-2">
                    <span className="min-w-0 flex-1 text-sm text-slate-700">{line.item.name} · {line.item.sku} · 可用 {line.item.availableQuantity} {line.item.unit}</span>
                    <Input
                      type="number" min="1" step="1" inputMode="numeric"
                      aria-label={`${line.item.name}出库数量`}
                      className="w-24"
                      value={line.quantity}
                      onChange={(event) => {
                        const value = event.target.value;
                        setOutboundBatchLines((current) => current.map((candidate) => candidate.item.catalogRecordId === line.item.catalogRecordId ? { ...candidate, quantity: value } : candidate));
                        setErrors((current) => ({ ...current, submit: '' }));
                      }}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => setOutboundBatchLines((current) => current.filter((candidate) => candidate.item.catalogRecordId !== line.item.catalogRecordId))}>移除</Button>
                  </div>
                ))}
              </div>
            )}

            {type === 'inbound' && inboundMode === 'new' && (
              <>
                <FieldBlock label="专业" required={isProfessionalBusinessPrincipal(principal)}>
                  <NativeSelect value={newItem.specialty || ''} onChange={event => setNewItem(current => ({ ...current, specialty: event.target.value }))}>
                    <NativeSelectOption value="">请选择专业</NativeSelectOption>
                    {specialtyOptions.map(specialty => <NativeSelectOption key={specialty} value={specialty}>{specialty}</NativeSelectOption>)}
                  </NativeSelect>
                </FieldBlock>
                <FieldBlock
                  label="一级分类"
                  required
                  error={errors.primaryCategory}
                >
                  <NativeSelect
                    value={newItem.primaryCategory}
                    onChange={(event) =>
                      changeNewItemPrimaryCategory(event.target.value)
                    }
                  >
                    <NativeSelectOption value="">
                      请选择一级分类
                    </NativeSelectOption>
                    {INVENTORY_NEW_ITEM_CATEGORY_OPTIONS.map((option) => (
                      <NativeSelectOption
                        key={option.primaryCategory}
                        value={option.primaryCategory}
                      >
                        {option.primaryCategory}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </FieldBlock>
                <FieldBlock
                  label="二级分类"
                  required
                  error={errors.secondaryCategory}
                >
                  <NativeSelect
                    value={newItem.secondaryCategory}
                    onChange={(event) =>
                      updateNewItem('secondaryCategory', event.target.value)
                    }
                    disabled={!newItem.primaryCategory}
                  >
                    <NativeSelectOption value="">
                      请选择二级分类
                    </NativeSelectOption>
                    {getInventorySecondaryCategoryOptions(
                      newItem.primaryCategory,
                    ).map((secondaryCategory) => (
                      <NativeSelectOption
                        key={secondaryCategory}
                        value={secondaryCategory}
                      >
                        {secondaryCategory}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </FieldBlock>
                <FieldBlock label="物品名称" required error={errors.name}>
                  <Input
                    value={newItem.name}
                    onChange={(event) =>
                      updateNewItem('name', event.target.value)
                    }
                    placeholder="请输入物品名称"
                  />
                </FieldBlock>
                <FieldBlock
                  label="规格型号"
                  required
                  error={errors.specification}
                >
                  <Input
                    value={newItem.specification}
                    onChange={(event) =>
                      updateNewItem('specification', event.target.value)
                    }
                    placeholder="请输入规格型号"
                  />
                </FieldBlock>
                <WarehouseStorageLocationField
                  building={form.building}
                  value={newItem.location}
                  recordId={newItem.locationRecordId}
                  disabled={retryLocked}
                  error={errors.location}
                  onChange={changeStorageLocation}
                  onCreatingChange={setCreatingStorageLocation}
                />
                <FieldBlock label="物品类别号">
                  <div
                    className="flex h-9 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500"
                    aria-label="物品类别号"
                  >
                    系统自动生成
                  </div>
                </FieldBlock>
              </>
            )}

            {(type !== 'inbound' || inboundMode === 'existing') &&
              !outboundBatchMode &&
              selectedItem && (
                <div className="sm:col-span-2 rounded-xl border border-blue-100 bg-blue-50/45 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <PackageSearch className="h-4 w-4 text-blue-600" />
                        <strong className="truncate text-sm text-slate-900">
                          {selectedItem.name}
                        </strong>
                        <Badge className="border-blue-100 bg-white text-blue-700">
                          {selectedItem.sku}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-slate-500">
                        {selectedItem.specification || '规格未填写'} ·{' '}
                        {selectedItem.brand || '品牌未填写'} ·{' '}
                        {selectedItem.primaryCategory || '分类未填写'}
                      </p>
                      <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                        <MapPin className="h-3.5 w-3.5" />
                        {selectedItem.building} ·{' '}
                        {selectedItem.location || '库位未配置'}
                      </p>
                    </div>
                    <div className="rounded-lg border border-blue-100 bg-white px-4 py-2 text-right">
                      <small className="block text-[11px] text-slate-400">
                        {type === 'inbound' ? '当前库存' : '可用库存'}
                      </small>
                      <strong className="text-lg tabular-nums text-blue-700">
                        {selectedItem.availableQuantity} {selectedItem.unit}
                      </strong>
                      {type === 'outbound' &&
                        (selectedItem.stockConsistencyError ||
                          selectedItem.availableQuantity <= 0) && (
                          <small className="mt-1 block text-[11px] text-amber-700">
                            {selectedItem.stockConsistencyError ||
                              '库存为 0，暂不可出库'}
                          </small>
                        )}
                    </div>
                  </div>
                </div>
              )}

            {!(type === 'outbound' && outboundBatchMode) && <FieldBlock label="办理数量" required error={errors.quantity}>
              <div className="relative">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={form.quantity}
                  onChange={(event) =>
                    updateForm('quantity', event.target.value)
                  }
                  className={cn(
                    'pr-14',
                    (errors.quantity || overStock) && 'border-rose-300',
                  )}
                />
                <span className="absolute right-3 top-2.5 text-xs text-slate-400">
                  {type === 'inbound' && inboundMode === 'new'
                    ? '件'
                    : selectedItem?.unit || '件'}
                </span>
              </div>
            </FieldBlock>}

            {type !== 'inbound' && (
              <EmployeePicker
                key={`applicant-${type}-${open}-${principal.principalFingerprint || ''}`}
                label="物品申请人"
                defaultToSelf={type === 'outbound' && !initialOutboundDraft && hasAuthenticatedAccessIdentity(principal) && isPersonalAccessAccount(principal)}
                required
                value={applicant}
                onChange={(value) => {
                  if (type === 'outbound') {
                    invalidateOutboundRetryClientMutationId();
                  }
                  setApplicant(value);
                  setErrors((current) => ({ ...current, applicant: '' }));
                }}
                error={errors.applicant}
              />
            )}

            {type === 'borrow' && (
              <EmployeePicker
                key={`operator-${type}-${open}`}
                label="经办人"
                required
                value={operator}
                onChange={(value) => {
                  setOperator(value);
                  setErrors((current) => ({ ...current, operator: '' }));
                }}
                error={errors.operator}
              />
            )}

            {type === 'borrow' && (
              <FieldBlock
                label="预计归还时间"
                required
                error={errors.expectedReturnAt}
              >
                <Input
                  type="datetime-local"
                  value={form.expectedReturnAt}
                  onChange={(event) =>
                    updateForm('expectedReturnAt', event.target.value)
                  }
                />
              </FieldBlock>
            )}

            {type !== 'inbound' && (
              <div className="sm:col-span-2">
                <FieldBlock
                  label={
                    type === 'outbound' ? '出库原因 / 使用地点' : '借调原因'
                  }
                  required
                  error={errors.reason}
                >
                  <Textarea
                    value={form.reason}
                    maxLength={reasonMaxLength}
                    onPaste={handleReasonPaste}
                    onChange={(event) =>
                      updateForm('reason', event.target.value)
                    }
                    placeholder={
                      type === 'outbound'
                        ? '说明领用原因、设备或实际使用地点'
                        : '说明借调用途和使用位置'
                    }
                    className="min-h-24 resize-y"
                  />
                </FieldBlock>
              </div>
            )}

            <div className="sm:col-span-2 flex items-start gap-3 rounded-xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-xs leading-5 text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {type === 'inbound'
                  ? '提交后立即显示同步中，后台确认后完成；失败恢复草稿。'
                  : type === 'outbound'
                    ? '提交后立即显示待审批并后台同步；结果不确定时保留原编号安全重试。'
                    : '提交时系统会重新读取库存并校验数量，成功后写入原多维表并刷新当前列表。'}
              </span>
            </div>
            {type !== 'borrow' && errors.submit && (
              <p className="sm:col-span-2 text-sm text-rose-600" role="alert">
                {errors.submit}
              </p>
            )}
          </div>
        </fieldset>

        <DialogFooter className="border-t border-slate-100 bg-white px-5 py-4 max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {type !== 'borrow' && retryLocked && onAbandonRetry && (
            <Button
              type="button"
              variant="outline"
              onClick={onAbandonRetry}
              className="border-amber-300 text-amber-800 hover:bg-amber-50"
            >
              放弃原编号并编辑
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={type === 'borrow' && submitting}
          >
            取消
          </Button>
          <Button
            onClick={() => {
              if (type === 'inbound') {
                submitInbound();
                return;
              }
              if (type === 'outbound') {
                void submitOutbound();
                return;
              }
              void submitBorrow();
            }}
            disabled={
              !canCreate || (type === 'borrow'
                ? submitting || itemLoading
                : itemLoading || (type === 'inbound' && creatingStorageLocation))
            }
            className="min-w-28 bg-blue-600 hover:bg-blue-700"
          >
            {type === 'borrow' && submitting && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            {outboundBatchMode ? `确认批量出库（${outboundBatchLines.length}）` : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmployeePicker({
  label,
  required,
  value,
  onChange,
  error,
  defaultToSelf = false,
}: {
  label: string;
  required?: boolean;
  value: PurchaseApplicationApplicant | null;
  onChange: (value: PurchaseApplicationApplicant | null) => void;
  error?: string;
  defaultToSelf?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PurchaseApplicationApplicant[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const invalidateEmployeeSearch = useCallback(() => {
    sequence.current += 1;
    setResults([]);
    setLoading(false);
  }, []);

  useEffect(() => {
    invalidateEmployeeSearch();
    if (value) setQuery(value.name);
  }, [invalidateEmployeeSearch, value]);

  useEffect(() => {
    if (value || !query.trim()) {
      invalidateEmployeeSearch();
      return;
    }
    const current = sequence.current + 1;
    sequence.current = current;
    setSearchError('');
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchInventoryApplicants({
          query: query.trim(),
          limit: 20,
        });
        if (sequence.current === current) setResults(found);
      } catch (error) {
        if (sequence.current === current) {
          setSearchError(errorMessage(error, `${label}搜索失败，请重试`));
        }
      } finally {
        if (sequence.current === current) setLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (sequence.current === current) {
        invalidateEmployeeSearch();
      }
    };
  }, [invalidateEmployeeSearch, label, query, retry, value]);

  // Initialize only once; typing or selecting takes ownership of the applicant.
  useEffect(() => {
    if (!defaultToSelf || value || query.trim()) return;
    const current = ++sequence.current;
    setSearchError('');
    setLoading(true);
    void searchInventoryApplicants({ self: true, limit: 1 })
      .then((found) => {
        if (sequence.current !== current) return;
        const person = found.length === 1 ? found[0] : null;
        if (!person?.recordId?.trim() || !person.openId?.trim()) {
          throw new Error('未匹配到当前申请人，请输入姓名选择');
        }
        onChange(person);
        setQuery(person.name);
      })
      .catch((error) => {
        if (sequence.current === current) {
          setSearchError(errorMessage(error, '当前申请人加载失败，请搜索选择或重试'));
        }
      })
      .finally(() => {
        if (sequence.current === current) setLoading(false);
      });
    return () => {
      if (sequence.current === current) invalidateEmployeeSearch();
    };
  }, [defaultToSelf, retry]);

  return (
    <FieldBlock label={label} required={required} error={error}>
      <div className="relative">
        <UserRound className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <Input
          aria-label={label}
          value={query}
          onChange={(event) => {
            invalidateEmployeeSearch();
            setQuery(event.target.value);
            onChange(null);
            setSearchError('');
            setLoading(Boolean(event.target.value.trim()));
          }}
          placeholder={`输入姓名或工号搜索${label}`}
          className="pl-9 pr-9"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-blue-500" />
        )}
        {!value && (query.trim() || loading || searchError) && (
          <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-blue-100 bg-white p-1 shadow-xl">
            {loading ? (
              <p role="status" className="px-3 py-4 text-center text-xs text-slate-400">
                正在搜索…
              </p>
            ) : searchError ? (
              <div role="alert" className="space-y-2 px-3 py-3 text-sm text-rose-600">
                <p className="break-words">{searchError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() => {
                    invalidateEmployeeSearch();
                    setSearchError('');
                    setLoading(true);
                    setRetry((current) => current + 1);
                  }}
                >
                  重新搜索
                </Button>
              </div>
            ) : results.length ? (
              results.map((person) => (
                <button
                  key={person.openId}
                  type="button"
                  onClick={() => {
                    invalidateEmployeeSearch();
                    onChange(person);
                    setQuery(person.name);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-blue-50 focus:bg-blue-50 focus:outline-none"
                >
                  <span>
                    <strong className="block text-sm text-slate-800">
                      {person.name}
                    </strong>
                    <small className="text-slate-400">
                      {person.employeeNo || '工号未填写'} ·{' '}
                      {person.position || person.specialty || '岗位未填写'}
                    </small>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {person.building}
                  </span>
                </button>
              ))
            ) : (
              <p className="px-3 py-4 text-center text-xs text-slate-400">
                没有匹配的在职人员
              </p>
            )}
          </div>
        )}
      </div>
    </FieldBlock>
  );
}

function FieldBlock({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold text-slate-700">
        {label}
        {required && <span className="ml-1 text-rose-500">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

function createInitialForm(initialBuilding?: WarehouseBuilding): FormState {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return {
    building: initialBuilding || 'A楼',
    destinationBuilding: '',
    quantity: '1',
    occurredAt: toLocalInput(now),
    reason: '',
    expectedReturnAt: toLocalInput(tomorrow),
  };
}

function toLocalInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function createClientMutationId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('当前浏览器不支持安全的请求编号生成，请升级后重试');
  }
  return globalThis.crypto.randomUUID();
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: { data?: { message?: unknown } } })
      .response;
    const message = response?.data?.message;
    if (Array.isArray(message)) return message.join('；');
    if (typeof message === 'string' && message.trim()) return message;
    const ownMessage = (error as { message?: unknown }).message;
    if (typeof ownMessage === 'string' && ownMessage.trim()) return ownMessage;
  }
  return fallback;
}
