import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, PackagePlus, Search } from 'lucide-react';

import {
  getPurchaseInboundCategoryTaskStatus,
  getInventoryMovementOptions,
  preparePurchaseInboundCategory,
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
import { WarehouseStorageLocationField } from './WarehouseStorageLocationField';
import type {
  InventoryMovementItem,
  InventoryMovementOptionItem,
  PurchaseExistingInboundConfirmRequest,
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundItemMode,
  PurchaseInboundPreparedCategory,
  PurchaseNewInboundConfirmRequest,
  PurchasePendingInboundItem,
  WarehouseBuilding,
  WarehouseStorageLocation,
} from '@shared/inventory-management.interface';
import {
  INVENTORY_NEW_ITEM_CATEGORY_OPTIONS,
  WAREHOUSE_BUILDINGS,
  getInventorySecondaryCategoryOptions,
} from '@shared/inventory-management.interface';
import { classifyInventoryInboundFailure } from './inventory-inbound-recovery';
import {
  createPurchaseInboundCategoryTaskCoordinator,
  type PurchaseInboundCategoryTaskCoordinator,
  type PurchaseInboundCategoryTaskCoordinatorPhase,
} from './purchase-inbound-category-task-coordinator';

export interface PurchaseInboundNewItemDraft {
  specialty?: string;
  primaryCategory: string;
  secondaryCategory: string;
  name: string;
  specification: string;
  location: string;
  locationRecordId?: string;
  brand: string;
  unit: string;
  minimumQuantity: string;
}

export interface PurchaseInboundDraft {
  responsibilityGeneration?: number;
  kind: 'purchase';
  executionRecordId: string;
  clientMutationId?: string;
  mode: PurchaseInboundItemMode | '';
  building: WarehouseBuilding;
  quantity: string;
  occurredAt: string;
  itemQuery: string;
  selectedItem: InventoryMovementOptionItem | null;
  preparedCatalogRecordId?: string;
  generatedSku?: string;
  preparedAt?: string;
  newItem: PurchaseInboundNewItemDraft;
}

export interface PurchaseInboundSubmission {
  purchaseExecutionRecordId: string;
  clientMutationId: string;
  startedAt: number;
  request:
    | PurchaseExistingInboundConfirmRequest
    | PurchaseNewInboundConfirmRequest;
  optimisticMovement: InventoryMovementItem;
  draft: PurchaseInboundDraft;
}

interface PurchaseInboundConfirmationDialogProps {
  open: boolean;
  item: PurchasePendingInboundItem | null;
  initialDraft?: PurchaseInboundDraft;
  retryLocked?: boolean;
  onAbandonRetry?: () => void;
  onCategoryPrepared?: (
    executionRecordId: string,
    preparedCategory: PurchaseInboundPreparedCategory,
  ) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (submission: PurchaseInboundSubmission) => boolean | void;
  batchPosition?: { current: number; total: number };
}

export function createPurchaseInboundDraft(
  item: PurchasePendingInboundItem,
  now = new Date(),
): PurchaseInboundDraft {
  const prepared = item.preparedCategory;
  if (prepared) {
    return {
      kind: 'purchase',
      executionRecordId: item.executionRecordId,
      ...(item.responsibilityGeneration === undefined ? {} : { responsibilityGeneration: item.responsibilityGeneration }),
      clientMutationId: prepared.clientMutationId,
      mode: 'new',
      building: prepared.building,
      quantity: String(prepared.quantity),
      occurredAt: toLocalDateTime(new Date(prepared.occurredAt)),
      itemQuery: '',
      selectedItem: null,
      preparedCatalogRecordId: prepared.catalogRecordId,
      generatedSku: prepared.sku,
      preparedAt: prepared.preparedAt,
      newItem: {
        specialty: prepared.newItem.specialty,
        primaryCategory: prepared.newItem.primaryCategory,
        secondaryCategory: prepared.newItem.secondaryCategory,
        name: prepared.newItem.name,
        specification: prepared.newItem.specification,
        location: prepared.newItem.location,
        ...(prepared.newItem.locationRecordId?.trim()
          ? { locationRecordId: prepared.newItem.locationRecordId.trim() }
          : {}),
        brand: prepared.newItem.brand || '',
        unit: prepared.newItem.unit || '',
        minimumQuantity: String(prepared.newItem.minimumQuantity ?? 0),
      },
    };
  }
  return {
    kind: 'purchase',
    executionRecordId: item.executionRecordId,
    ...(item.responsibilityGeneration === undefined ? {} : { responsibilityGeneration: item.responsibilityGeneration }),
    clientMutationId: undefined,
    mode: '',
    building: item.building,
    quantity: String(item.quantity),
    occurredAt: toLocalDateTime(now),
    itemQuery: '',
    selectedItem: null,
    preparedCatalogRecordId: '',
    generatedSku: '',
    preparedAt: '',
    newItem: {
      specialty: item.specialty,
      primaryCategory: item.primaryCategory,
      secondaryCategory: item.secondaryCategory,
      name: item.itemName,
      specification: item.specification,
      location: '',
      locationRecordId: '',
      brand: item.brand,
      unit: item.unit,
      minimumQuantity: '0',
    },
  };
}

export function restorePurchaseInboundDraftFromCategoryTask(
  draft: PurchaseInboundDraft,
  request: PurchaseInboundCategoryPrepareRequest,
): PurchaseInboundDraft {
  if (draft.executionRecordId !== request.executionRecordId) return draft;
  return {
    ...draft,
    clientMutationId: request.clientMutationId,
    mode: 'new',
    building: request.building,
    quantity: String(request.quantity),
    occurredAt: toLocalDateTime(new Date(request.occurredAt)),
    itemQuery: '',
    selectedItem: null,
    preparedCatalogRecordId: '',
    generatedSku: '',
    preparedAt: '',
    newItem: {
      specialty: request.newItem.specialty,
      primaryCategory: request.newItem.primaryCategory,
      secondaryCategory: request.newItem.secondaryCategory,
      name: request.newItem.name,
      specification: request.newItem.specification,
      location: request.newItem.location,
      ...(request.newItem.locationRecordId?.trim()
        ? { locationRecordId: request.newItem.locationRecordId.trim() }
        : {}),
      brand: request.newItem.brand || '',
      unit: request.newItem.unit || '',
      minimumQuantity: String(request.newItem.minimumQuantity ?? 0),
    },
  };
}

export function validatePurchaseInboundDraft(
  draft: PurchaseInboundDraft,
): Record<string, string> {
  const errors = validatePurchaseInboundBaseDraft(draft);

  if (!draft.mode) {
    errors.mode = '请选择入库类型';
    return errors;
  }

  if (draft.mode === 'existing') {
    validateExistingPurchaseInboundDraft(draft, errors);
  } else {
    validateNewPurchaseInboundDraft(
      draft,
      errors,
      !hasPreparedPurchaseInboundCategory(draft),
    );
    if (!draft.preparedCatalogRecordId?.trim() || !draft.generatedSku?.trim()) {
      errors.generatedSku = '请先生成新的物品类别号';
    }
  }

  return errors;
}

export function validatePurchaseInboundCategoryDraft(
  draft: PurchaseInboundDraft,
): Record<string, string> {
  const errors = validatePurchaseInboundBaseDraft(draft);
  if (draft.mode !== 'new') {
    errors.mode = '请先选择新增物品';
    return errors;
  }
  validateNewPurchaseInboundDraft(draft, errors, true);
  return errors;
}

function validatePurchaseInboundBaseDraft(
  draft: PurchaseInboundDraft,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const quantity = Number(draft.quantity);

  if (!draft.executionRecordId.trim()) {
    errors.submit = '采购记录信息不完整，请刷新后重试';
  }
  if (!draft.building) errors.building = '请选择入库楼栋';
  if (!Number.isInteger(quantity) || quantity <= 0) {
    errors.quantity = '确认数量必须为正整数';
  }
  if (!draft.occurredAt || !Number.isFinite(Date.parse(draft.occurredAt))) {
    errors.occurredAt = '请选择有效入库时间';
  }

  return errors;
}

function validateExistingPurchaseInboundDraft(
  draft: PurchaseInboundDraft,
  errors: Record<string, string>,
): void {
  const selectedItem = draft.selectedItem;
  if (!selectedItem) {
    errors.catalog = '请选择需要关联的库存物品';
  } else if (selectedItem.building !== draft.building) {
    errors.catalog = '请选择当前入库楼栋的物品';
  } else if (
    !selectedItem.inventoryRecordId.trim() ||
    !selectedItem.location.trim()
  ) {
    errors.catalog = '所选物品未配置库存库位，请先配置库位';
  } else if (!selectedItem.catalogRecordId.trim() || !selectedItem.sku.trim()) {
    errors.catalog = '所选物品数据不完整，请重新选择';
  }
}

function validateNewPurchaseInboundDraft(
  draft: PurchaseInboundDraft,
  errors: Record<string, string>,
  requireLocationRecordId: boolean,
): void {
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
  } else if (
    requireLocationRecordId &&
    !draft.newItem.locationRecordId?.trim()
  ) {
    errors.location = '请从库位底表选择存放位置';
  }

  const minimumQuantityText = draft.newItem.minimumQuantity.trim();
  if (minimumQuantityText) {
    const minimumQuantity = Number(minimumQuantityText);
    if (!Number.isFinite(minimumQuantity) || minimumQuantity < 0) {
      errors.minimumQuantity = '最小库存量不得为负数';
    }
  }
}

function hasPreparedPurchaseInboundCategory(
  draft: PurchaseInboundDraft,
): boolean {
  return Boolean(
    draft.preparedCatalogRecordId?.trim() && draft.generatedSku?.trim(),
  );
}

export function buildPurchaseInboundCategoryPrepareRequest({
  draft,
  clientMutationId,
}: {
  draft: PurchaseInboundDraft;
  clientMutationId: string;
}): PurchaseInboundCategoryPrepareRequest {
  const errors = validatePurchaseInboundCategoryDraft(draft);
  const firstError = Object.values(errors)[0];
  if (firstError) throw new Error(firstError);
  const mutationId = clientMutationId.trim();
  if (!mutationId) throw new Error('缺少客户端变更编号');
  return {
    executionRecordId: draft.executionRecordId.trim(),
    clientMutationId: mutationId,
    building: draft.building,
    quantity: Number(draft.quantity),
    occurredAt: new Date(draft.occurredAt).toISOString(),
    newItem: normalizePurchaseNewItem(draft.newItem),
  };
}

function normalizePurchaseNewItem(draft: PurchaseInboundNewItemDraft) {
  const minimumQuantityText = draft.minimumQuantity.trim();
  return {
    ...(draft.specialty ? { specialty: draft.specialty } : {}),
    primaryCategory: draft.primaryCategory.trim(),
    secondaryCategory: draft.secondaryCategory.trim(),
    name: draft.name.trim(),
    specification: draft.specification.trim(),
    location: draft.location.trim(),
    ...(draft.locationRecordId?.trim()
      ? { locationRecordId: draft.locationRecordId.trim() }
      : {}),
    brand: draft.brand.trim(),
    unit: draft.unit.trim(),
    ...(minimumQuantityText
      ? { minimumQuantity: Number(minimumQuantityText) }
      : {}),
  };
}

export function buildPurchaseInboundSubmission({
  item,
  draft,
  clientMutationId,
  startedAt,
}: {
  item: PurchasePendingInboundItem;
  draft: PurchaseInboundDraft;
  clientMutationId: string;
  startedAt: number;
}): PurchaseInboundSubmission {
  const validationErrors = validatePurchaseInboundDraft(draft);
  const firstError = Object.values(validationErrors)[0];
  if (firstError) throw new Error(firstError);
  if (draft.executionRecordId !== item.executionRecordId) {
    throw new Error('采购记录已变化，请刷新后重试');
  }

  const mutationId = clientMutationId.trim();
  if (!mutationId) throw new Error('缺少客户端变更编号');

  const quantity = Number(draft.quantity);
  if (quantity > item.quantity) {
    throw new Error(`确认入库数量不能超过实际签收数量（${item.quantity}）`);
  }
  const occurredAt = new Date(draft.occurredAt).toISOString();
  const draftSnapshot: PurchaseInboundDraft = {
    ...draft,
    clientMutationId: mutationId,
    selectedItem: draft.selectedItem ? { ...draft.selectedItem } : null,
    newItem: { ...draft.newItem },
  };

  let request: PurchaseInboundSubmission['request'];
  let optimisticFields: Pick<
    InventoryMovementItem,
    'sku' | 'name' | 'specification' | 'unit' | 'location'
  >;

  if (draft.mode === 'existing') {
    const selectedItem = draft.selectedItem;
    if (!selectedItem) throw new Error('请选择需要关联的库存物品');
    request = {
      executionRecordId: item.executionRecordId,
      building: draft.building,
      ...(draft.responsibilityGeneration === undefined ? {} : { responsibilityGeneration: draft.responsibilityGeneration }),
      clientMutationId: mutationId,
      mode: 'existing',
      catalogRecordId: selectedItem.catalogRecordId.trim(),
      sku: selectedItem.sku.trim(),
      quantity,
      occurredAt,
    };
    optimisticFields = {
      sku: selectedItem.sku.trim(),
      name: selectedItem.name.trim(),
      specification: selectedItem.specification.trim(),
      unit: selectedItem.unit.trim() || item.unit.trim() || '件',
      location: selectedItem.location.trim(),
    };
  } else {
    const newItem = normalizePurchaseNewItem(draft.newItem);
    request = {
      executionRecordId: item.executionRecordId,
      building: draft.building,
      ...(draft.responsibilityGeneration === undefined ? {} : { responsibilityGeneration: draft.responsibilityGeneration }),
      clientMutationId: mutationId,
      mode: 'new',
      preparedCatalogRecordId: draft.preparedCatalogRecordId?.trim() || '',
      generatedSku: draft.generatedSku?.trim() || '',
      quantity,
      occurredAt,
      newItem,
    };
    optimisticFields = {
      sku: draft.generatedSku?.trim() || '',
      name: newItem.name,
      specification: newItem.specification,
      unit: newItem.unit || item.unit.trim() || '件',
      location: newItem.location,
    };
  }

  return {
    purchaseExecutionRecordId: item.executionRecordId,
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
      reason: `采购入库 · ${item.requestCode}`,
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

export function PurchaseInboundConfirmationDialog({
  open,
  item,
  initialDraft,
  retryLocked = false,
  onAbandonRetry,
  onCategoryPrepared,
  onOpenChange,
  onSubmit,
  batchPosition,
}: PurchaseInboundConfirmationDialogProps) {
  const [draft, setDraft] = useState<PurchaseInboundDraft | null>(null);
  const [options, setOptions] = useState<InventoryMovementOptionItem[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [categoryTaskPhase, setCategoryTaskPhase] =
    useState<PurchaseInboundCategoryTaskCoordinatorPhase>('idle');
  const [categoryTaskMessage, setCategoryTaskMessage] = useState('');
  const [creatingStorageLocation, setCreatingStorageLocation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const searchSequence = useRef(0);
  const categoryTaskCoordinatorRef =
    useRef<PurchaseInboundCategoryTaskCoordinator | null>(null);
  const categoryPrepareGuard = useRef(false);
  const inboundSubmitGuard = useRef(false);
  const categoryTaskActive =
    categoryTaskPhase === 'submitting' ||
    categoryTaskPhase === 'accepted' ||
    categoryTaskPhase === 'syncing' ||
    categoryTaskPhase === 'uncertain';
  const categoryTaskSpinning =
    categoryTaskPhase === 'submitting' || categoryTaskPhase === 'syncing';

  useEffect(() => {
    if (!open || !item) return;
    searchSequence.current += 1;
    categoryPrepareGuard.current = false;
    inboundSubmitGuard.current = false;
    const restoredDraft =
      initialDraft?.executionRecordId === item.executionRecordId
        ? cloneDraft(initialDraft)
        : createPurchaseInboundDraft(item);
    setDraft(restoredDraft);
    setOptions([]);
    setLoadingOptions(false);
    setSearchError('');
    setErrors({});
    setCategoryTaskPhase('idle');
    setCategoryTaskMessage('');
    setCreatingStorageLocation(false);
    setSubmitting(false);
  }, [initialDraft, item, open]);

  useEffect(() => {
    if (!open || !item) return;
    const coordinator = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory: preparePurchaseInboundCategory,
      getTaskStatus: getPurchaseInboundCategoryTaskStatus,
      onEvent: (event) => {
        const request = event.journal.request;
        if (
          event.type === 'submitting' ||
          event.type === 'accepted' ||
          event.type === 'syncing'
        ) {
          categoryPrepareGuard.current = true;
          setCategoryTaskPhase(event.phase);
          setCategoryTaskMessage(event.message);
          setDraft((current) =>
            current
              ? restorePurchaseInboundDraftFromCategoryTask(current, request)
              : current,
          );
          setErrors((current) => ({
            ...current,
            generatedSku: '',
            submit: '',
          }));
          return;
        }

        categoryPrepareGuard.current = false;
        if (event.type === 'uncertain') {
          setDraft((current) =>
            current
              ? restorePurchaseInboundDraftFromCategoryTask(current, request)
              : current,
          );
          setErrors({ generatedSku: event.message });
          setCategoryTaskPhase('uncertain');
          setCategoryTaskMessage(event.message);
          return;
        }
        if (event.type === 'completed') {
          const preparedCategory: PurchaseInboundPreparedCategory = {
            catalogRecordId: event.result.catalogRecordId,
            sku: event.result.sku,
            preparedAt: event.result.preparedAt,
            clientMutationId: request.clientMutationId,
            building: request.building,
            quantity: request.quantity,
            occurredAt: request.occurredAt,
            newItem: { ...request.newItem },
          };
          setDraft((current) =>
            current?.executionRecordId === request.executionRecordId
              ? {
                  ...current,
                  clientMutationId: request.clientMutationId,
                  preparedCatalogRecordId: event.result.catalogRecordId,
                  generatedSku: event.result.sku,
                  preparedAt: event.result.preparedAt,
                }
              : current,
          );
          setErrors({});
          setCategoryTaskPhase('completed');
          setCategoryTaskMessage(event.message || '物品类别号已生成');
          onCategoryPrepared?.(request.executionRecordId, preparedCategory);
          return;
        }

        if (event.type !== 'failed') return;

        const failure = event.definitelyNotPrepared
          ? Object.assign(new Error(event.message), {
              response: {
                status: 422,
                data: {
                  message: event.message,
                  definitelyNotWritten: true,
                },
              },
            })
          : event.error;
        setDraft((current) =>
          current
            ? recoverPurchaseInboundCategoryDraftAfterFailure(current, failure)
            : current,
        );
        setErrors({
          generatedSku: errorMessage(
            failure,
            '生成物品类别号失败，请保留当前内容后重试',
          ),
        });
        setCategoryTaskPhase('error');
        setCategoryTaskMessage('');
      },
    });
    categoryTaskCoordinatorRef.current = coordinator;

    if (coordinator.resume(item.executionRecordId)) {
      void coordinator.checkNow();
    }
    const checkCategoryTaskNow = () => {
      void coordinator.checkNow();
    };
    const checkVisibleCategoryTask = () => {
      if (document.visibilityState === 'visible') checkCategoryTaskNow();
    };
    window.addEventListener('focus', checkCategoryTaskNow);
    document.addEventListener('visibilitychange', checkVisibleCategoryTask);
    return () => {
      window.removeEventListener('focus', checkCategoryTaskNow);
      document.removeEventListener(
        'visibilitychange',
        checkVisibleCategoryTask,
      );
      coordinator.stop();
      if (categoryTaskCoordinatorRef.current === coordinator) {
        categoryTaskCoordinatorRef.current = null;
      }
    };
  }, [item?.executionRecordId, onCategoryPrepared, open]);

  useEffect(() => {
    if (
      !open ||
      !item ||
      !draft ||
      draft.mode !== 'existing' ||
      draft.selectedItem
    ) {
      searchSequence.current += 1;
      setLoadingOptions(false);
      setOptions([]);
      setSearchError('');
      return;
    }

    const sequence = searchSequence.current + 1;
    searchSequence.current = sequence;
    const timer = window.setTimeout(async () => {
      setLoadingOptions(true);
      setSearchError('');
      try {
        const result = await getInventoryMovementOptions({
          type: 'inbound',
          building: draft.building,
          query: draft.itemQuery.trim(),
          limit: 30,
        });
        if (searchSequence.current === sequence) {
          setOptions(
            result.filter((option) => option.building === draft.building),
          );
        }
      } catch (error) {
        if (searchSequence.current === sequence) {
          setOptions([]);
          setSearchError(errorMessage(error, '库存物品加载失败，请稍后重试'));
        }
      } finally {
        if (searchSequence.current === sequence) setLoadingOptions(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    draft?.building,
    draft?.itemQuery,
    draft?.mode,
    draft?.selectedItem,
    item,
    open,
  ]);

  if (!item || !draft) return null;

  const preparedNew =
    draft.mode === 'new' &&
    Boolean(
      draft.preparedCatalogRecordId?.trim() && draft.generatedSku?.trim(),
    );
  const confirmDisabled =
    categoryTaskActive ||
    creatingStorageLocation ||
    submitting ||
    Object.keys(validatePurchaseInboundDraft(draft)).length > 0;

  function clearRetryMutationId(
    current: PurchaseInboundDraft,
  ): PurchaseInboundDraft {
    return current.clientMutationId === undefined
      ? current
      : { ...current, clientMutationId: undefined };
  }

  function updateDraftField<K extends 'quantity' | 'occurredAt'>(
    key: K,
    value: PurchaseInboundDraft[K],
  ) {
    setDraft((current) =>
      current
        ? clearRetryMutationId({
            ...current,
            [key]: value,
          })
        : current,
    );
    setErrors((current) => ({ ...current, [key]: '', submit: '' }));
  }

  function updateNewItem<K extends keyof PurchaseInboundNewItemDraft>(
    key: K,
    value: PurchaseInboundNewItemDraft[K],
  ) {
    setDraft((current) =>
      current
        ? clearRetryMutationId({
            ...current,
            newItem: { ...current.newItem, [key]: value },
            preparedCatalogRecordId: '',
            generatedSku: '',
            preparedAt: '',
          })
        : current,
    );
    setErrors((current) => ({ ...current, [key]: '', submit: '' }));
  }

  function changeNewItemPrimaryCategory(primaryCategory: string) {
    const secondaryCategories =
      getInventorySecondaryCategoryOptions(primaryCategory);
    setDraft((current) =>
      current
        ? clearRetryMutationId({
            ...current,
            newItem: {
              ...current.newItem,
              primaryCategory,
              secondaryCategory: secondaryCategories.some(
                (option) => option === current.newItem.secondaryCategory,
              )
                ? current.newItem.secondaryCategory
                : '',
            },
            preparedCatalogRecordId: '',
            generatedSku: '',
            preparedAt: '',
          })
        : current,
    );
    setErrors((current) => ({
      ...current,
      primaryCategory: '',
      secondaryCategory: '',
      submit: '',
    }));
  }

  function changeMode(mode: PurchaseInboundItemMode) {
    searchSequence.current += 1;
    setDraft((current) =>
      current
        ? clearRetryMutationId({
            ...current,
            mode,
            itemQuery: '',
            selectedItem: null,
            preparedCatalogRecordId: '',
            generatedSku: '',
            preparedAt: '',
          })
        : current,
    );
    setOptions([]);
    setLoadingOptions(false);
    setSearchError('');
    setErrors({});
  }

  function changeBuilding(building: WarehouseBuilding) {
    searchSequence.current += 1;
    setDraft((current) =>
      current ? changePurchaseInboundDraftBuilding(current, building) : current,
    );
    setOptions([]);
    setLoadingOptions(false);
    setSearchError('');
    setErrors((current) => ({
      ...current,
      building: '',
      catalog: '',
      submit: '',
    }));
  }

  function changeItemQuery(itemQuery: string) {
    searchSequence.current += 1;
    setDraft((current) =>
      current
        ? clearRetryMutationId({
            ...current,
            itemQuery,
            selectedItem: null,
          })
        : current,
    );
    setOptions([]);
    setLoadingOptions(false);
    setSearchError('');
    setErrors((current) => ({ ...current, catalog: '', submit: '' }));
  }

  function changeStorageLocation(item: WarehouseStorageLocation | null) {
    setDraft((current) =>
      current
        ? clearRetryMutationId({
            ...current,
            newItem: {
              ...current.newItem,
              location: item?.name || '',
              locationRecordId: item?.recordId || '',
            },
          })
        : current,
    );
    setErrors((current) => ({ ...current, location: '', submit: '' }));
  }

  function selectItem(selectedItem: InventoryMovementOptionItem) {
    if (selectedItem.building !== draft!.building) {
      setErrors((current) => ({
        ...current,
        catalog: '请选择当前入库楼栋的物品',
        submit: '',
      }));
      return;
    }
    if (
      !selectedItem.inventoryRecordId.trim() ||
      !selectedItem.location.trim()
    ) {
      setErrors((current) => ({
        ...current,
        catalog: '所选物品未配置库存库位，请先配置库位',
        submit: '',
      }));
      return;
    }
    searchSequence.current += 1;
    setDraft((current) =>
      current
        ? clearRetryMutationId({
            ...current,
            itemQuery: `${selectedItem.name} · ${selectedItem.sku}`,
            selectedItem,
          })
        : current,
    );
    setOptions([]);
    setLoadingOptions(false);
    setSearchError('');
    setErrors((current) => ({ ...current, catalog: '', submit: '' }));
  }

  async function prepareCategory() {
    if (
      categoryPrepareGuard.current ||
      creatingStorageLocation ||
      draft!.mode !== 'new'
    ) {
      return;
    }
    const nextErrors = validatePurchaseInboundCategoryDraft(draft!);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    categoryPrepareGuard.current = true;
    const mutationId =
      draft!.clientMutationId?.trim() || createClientMutationId();
    let request: PurchaseInboundCategoryPrepareRequest;
    try {
      request = buildPurchaseInboundCategoryPrepareRequest({
        draft: draft!,
        clientMutationId: mutationId,
      });
    } catch (error) {
      categoryPrepareGuard.current = false;
      setErrors({
        submit: errorMessage(error, '生成物品类别号失败，请重试'),
      });
      return;
    }

    setDraft((current) =>
      current ? { ...current, clientMutationId: mutationId } : current,
    );
    setCategoryTaskPhase('submitting');
    setCategoryTaskMessage('正在受理类别号生成任务…');
    try {
      const coordinator = categoryTaskCoordinatorRef.current;
      if (!coordinator) throw new Error('类别号任务尚未就绪，请重试');
      const started = await coordinator.start(request);
      if (!started && coordinator.getPhase() === 'idle') {
        throw new Error('类别号任务未能启动，请重试');
      }
    } catch (error) {
      categoryPrepareGuard.current = false;
      setDraft((current) =>
        current
          ? recoverPurchaseInboundCategoryDraftAfterFailure(current, error)
          : current,
      );
      setErrors({
        generatedSku: errorMessage(
          error,
          '生成物品类别号失败，请保留当前内容后重试',
        ),
      });
      setCategoryTaskPhase('error');
      setCategoryTaskMessage('');
    }
  }

  function submit() {
    if (inboundSubmitGuard.current) return;

    const nextErrors = validatePurchaseInboundDraft(draft!);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    inboundSubmitGuard.current = true;
    setSubmitting(true);
    try {
      const mutationId =
        draft!.clientMutationId?.trim() || createClientMutationId();
      const submission = buildPurchaseInboundSubmission({
        item: item!,
        draft: draft!,
        clientMutationId: mutationId,
        startedAt: Date.now(),
      });
      const accepted = onSubmit(submission);
      if (accepted === false) {
        inboundSubmitGuard.current = false;
        setSubmitting(false);
        return;
      }
    } catch (error) {
      inboundSubmitGuard.current = false;
      setSubmitting(false);
      setErrors({
        submit: errorMessage(error, '采购入库提交失败，请重试'),
      });
      return;
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-blue-100 bg-slate-50 sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500 text-white">
              <PackagePlus className="h-5 w-5" />
            </span>
            <div>
              <DialogTitle>{batchPosition ? `批量入库 · 第 ${batchPosition.current}/${batchPosition.total} 项` : '确认采购入库'}</DialogTitle>
              <DialogDescription className="mt-1">
                {item.requestCode} · {item.itemName} · 申请楼栋 {item.building}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <fieldset
          disabled={retryLocked || categoryTaskActive || preparedNew}
          className="min-w-0 space-y-5 border-0 p-0 py-2"
        >
          {retryLocked && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
              恢复草稿已锁定，请使用原入库编号重试，避免重复写入库存。
            </div>
          )}
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-800">
            确认后才会增加库存；数据先在页面标记为同步中，后端完成物品类别、楼栋库存和入库记录后才确认成功。
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="入库楼栋" required error={errors.building}>
              <NativeSelect
                className="w-full"
                aria-label="入库楼栋"
                value={draft.building}
                onChange={(event) =>
                  changeBuilding(event.target.value as WarehouseBuilding)
                }
              >
                {WAREHOUSE_BUILDINGS.map((building) => (
                  <NativeSelectOption key={building} value={building}>
                    {building}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <p className="mt-1 text-[11px] text-slate-400">
                物品将入库到该楼栋对应库房
              </p>
            </Field>
            <Field label="入库时间" required error={errors.occurredAt}>
              <Input
                type="datetime-local"
                value={draft.occurredAt}
                onChange={(event) =>
                  updateDraftField('occurredAt', event.target.value)
                }
              />
            </Field>
            <Field label="确认入库数量" required error={errors.quantity}>
              <Input
                type="number"
                min={1}
                max={item.quantity}
                step={1}
                value={draft.quantity}
                onChange={(event) =>
                  updateDraftField('quantity', event.target.value)
                }
              />
              <p className="mt-1 text-[11px] text-slate-400">
                本次最多可入库 {item.quantity} {item.unit || '件'}
              </p>
            </Field>
            <Field label="入库类型" required error={errors.mode}>
              <div
                role="radiogroup"
                aria-label="入库类型"
                className="grid grid-cols-2 gap-2"
              >
                <Button
                  type="button"
                  variant={draft.mode === 'new' ? 'default' : 'outline'}
                  role="radio"
                  aria-checked={draft.mode === 'new'}
                  onClick={() => changeMode('new')}
                >
                  新增物品
                </Button>
                <Button
                  type="button"
                  variant={draft.mode === 'existing' ? 'default' : 'outline'}
                  role="radio"
                  aria-checked={draft.mode === 'existing'}
                  onClick={() => changeMode('existing')}
                >
                  已有物品
                </Button>
              </div>
            </Field>
          </div>

          {draft.mode === 'existing' ? (
            <section className="space-y-3 rounded-xl border border-blue-100 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  关联现有类别
                </h3>
                <Badge className="border-blue-200 bg-blue-50 text-blue-700">
                  {draft.building}
                </Badge>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={draft.itemQuery}
                  className="pl-9 pr-9"
                  placeholder="搜索类别号、名称、规格或库位"
                  onChange={(event) => changeItemQuery(event.target.value)}
                />
                {loadingOptions && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-blue-500" />
                )}
              </div>
              {!draft.selectedItem && (
                <div className="max-h-52 space-y-2 overflow-y-auto">
                  {options.map((option) => (
                    <button
                      key={option.catalogRecordId}
                      type="button"
                      onClick={() => selectItem(option)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm transition hover:border-blue-200 hover:bg-blue-50/50"
                    >
                      <strong className="block text-slate-900">
                        {option.name} · {option.sku}
                      </strong>
                      <span className="mt-1 block text-xs text-slate-500">
                        {option.specification || '规格未填写'} ·{' '}
                        {option.location || '库位未配置'}
                      </span>
                    </button>
                  ))}
                  {!loadingOptions && !searchError && options.length === 0 && (
                    <p className="py-3 text-center text-xs text-slate-400">
                      当前楼栋没有匹配物品
                    </p>
                  )}
                </div>
              )}
              {draft.selectedItem && (
                <div className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                  <strong>
                    {draft.selectedItem.name} · {draft.selectedItem.sku}
                  </strong>
                  <span className="mt-1 block text-xs text-blue-700">
                    库位 {draft.selectedItem.location}
                  </span>
                </div>
              )}
              <ErrorText message={errors.catalog || searchError} />
            </section>
          ) : draft.mode === 'new' ? (
            <section className="space-y-4 rounded-xl border border-amber-100 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  创建库存类别并入库
                </h3>
                <Badge className="border-amber-200 bg-amber-50 text-amber-700">
                  新增物品
                </Badge>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="一级分类" required error={errors.primaryCategory}>
                  <NativeSelect
                    value={draft.newItem.primaryCategory}
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
                </Field>
                <Field
                  label="二级分类"
                  required
                  error={errors.secondaryCategory}
                >
                  <NativeSelect
                    value={draft.newItem.secondaryCategory}
                    onChange={(event) =>
                      updateNewItem('secondaryCategory', event.target.value)
                    }
                    disabled={!draft.newItem.primaryCategory}
                  >
                    <NativeSelectOption value="">
                      请选择二级分类
                    </NativeSelectOption>
                    {getInventorySecondaryCategoryOptions(
                      draft.newItem.primaryCategory,
                    ).map((secondaryCategory) => (
                      <NativeSelectOption
                        key={secondaryCategory}
                        value={secondaryCategory}
                      >
                        {secondaryCategory}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="物品名称" required error={errors.name}>
                  <Input
                    value={draft.newItem.name}
                    onChange={(event) =>
                      updateNewItem('name', event.target.value)
                    }
                  />
                </Field>
                <Field label="规格型号" required error={errors.specification}>
                  <Input
                    value={draft.newItem.specification}
                    onChange={(event) =>
                      updateNewItem('specification', event.target.value)
                    }
                  />
                </Field>
                <WarehouseStorageLocationField
                  building={draft.building}
                  value={draft.newItem.location}
                  recordId={draft.newItem.locationRecordId}
                  disabled={
                    retryLocked ||
                    categoryTaskActive ||
                    submitting ||
                    preparedNew
                  }
                  error={errors.location}
                  onChange={changeStorageLocation}
                  onCreatingChange={setCreatingStorageLocation}
                />
                <Field label="物品类别号">
                  <div
                    className="flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700"
                    aria-label="物品类别号"
                  >
                    {draft.generatedSku ||
                      (categoryTaskPhase === 'uncertain'
                        ? '结果待核对'
                        : categoryTaskPhase === 'submitting'
                          ? '正在受理'
                          : categoryTaskActive
                            ? '后台生成中'
                            : '尚未生成')}
                  </div>
                  <ErrorText message={errors.generatedSku} />
                </Field>
                <Field label="品牌">
                  <Input
                    value={draft.newItem.brand}
                    onChange={(event) =>
                      updateNewItem('brand', event.target.value)
                    }
                  />
                </Field>
                <Field label="计数单位">
                  <Input
                    value={draft.newItem.unit}
                    onChange={(event) =>
                      updateNewItem('unit', event.target.value)
                    }
                  />
                </Field>
                <Field label="最小库存量" error={errors.minimumQuantity}>
                  <Input
                    type="number"
                    min={0}
                    value={draft.newItem.minimumQuantity}
                    onChange={(event) =>
                      updateNewItem('minimumQuantity', event.target.value)
                    }
                  />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
                <Button
                  type="button"
                  variant={preparedNew ? 'outline' : 'default'}
                  disabled={
                    categoryTaskActive || creatingStorageLocation || preparedNew
                  }
                  onClick={prepareCategory}
                >
                  {categoryTaskSpinning && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  {preparedNew
                    ? `已生成 ${draft.generatedSku}`
                    : categoryTaskPhase === 'accepted'
                      ? '后台生成中'
                      : categoryTaskPhase === 'syncing' ||
                          categoryTaskPhase === 'submitting'
                        ? '正在生成'
                        : '生成新的物品类别号'}
                </Button>
                <span className="text-xs text-slate-500">
                  {preparedNew
                    ? '类别号已生成，本次入库参数已锁定。'
                    : categoryTaskMessage
                      ? categoryTaskMessage
                      : '请先核对并修改物品信息，再生成类别号。'}
                </span>
              </div>
            </section>
          ) : (
            <section className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
              请先选择“新增物品”或“已有物品”后继续办理入库。
            </section>
          )}

          <ErrorText message={errors.submit} />
        </fieldset>

        <DialogFooter>
          {categoryTaskPhase === 'uncertain' && (
            <Button type="button" variant="outline" onClick={prepareCategory}>
              使用原编号重试
            </Button>
          )}
          {retryLocked && onAbandonRetry && (
            <Button
              type="button"
              variant="outline"
              onClick={onAbandonRetry}
              className="border-amber-300 text-amber-800 hover:bg-amber-50"
            >
              放弃原编号并编辑
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={confirmDisabled}
            onClick={submit}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {submitting
              ? '正在处理'
              : batchPosition
                ? batchPosition.current < batchPosition.total
                  ? '保存本项，继续'
                  : '提交批量入库'
                : '确认入库'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
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
    <div>
      <Label className="mb-2 text-xs font-semibold text-slate-600">
        {label}
        {required && <span className="ml-1 text-rose-500">*</span>}
      </Label>
      {children}
      <ErrorText message={error} />
    </div>
  );
}

function ErrorText({ message }: { message?: string }) {
  return message ? (
    <p className="mt-1 text-xs text-rose-600">{message}</p>
  ) : null;
}

export function changePurchaseInboundDraftBuilding(
  draft: PurchaseInboundDraft,
  building: WarehouseBuilding,
): PurchaseInboundDraft {
  return {
    ...draft,
    clientMutationId: undefined,
    building,
    itemQuery: '',
    selectedItem: null,
    newItem: {
      ...draft.newItem,
      location: '',
      locationRecordId: '',
    },
  };
}

function cloneDraft(draft: PurchaseInboundDraft): PurchaseInboundDraft {
  return {
    ...draft,
    selectedItem: draft.selectedItem ? { ...draft.selectedItem } : null,
    newItem: { ...draft.newItem },
  };
}

function toLocalDateTime(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function recoverPurchaseInboundCategoryDraftAfterFailure(
  draft: PurchaseInboundDraft,
  error: unknown,
): PurchaseInboundDraft {
  return classifyInventoryInboundFailure(error) === 'rejected'
    ? { ...draft, clientMutationId: undefined }
    : draft;
}

function createClientMutationId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `purchase-inbound-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  const response =
    error && typeof error === 'object'
      ? (error as { response?: { data?: { message?: string } } }).response
      : undefined;
  return (
    response?.data?.message ||
    (error instanceof Error ? error.message : fallback)
  );
}
