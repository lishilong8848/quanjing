import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { canUseInventoryAction } from './inventory-action-access';
import type { BusinessAction } from '@shared/business-permissions';
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  History,
  Loader2,
  MapPin,
  PackageSearch,
  PackagePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

import {
  confirmInventoryOutbound,
  confirmPurchaseInbound,
  confirmPurchaseInboundsBatch,
  createInventoryMovement,
  createInventoryMovementDeletion,
  getInventoryManagementMovements,
  getInventoryMovementDeletionTaskStatus,
  getInventoryOutboundTaskStatus,
  getInventoryInboundTaskStatus,
  getPendingPurchaseInbounds,
  isInventoryInboundTaskDeferred,
  queryManualInventoryInboundTask,
  queryPurchaseInventoryInboundTask,
  submitInventoryOutbound,
  submitInventoryOutboundsBatch,
  waitForManualInventoryInboundTask,
  waitForPurchaseInventoryInboundTask,
} from '@/api';
import { useAccess } from '@/access/AccessProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type {
  InventoryMovementItem,
  InventoryMovementsResponse,
  InventoryMovementType,
  InventoryOutboundMovementItem,
  PurchaseInboundPreparedCategory,
  PurchasePendingInboundItem,
  InventoryBatchAcceptanceResponse,
  WarehouseBuilding,
} from '@shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '@shared/inventory-management.interface';
import {
  InventoryMovementCreateDialog,
  buildInventoryOutboundSubmission,
  type InventoryInboundDraft,
  type InventoryInboundSubmission,
  type InventoryOutboundDraft,
  type InventoryOutboundSubmission,
} from './InventoryMovementCreateDialog';
import { InventoryOutboundConfirmationDialog } from './InventoryOutboundConfirmationDialog';
import {
  INVENTORY_OUTBOUND_APPROVAL_REFRESH_MS,
  buildInventoryOutboundConfirmationSubmission,
  canConfirmInventoryOutboundForBuilding,
  canRestoreInventoryOutboundConfirmation,
  formatInventoryOutboundStatusLabel,
  requireCanonicalOutboundMovement,
  resolveInventoryOutboundConfirmationFailure,
  shouldRefreshInventoryOutboundApprovals,
  type InventoryOutboundConfirmationDraft,
  type InventoryOutboundConfirmationSubmission,
} from './inventory-outbound-confirmation';
import { formatInventoryMovementStatusLabel } from './inventory-movement-status';
import {
  beginMutation,
  confirmMutation,
  createInitialInventoryInboundState,
  failMutation,
  mergeMovementQueryResult,
  mergePurchaseQueryResult,
  selectVisibleMovementResponse,
} from './inventory-inbound-optimistic';
import {
  acceptInventoryInboundRecovery,
  classifyInventoryInboundFailure,
  clearInventoryInboundRecovery,
  createPurchaseInboundRecoveryDraft,
  finalizeInventoryInboundRecovery,
  isInventoryInboundRecoveryDraft,
  isInventoryInboundRetryLocked,
  isPurchaseInboundDraft,
  isPurchaseInboundRecoveryDraft,
  readInventoryInboundRecovery,
  saveInventoryInboundRecovery,
  subscribeInventoryInboundRecovery,
  type InventoryInboundRecovery,
  type PurchaseInboundRecoveryDraft,
} from './inventory-inbound-recovery';
import {
  clearInventoryOutboundRecovery,
  isInventoryOutboundConfirmationDraft,
  isInventoryOutboundDraftSnapshot,
  readInventoryOutboundRecovery,
  saveInventoryOutboundRecovery,
  subscribeInventoryOutboundRecovery,
  type InventoryOutboundDraftSnapshot,
  type InventoryOutboundRecovery,
} from './inventory-outbound-recovery';
import { type InventoryOutboundCreationCoordinatorEvent } from './inventory-outbound-creation-coordinator';
import {
  createInventoryOutboundCreationRuntime,
  type InventoryOutboundCreationRuntime,
} from './inventory-outbound-creation-runtime';
import {
  finalizeInventoryOutboundCreationTask,
  getInventoryOutboundCreationFailedReceiptIdentity,
  getInventoryOutboundCreationTaskStorageKey,
  inspectInventoryOutboundCreationTasks,
  migrateLegacyInventoryOutboundCreateRecovery,
  readInventoryOutboundCreationTasks,
  readUnconsumedInventoryOutboundCreationFailedReceipt,
  resolveInventoryOutboundCreationTask,
  saveInventoryOutboundCreationTask,
  type InventoryOutboundCreationTaskInput,
  type InventoryOutboundCreationTaskJournal,
  type InventoryOutboundCreationFailedTerminalReceipt,
} from './inventory-outbound-creation-task';
import { resolvePendingPurchaseDeepLink } from './logic';
import {
  applyInventoryBatchAcceptance,
  createInventoryBatchJournal,
  readInventoryBatchJournal,
  saveInventoryBatchJournal,
  updateInventoryBatchTask,
  type InventoryBatchJournal,
  type InventoryBatchKind,
} from './inventory-batch-acceptance';
import {
  createInventoryMovementDeletionCoordinator,
  type InventoryMovementDeletionCoordinator,
  type InventoryMovementDeletionCoordinatorEvent,
} from './inventory-movement-deletion-coordinator';
import { createInventoryInboundTaskReconciliationCoordinator } from './inventory-inbound-task-reconciliation-coordinator';
import {
  acceptInventoryMovementDeletion,
  beginInventoryMovementDeletion,
  completeInventoryMovementDeletion,
  createInitialInventoryMovementDeletionState,
  failInventoryMovementDeletion,
  markInventoryMovementDeletionUncertain,
  mergeInventoryMovementDeletionQueryResult,
  selectInventoryMovementsAfterDeletion,
} from './inventory-movement-deletion-state';
import {
  PurchaseInboundConfirmationDialog,
  type PurchaseInboundDraft,
  type PurchaseInboundSubmission,
} from './PurchaseInboundConfirmationDialog';

const PAGE_SIZE = 20;
const PENDING_PAGE_SIZE = 20;

const EMPTY_RESPONSE: InventoryMovementsResponse = {
  items: [],
  total: 0,
  page: 1,
  pageSize: PAGE_SIZE,
  totalPages: 1,
  summary: {
    totalRecords: 0,
    totalQuantity: 0,
    overdueItems: 0,
    statusCounts: [],
  },
};

const TYPE_META: Record<
  InventoryMovementType,
  {
    title: string;
    description: string;
    actionLabel: string;
    icon: LucideIcon;
    tone: string;
  }
> = {
  inbound: {
    title: '入库管理',
    description: '查看物品入库数量、楼栋库位、入库责任人和登记状态',
    actionLabel: '办理入库',
    icon: ArrowDownToLine,
    tone: 'bg-emerald-500 shadow-emerald-200',
  },
  outbound: {
    title: '出库管理',
    description: '查看来源楼栋、物品申请、库房确认和正式出库状态',
    actionLabel: '办理出库',
    icon: ArrowUpFromLine,
    tone: 'bg-blue-500 shadow-blue-200',
  },
  borrow: {
    title: '借调管理',
    description: '查看跨楼栋借调、预计归还、当前状态和逾期风险',
    actionLabel: '发起借调',
    icon: History,
    tone: 'bg-amber-500 shadow-amber-200',
  },
};

const DEFAULT_STATUSES: Record<InventoryMovementType, string[]> = {
  inbound: ['已入库', '添加', '已有'],
  outbound: ['待路由', '待审批', '待库房确认', '已驳回', '已出库'],
  borrow: ['借调中', '未归还', '已归还'],
};

interface InventoryMovementPageProps {
  type: InventoryMovementType;
  searchQuery: string;
  canConfirmOutbound?: boolean;
  outboundConfirmationAccessReady?: boolean;
  outboundConfirmationBuilding?: WarehouseBuilding | null;
  canDeleteMovements?: boolean;
  movementDeletionBuilding?: WarehouseBuilding | null;
  purchaseExecutionRecordId?: string;
  createRequested?: boolean;
  onCreateRequestHandled?: () => void;
}

type InboundMutationDraft = InventoryInboundDraft | PurchaseInboundDraft;
type InboundRecoveryDraft =
  | InventoryInboundDraft
  | PurchaseInboundDraft
  | PurchaseInboundRecoveryDraft;
type OutboundRecoveryDraft =
  | InventoryOutboundDraft
  | InventoryOutboundConfirmationDraft;
type MovementMutationDraft = InboundMutationDraft | OutboundRecoveryDraft;

export function InventoryMovementPage({
  type,
  searchQuery,
  canConfirmOutbound = false,
  outboundConfirmationAccessReady = true,
  outboundConfirmationBuilding = null,
  canDeleteMovements = false,
  movementDeletionBuilding = null,
  purchaseExecutionRecordId,
  createRequested = false,
  onCreateRequestHandled,
}: InventoryMovementPageProps) {
  const principal = useAccess();
  const { principalFingerprint } = principal;
  const canCreate = canUseInventoryAction(principal, 'create');
  const canConfirm = canUseInventoryAction(principal, 'confirm');
  const canRefresh = canUseInventoryAction(principal, 'refresh');
  const canActOnRecord = useCallback((action: BusinessAction, record: { building?: unknown; specialty?: unknown }) => canUseInventoryAction(principal, action, record), [principal]);
  const currentPrincipalRef = useRef(principal);
  currentPrincipalRef.current = principal;
  const [inboundState, setInboundState] = useState(() =>
    createInitialInventoryInboundState<MovementMutationDraft>({
      movementResponse: EMPTY_RESPONSE,
    }),
  );
  const [deletionState, setDeletionState] = useState(() =>
    createInitialInventoryMovementDeletionState(),
  );
  const [selectedMovementForDeletion, setSelectedMovementForDeletion] =
    useState<InventoryMovementItem | null>(null);
  const [building, setBuilding] = useState<WarehouseBuilding | 'all'>('all');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [pendingPage, setPendingPage] = useState(1);
  const [movementLoading, setMovementLoading] = useState(true);
  const [pendingLoading, setPendingLoading] = useState(type === 'inbound');
  const [refreshing, setRefreshing] = useState(false);
  const [movementError, setMovementError] = useState('');
  const [pendingError, setPendingError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [manualRetryDraft, setManualRetryDraft] =
    useState<InventoryInboundDraft>();
  const [manualOutboundRetryDraft, setManualOutboundRetryDraft] =
    useState<InventoryOutboundDraft>();
  const [outboundCreationTasks, setOutboundCreationTasks] = useState<
    InventoryOutboundCreationTaskJournal[]
  >([]);
  const [outboundCreationStatusMessage, setOutboundCreationStatusMessage] =
    useState('');
  const [outboundCreationStatusMessages, setOutboundCreationStatusMessages] =
    useState<Record<string, string>>({});
  const [queuedOutboundFailedReceipts, setQueuedOutboundFailedReceipts] =
    useState<InventoryOutboundCreationFailedTerminalReceipt[]>([]);
  const [outboundCreationStorageBlocked, setOutboundCreationStorageBlocked] =
    useState(false);
  const [legacyOutboundCreateBlocked, setLegacyOutboundCreateBlocked] =
    useState(() => hasUnboundLegacyOutboundCreateRecovery());
  const [legacyOutboundReconnectPending, setLegacyOutboundReconnectPending] =
    useState(false);
  const [legacyOutboundReconnectError, setLegacyOutboundReconnectError] =
    useState('');
  const [selectedOutbound, setSelectedOutbound] =
    useState<InventoryOutboundMovementItem | null>(null);
  const [outboundConfirmRetryMutationId, setOutboundConfirmRetryMutationId] =
    useState('');
  const [confirmingOutboundRecordId, setConfirmingOutboundRecordId] =
    useState('');
  const [selectedPending, setSelectedPending] =
    useState<PurchasePendingInboundItem | null>(null);
  const [selectedPendingIds, setSelectedPendingIds] = useState<Set<string>>(() => new Set());
  const [batchInboundIndex, setBatchInboundIndex] = useState(-1);
  const [batchInboundQueue, setBatchInboundQueue] = useState<PurchasePendingInboundItem[]>([]);
  const [batchInboundSubmissions, setBatchInboundSubmissions] = useState<PurchaseInboundSubmission[]>([]);
  const [batchJournals, setBatchJournals] = useState<Partial<Record<InventoryBatchKind, InventoryBatchJournal>>>({});
  const [batchErrors, setBatchErrors] = useState<Partial<Record<InventoryBatchKind, string>>>({});
  const [purchaseRetryDraft, setPurchaseRetryDraft] =
    useState<PurchaseInboundDraft>();
  const [recoveredPurchaseExecutionId, setRecoveredPurchaseExecutionId] =
    useState('');
  const [confirmingExecutionId, setConfirmingExecutionId] = useState('');
  const [highlightedExecutionId, setHighlightedExecutionId] = useState('');
  const [purchaseDeepLinkError, setPurchaseDeepLinkError] = useState('');
  const [acceptedInboundRecoveryRevision, setAcceptedInboundRecoveryRevision] =
    useState(0);
  const movementRequestRef = useRef(0);
  const outboundApprovalRefreshInFlightRef = useRef(false);
  const pendingRequestRef = useRef(0);
  const principalRequestGenerationRef = useRef(0);
  const principalRequestPrincipalRef = useRef(principalFingerprint);
  const loadMovementsRef = useRef<
    ((forceRefresh?: boolean) => Promise<void>) | null
  >(null);
  const legacyOutboundReconnectPendingRef = useRef(false);
  const pendingFailedReceiptConsumptionRef =
    useRef<InventoryOutboundCreationFailedTerminalReceipt | null>(null);
  const createOpenRef = useRef(createOpen);
  const movementDeletionUncertainNotifiedRef = useRef(new Set<string>());
  const activeInboundMutationIdsRef = useRef(new Set<string>());
  const batchAdvancingRef = useRef(false);
  const batchSendingRef = useRef(new Set<InventoryBatchKind>());
  const batchPollingRef = useRef(new Set<InventoryBatchKind>());
  const restoredBatchPrincipalRef = useRef('');
  const activeOutboundMutationIdsRef = useRef(new Set<string>());
  const outboundCreationRuntimeRef =
    useRef<InventoryOutboundCreationRuntime | null>(null);
  const movementDeletionCoordinatorRef =
    useRef<InventoryMovementDeletionCoordinator | null>(null);
  const outboundPrincipalNamespaceRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const restoredRecoveryMutationIdRef = useRef('');
  const dismissedInboundRecoveryMutationIdRef = useRef('');
  const restoredOutboundRecoveryRef = useRef<{
    clientMutationId: string;
    kind: 'create' | 'confirm';
  } | null>(null);
  const pendingSectionRef = useRef<HTMLDivElement | null>(null);
  const targetPurchaseRef = useRef<HTMLElement | null>(null);
  const handledPurchaseDeepLinkRef = useRef('');
  const activePurchaseDeepLinkRef = useRef('');
  const requestAcceptedInboundRecoveryCheck = useCallback(() => {
    setAcceptedInboundRecoveryRevision((current) => current + 1);
  }, []);
  useLayoutEffect(() => {
    createOpenRef.current = createOpen;
  }, [createOpen]);
  useLayoutEffect(() => {
    if (principalRequestPrincipalRef.current === principalFingerprint) return;
    principalRequestPrincipalRef.current = principalFingerprint;
    principalRequestGenerationRef.current += 1;
    movementRequestRef.current += 1;
    pendingRequestRef.current += 1;
  }, [principalFingerprint]);
  const outboundCreationTaskNamespace =
    getInventoryOutboundCreationTaskStorageKey(principalFingerprint);
  const visibleOutboundCreationTasks =
    outboundPrincipalNamespaceRef.current === outboundCreationTaskNamespace
      ? outboundCreationTasks
      : [];
  const visibleOutboundCreationTask =
    visibleOutboundCreationTasks.find((task) => task.taskId === null) || null;
  const primaryOutboundCreationTask =
    visibleOutboundCreationTask ||
    visibleOutboundCreationTasks.find((task) => task.status === 'conflict') ||
    visibleOutboundCreationTasks.find((task) => task.status === 'uncertain') ||
    visibleOutboundCreationTasks[0] ||
    null;
  const uncertainOutboundMutationIds = new Set(
    visibleOutboundCreationTasks
      .filter((task) => task.status === 'uncertain')
      .map((task) => task.clientMutationId),
  );
  const movementNamespaceReady =
    outboundPrincipalNamespaceRef.current === outboundCreationTaskNamespace;
  const upsertOutboundCreationTask = useCallback(
    (journal: InventoryOutboundCreationTaskJournal) => {
      setOutboundCreationTasks((current) =>
        [
          ...current.filter(
            (entry) => entry.clientMutationId !== journal.clientMutationId,
          ),
          journal,
        ].sort(
          (left, right) =>
            left.createdAt - right.createdAt ||
            left.clientMutationId.localeCompare(right.clientMutationId),
        ),
      );
    },
    [],
  );
  const removeOutboundCreationTask = useCallback((clientMutationId: string) => {
    setOutboundCreationTasks((current) =>
      current.filter((entry) => entry.clientMutationId !== clientMutationId),
    );
    setOutboundCreationStatusMessages((current) => {
      if (!(clientMutationId in current)) return current;
      const next = { ...current };
      delete next[clientMutationId];
      return next;
    });
  }, []);
  const setOutboundCreationTaskStatus = useCallback(
    (clientMutationId: string, message: string) => {
      setOutboundCreationStatusMessages((current) => ({
        ...current,
        [clientMutationId]: message,
      }));
    },
    [],
  );
  const activateOutboundFailedReceipt = useCallback(
    (receipt: InventoryOutboundCreationFailedTerminalReceipt) => {
      const recoveredDraft = receipt.recovery.draft;
      pendingFailedReceiptConsumptionRef.current = receipt;
      setManualOutboundRetryDraft({
        ...recoveredDraft,
        clientMutationId: undefined,
        selectedItem: { ...recoveredDraft.selectedItem },
        applicant: { ...recoveredDraft.applicant },
      });
      createOpenRef.current = true;
      setCreateOpen(true);
    },
    [],
  );
  const queueOutboundFailedReceipt = useCallback(
    (receipt: InventoryOutboundCreationFailedTerminalReceipt) => {
      setQueuedOutboundFailedReceipts((current) =>
        current.some(
          (entry) => entry.clientMutationId === receipt.clientMutationId,
        )
          ? current
          : [...current, receipt],
      );
    },
    [],
  );
  const restoreNextQueuedOutboundDraft = useCallback(() => {
    if (
      createOpenRef.current ||
      pendingFailedReceiptConsumptionRef.current ||
      queuedOutboundFailedReceipts.length === 0
    ) {
      toast.info('请先完成当前出库草稿，再恢复下一笔。');
      return;
    }
    const [receipt, ...remaining] = queuedOutboundFailedReceipts;
    setQueuedOutboundFailedReceipts(remaining);
    activateOutboundFailedReceipt(receipt);
    toast.info('已恢复下一笔确定未写入的出库草稿。');
  }, [activateOutboundFailedReceipt, queuedOutboundFailedReceipts]);
  const meta = TYPE_META[type];
  const normalizedMovementSearch = searchQuery.trim().toLowerCase();
  const baseResponse = movementNamespaceReady
    ? (selectVisibleMovementResponse(inboundState, (movement) => {
        if (building !== 'all' && movement.building !== building) return false;
        if (status !== 'all' && movement.status !== status) return false;
        if (!normalizedMovementSearch) return true;
        return [
          movement.sku,
          movement.name,
          movement.specification,
          movement.building,
          movement.location,
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalizedMovementSearch);
      }) ?? EMPTY_RESPONSE)
    : EMPTY_RESPONSE;
  const response = selectInventoryMovementsAfterDeletion(
    deletionState,
    baseResponse,
  );
  const shouldRefreshOutboundApprovals =
    shouldRefreshInventoryOutboundApprovals(type, response);
  const pendingPurchases = movementNamespaceReady
    ? inboundState.basePendingPurchases
    : [];
  const normalizedPurchaseExecutionRecordId =
    purchaseExecutionRecordId?.trim() || '';
  const filteredPendingPurchases = useMemo(
    () =>
      pendingPurchases
        .filter(
          (item) =>
            item.executionRecordId === normalizedPurchaseExecutionRecordId ||
            building === 'all' ||
            item.building === building,
        )
        .filter(
          (item) =>
            item.executionRecordId === normalizedPurchaseExecutionRecordId ||
            !searchQuery.trim() ||
            `${item.requestCode} ${item.itemName} ${item.sku}`
              .toLowerCase()
              .includes(searchQuery.trim().toLowerCase()),
        ),
    [
      building,
      normalizedPurchaseExecutionRecordId,
      pendingPurchases,
      searchQuery,
    ],
  );
  const pendingTotalPages = Math.max(
    1,
    Math.ceil(filteredPendingPurchases.length / PENDING_PAGE_SIZE),
  );
  const visiblePendingPurchases = filteredPendingPurchases.slice(
    (pendingPage - 1) * PENDING_PAGE_SIZE,
    pendingPage * PENDING_PAGE_SIZE,
  );

  useEffect(() => {
    if (pendingLoading || !movementNamespaceReady) return;
    const available = new Set(pendingPurchases.map((item) => item.executionRecordId));
    setSelectedPendingIds((current) => {
      if ([...current].every((id) => available.has(id))) return current;
      return new Set([...current].filter((id) => available.has(id)));
    });
  }, [movementNamespaceReady, pendingLoading, pendingPurchases]);

  const loadMovements = useCallback(
    async (forceRefresh = false) => {
      forceRefresh = forceRefresh && canRefresh;
      const requestId = ++movementRequestRef.current;
      const requestGeneration = principalRequestGenerationRef.current;
      const requestPrincipal = principalFingerprint;
      if (!forceRefresh) setMovementLoading(true);
      setMovementError('');
      try {
        const result = await getInventoryManagementMovements(
          {
            type,
            page,
            pageSize: PAGE_SIZE,
            search: searchQuery.trim(),
            building,
            status,
          },
          forceRefresh,
        );
        if (
          movementRequestRef.current !== requestId ||
          principalRequestGenerationRef.current !== requestGeneration ||
          principalRequestPrincipalRef.current !== requestPrincipal
        ) {
          return;
        }
        if (
          !result ||
          !Array.isArray(result.items) ||
          !result.summary ||
          !Array.isArray(result.summary.statusCounts)
        ) {
          throw new Error('Invalid inventory movement response');
        }
        const runtime = outboundCreationRuntimeRef.current;
        const activeMutationIds = new Set(
          runtime?.getCurrentJournals().map((task) => task.clientMutationId) ||
            [],
        );
        const authoritativeMovements = result.items.filter(
          (movement) =>
            movement.clientMutationId &&
            activeMutationIds.has(movement.clientMutationId),
        );
        if (runtime && authoritativeMovements.length > 0) {
          await Promise.all(
            authoritativeMovements.map((movement) =>
              runtime.reconcileAuthoritativeMovement(movement),
            ),
          );
        }
        if (
          movementRequestRef.current !== requestId ||
          principalRequestGenerationRef.current !== requestGeneration ||
          principalRequestPrincipalRef.current !== requestPrincipal
        ) {
          return;
        }
        setInboundState((current) =>
          mergeMovementQueryResult(current, result, requestId),
        );
        setDeletionState((current) =>
          mergeInventoryMovementDeletionQueryResult(current, result, requestId),
        );
        setMovementError('');
      } catch {
        if (
          movementRequestRef.current !== requestId ||
          principalRequestGenerationRef.current !== requestGeneration ||
          principalRequestPrincipalRef.current !== requestPrincipal
        ) {
          return;
        }
        setMovementError(
          `${meta.title}数据读取失败，请检查网络或数据源后重试。`,
        );
      } finally {
        if (
          movementRequestRef.current === requestId &&
          principalRequestGenerationRef.current === requestGeneration &&
          principalRequestPrincipalRef.current === requestPrincipal
        ) {
          setMovementLoading(false);
        }
      }
    },
    [
      building,
      meta.title,
      canRefresh,
      page,
      principalFingerprint,
      searchQuery,
      status,
      type,
    ],
  );

  const loadPendingPurchases = useCallback(
    async (forceRefresh = false) => {
      forceRefresh = forceRefresh && canRefresh;
      if (type !== 'inbound') return [];
      const requestId = ++pendingRequestRef.current;
      const requestGeneration = principalRequestGenerationRef.current;
      const requestPrincipal = principalFingerprint;
      if (!forceRefresh) setPendingLoading(true);
      setPendingError('');
      try {
        const result = await getPendingPurchaseInbounds(forceRefresh);
        if (
          pendingRequestRef.current !== requestId ||
          principalRequestGenerationRef.current !== requestGeneration ||
          principalRequestPrincipalRef.current !== requestPrincipal
        ) {
          return null;
        }
        if (!result || !Array.isArray(result.items)) {
          throw new Error('Invalid pending purchase inbound response');
        }
        setInboundState((current) =>
          mergePurchaseQueryResult(current, result.items, requestId),
        );
        setPendingError('');
        return result.items;
      } catch {
        if (
          pendingRequestRef.current !== requestId ||
          principalRequestGenerationRef.current !== requestGeneration ||
          principalRequestPrincipalRef.current !== requestPrincipal
        ) {
          return null;
        }
        setPendingError('待采购入库清单读取失败，请检查网络或数据源后重试。');
        return null;
      } finally {
        if (
          pendingRequestRef.current === requestId &&
          principalRequestGenerationRef.current === requestGeneration &&
          principalRequestPrincipalRef.current === requestPrincipal
        ) {
          setPendingLoading(false);
        }
      }
    },
    [principalFingerprint, type, canRefresh],
  );

  useEffect(() => {
    loadMovementsRef.current = loadMovements;
  }, [loadMovements]);

  const applyInboundRecovery = useCallback(
    (recovery: InventoryInboundRecovery<InboundRecoveryDraft>): boolean => {
      if (
        recovery.kind === 'manual' &&
        isInventoryInboundRecoveryDraft(recovery.draft)
      ) {
        restoredRecoveryMutationIdRef.current = recovery.clientMutationId;
        setManualRetryDraft({
          ...recovery.draft,
          clientMutationId: isInventoryInboundRetryLocked(recovery)
            ? recovery.clientMutationId
            : undefined,
        });
        setPurchaseRetryDraft(undefined);
        setRecoveredPurchaseExecutionId('');
        setSelectedPending(null);
        setCreateOpen(true);
        return true;
      }

      if (
        recovery.kind === 'purchase' &&
        recovery.purchaseExecutionRecordId &&
        isPurchaseInboundRecoveryDraft(recovery.draft) &&
        isPurchaseInboundDraft(recovery.draft.form) &&
        recovery.purchaseExecutionRecordId ===
          recovery.draft.form.executionRecordId
      ) {
        const currentPurchase =
          pendingPurchases.find(
            (item) =>
              item.executionRecordId === recovery.purchaseExecutionRecordId,
          ) ?? recovery.draft.purchaseSnapshot;
        restoredRecoveryMutationIdRef.current = recovery.clientMutationId;
        setManualRetryDraft(undefined);
        setCreateOpen(false);
        setPurchaseRetryDraft({
          ...recovery.draft.form,
          clientMutationId: isInventoryInboundRetryLocked(recovery)
            ? recovery.clientMutationId
            : undefined,
        });
        setRecoveredPurchaseExecutionId(recovery.purchaseExecutionRecordId);
        setSelectedPending(currentPurchase);
        return true;
      }

      // Backward-compatible recovery for snapshots written before purchase
      // context persistence was introduced.
      if (
        recovery.kind === 'purchase' &&
        recovery.purchaseExecutionRecordId &&
        isPurchaseInboundDraft(recovery.draft) &&
        recovery.purchaseExecutionRecordId === recovery.draft.executionRecordId
      ) {
        restoredRecoveryMutationIdRef.current = recovery.clientMutationId;
        setManualRetryDraft(undefined);
        setCreateOpen(false);
        setPurchaseRetryDraft({
          ...recovery.draft,
          clientMutationId: isInventoryInboundRetryLocked(recovery)
            ? recovery.clientMutationId
            : undefined,
        });
        setRecoveredPurchaseExecutionId(recovery.purchaseExecutionRecordId);
        const currentPurchase = pendingPurchases.find(
          (item) =>
            item.executionRecordId === recovery.purchaseExecutionRecordId,
        );
        if (currentPurchase) setSelectedPending(currentPurchase);
        return true;
      }
      return false;
    },
    [pendingPurchases],
  );

  const restoreSavedInboundRecovery = useCallback(() => {
    const recovery = readInventoryInboundRecovery<InboundRecoveryDraft>();
    if (!recovery) {
      if (restoredRecoveryMutationIdRef.current) {
        restoredRecoveryMutationIdRef.current = '';
        setManualRetryDraft(undefined);
        setPurchaseRetryDraft(undefined);
        setRecoveredPurchaseExecutionId('');
        setCreateOpen(false);
        setSelectedPending(null);
      }
      return null;
    }
    if (activeInboundMutationIdsRef.current.has(recovery.clientMutationId)) {
      return recovery;
    }
    if (recovery.status === 'accepted') {
      return recovery;
    }
    if (
      recovery.clientMutationId ===
      dismissedInboundRecoveryMutationIdRef.current
    ) {
      return recovery;
    }
    applyInboundRecovery(recovery);
    return recovery;
  }, [applyInboundRecovery]);

  const queryAcceptedPurchaseInboundRecovery = useCallback(
    async (recovery: InventoryInboundRecovery<InboundRecoveryDraft>) => {
      if (
        recovery.kind !== 'purchase' ||
        recovery.status !== 'accepted' ||
        !recovery.taskId ||
        !recovery.purchaseExecutionRecordId
      ) {
        return;
      }

      toast.info('该采购入库已受理，正在查询后台任务最新状态。');
      try {
        const result = await queryPurchaseInventoryInboundTask(recovery.taskId);
        if (isInventoryInboundTaskDeferred(result)) {
          if (mountedRef.current) {
            toast.info(result.message || '采购入库仍在后台同步，请稍后再查。');
          }
          return;
        }
        if (
          result.executionRecordId !== recovery.purchaseExecutionRecordId ||
          result.movement?.clientMutationId !== recovery.clientMutationId
        ) {
          throw new Error('恢复的采购入库任务结果与原请求不一致');
        }
        const finalized = finalizeInventoryInboundRecovery(
          recovery.clientMutationId,
          'completed',
        );
        if (!mountedRef.current || !finalized) return;
        await Promise.allSettled([
          loadMovements(true),
          loadPendingPurchases(true),
        ]);
        toast.success(result.message || '采购入库后台同步已完成');
      } catch (error) {
        const outcome = classifyInventoryInboundFailure(error, true);
        if (outcome === 'rejected') {
          finalizeInventoryInboundRecovery(recovery.clientMutationId, 'failed');
          if (
            isPurchaseInboundRecoveryDraft(recovery.draft) &&
            recovery.purchaseExecutionRecordId ===
              recovery.draft.form.executionRecordId
          ) {
            saveInventoryInboundRecovery({
              kind: 'purchase',
              status: 'failed',
              retryMode: 'editable',
              clientMutationId: recovery.clientMutationId,
              purchaseExecutionRecordId: recovery.purchaseExecutionRecordId,
              draft: {
                ...recovery.draft,
                form: {
                  ...recovery.draft.form,
                  clientMutationId: undefined,
                },
              },
            });
          } else if (
            isPurchaseInboundDraft(recovery.draft) &&
            recovery.purchaseExecutionRecordId ===
              recovery.draft.executionRecordId
          ) {
            saveInventoryInboundRecovery({
              kind: 'purchase',
              status: 'failed',
              retryMode: 'editable',
              clientMutationId: recovery.clientMutationId,
              purchaseExecutionRecordId: recovery.purchaseExecutionRecordId,
              draft: { ...recovery.draft, clientMutationId: undefined },
            });
          }
          if (mountedRef.current) restoreSavedInboundRecovery();
        }
        if (mountedRef.current) {
          toast.error(
            outcome === 'rejected'
              ? errorMessage(error, '采购入库后台任务失败，已恢复可编辑草稿。')
              : '采购入库任务查询暂时中断，任务号仍已保留；稍后可继续查询。',
          );
        }
      }
    },
    [loadMovements, loadPendingPurchases, restoreSavedInboundRecovery],
  );

  const applyOutboundRecovery = useCallback(
    (
      recovery: InventoryOutboundRecovery<
        OutboundRecoveryDraft,
        InventoryOutboundMovementItem
      >,
    ): boolean => {
      if (
        recovery.kind === 'create' &&
        isInventoryOutboundDraftSnapshot(recovery.draft)
      ) {
        if (recovery.status === 'unknown') return false;
        clearInventoryOutboundRecovery(recovery.clientMutationId);
        setManualOutboundRetryDraft({
          ...recovery.draft,
          clientMutationId: undefined,
          selectedItem: recovery.draft.selectedItem
            ? { ...recovery.draft.selectedItem }
            : null,
          applicant: recovery.draft.applicant
            ? { ...recovery.draft.applicant }
            : null,
        });
        setOutboundConfirmRetryMutationId('');
        setSelectedOutbound(null);
        setCreateOpen(true);
        return true;
      }
      if (
        recovery.kind === 'confirm' &&
        isInventoryOutboundConfirmationDraft(recovery.draft) &&
        recovery.recordId === recovery.itemSnapshot.recordId &&
        recovery.itemSnapshot.status === '待库房确认'
      ) {
        if (recovery.status === 'draft') {
          restoredOutboundRecoveryRef.current = null;
          clearInventoryOutboundRecovery(recovery.clientMutationId);
          setOutboundConfirmRetryMutationId('');
          setSelectedOutbound(null);
          return false;
        }
        if (!outboundConfirmationAccessReady) {
          restoredOutboundRecoveryRef.current = {
            clientMutationId: recovery.clientMutationId,
            kind: 'confirm',
          };
          setOutboundConfirmRetryMutationId('');
          setSelectedOutbound(null);
          return false;
        }
        if (currentPrincipalRef.current.effectiveAuthorization && !canUseInventoryAction(currentPrincipalRef.current, 'confirm', recovery.itemSnapshot)) {
          setOutboundConfirmRetryMutationId('');
          setSelectedOutbound(null);
          return false;
        }
        if (
          !canRestoreInventoryOutboundConfirmation(
            canConfirmOutbound,
            recovery.status,
            recovery.itemSnapshot.building,
            outboundConfirmationBuilding,
          )
        ) {
          restoredOutboundRecoveryRef.current = null;
          clearInventoryOutboundRecovery(recovery.clientMutationId);
          setOutboundConfirmRetryMutationId('');
          setSelectedOutbound(null);
          return false;
        }
        restoredOutboundRecoveryRef.current = {
          clientMutationId: recovery.clientMutationId,
          kind: 'confirm',
        };
        setCreateOpen(false);
        setManualOutboundRetryDraft(undefined);
        setOutboundConfirmRetryMutationId(recovery.clientMutationId);
        setSelectedOutbound({ ...recovery.itemSnapshot });
        return true;
      }
      return false;
    },
    [
      canConfirmOutbound,
      outboundConfirmationAccessReady,
      outboundConfirmationBuilding,
    ],
  );

  const restoreSavedOutboundRecovery = useCallback(() => {
    const recovery = readInventoryOutboundRecovery<
      OutboundRecoveryDraft,
      InventoryOutboundMovementItem
    >();
    if (!recovery) {
      setLegacyOutboundCreateBlocked(false);
      const restored = restoredOutboundRecoveryRef.current;
      if (restored) {
        restoredOutboundRecoveryRef.current = null;
        if (restored.kind === 'create') {
          setManualOutboundRetryDraft((current) =>
            current?.clientMutationId === restored.clientMutationId
              ? undefined
              : current,
          );
          setCreateOpen(false);
        } else {
          setOutboundConfirmRetryMutationId((current) =>
            current === restored.clientMutationId ? '' : current,
          );
          setSelectedOutbound(null);
        }
      }
      return null;
    }
    if (recovery.kind === 'create' && recovery.status === 'unknown') {
      setLegacyOutboundCreateBlocked(true);
      return recovery;
    }
    setLegacyOutboundCreateBlocked(false);
    if (activeOutboundMutationIdsRef.current.has(recovery.clientMutationId)) {
      return recovery;
    }
    applyOutboundRecovery(recovery);
    return recovery;
  }, [applyOutboundRecovery]);

  const openPendingPurchaseDeepLink = useCallback(async () => {
    if (type !== 'inbound' || !normalizedPurchaseExecutionRecordId) return;
    const recovery = restoreSavedInboundRecovery();
    if (recovery) {
      toast.info('请先完成已恢复的入库草稿，系统已保留原入库编号');
      return;
    }

    const targetExecutionRecordId = normalizedPurchaseExecutionRecordId;
    activePurchaseDeepLinkRef.current = targetExecutionRecordId;
    setSelectedPending(null);
    setHighlightedExecutionId('');
    setPurchaseDeepLinkError('');

    const resolution = await resolvePendingPurchaseDeepLink(
      targetExecutionRecordId,
      loadPendingPurchases,
    );
    if (activePurchaseDeepLinkRef.current !== targetExecutionRecordId) return;
    if (resolution.status === 'read_failed') return;
    if (resolution.status === 'missing') {
      setPurchaseDeepLinkError(
        '未找到指定的待入库采购，可能已完成入库，或当前账号无权查看',
      );
      return;
    }

    setHighlightedExecutionId(resolution.item.executionRecordId);
    setSelectedPending(resolution.item);
  }, [
    loadPendingPurchases,
    normalizedPurchaseExecutionRecordId,
    restoreSavedInboundRecovery,
    type,
  ]);

  const retryPendingPurchases = useCallback(() => {
    if (normalizedPurchaseExecutionRecordId) {
      void openPendingPurchaseDeepLink();
      return;
    }
    void loadPendingPurchases();
  }, [
    loadPendingPurchases,
    normalizedPurchaseExecutionRecordId,
    openPendingPurchaseDeepLink,
  ]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const requests: Promise<unknown>[] = [loadMovements(true)];
      if (type === 'inbound') requests.push(loadPendingPurchases(true));
      await Promise.allSettled(requests);
    } finally {
      setRefreshing(false);
    }
  }, [loadMovements, loadPendingPurchases, type]);

  useEffect(() => {
    void loadMovements();
  }, [loadMovements]);

  useEffect(() => {
    if (!shouldRefreshOutboundApprovals) return;
    const intervalId = window.setInterval(() => {
      if (
        document.visibilityState !== 'visible' ||
        outboundApprovalRefreshInFlightRef.current
      ) {
        return;
      }
      outboundApprovalRefreshInFlightRef.current = true;
      void loadMovements(true).finally(() => {
        outboundApprovalRefreshInFlightRef.current = false;
      });
    }, INVENTORY_OUTBOUND_APPROVAL_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [loadMovements, shouldRefreshOutboundApprovals]);

  useEffect(() => {
    if (type === 'inbound' && !normalizedPurchaseExecutionRecordId)
      void loadPendingPurchases();
  }, [loadPendingPurchases, normalizedPurchaseExecutionRecordId, type]);

  useEffect(() => {
    if (!createRequested || !canCreate) {
      return;
    }
    if (type === 'inbound' && restoreSavedInboundRecovery()) {
      toast.info('请先完成已恢复的入库草稿，系统已保留原入库编号');
      onCreateRequestHandled?.();
      return;
    }
    if (type === 'outbound' && visibleOutboundCreationTask) {
      toast.info('当前出库尚未取得任务编号，请等待服务端受理后再办理下一笔');
      onCreateRequestHandled?.();
      return;
    }
    if (
      type === 'outbound' &&
      (legacyOutboundCreateBlocked || hasUnboundLegacyOutboundCreateRecovery())
    ) {
      toast.error(
        '检测到未绑定身份的旧版出库恢复记录，请联系管理员处理；本次不会发送出库请求。',
      );
      onCreateRequestHandled?.();
      return;
    }
    setCreateOpen(true);
    onCreateRequestHandled?.();
  }, [
    createRequested,
    canCreate,
    onCreateRequestHandled,
    restoreSavedInboundRecovery,
    legacyOutboundCreateBlocked,
    type,
    visibleOutboundCreationTask,
  ]);

  useEffect(() => {
    setBuilding('all');
    setStatus('all');
    setPage(1);
    setPendingPage(1);
    setInboundState(
      createInitialInventoryInboundState<MovementMutationDraft>({
        movementResponse: EMPTY_RESPONSE,
      }),
    );
    setDeletionState(createInitialInventoryMovementDeletionState());
    setSelectedMovementForDeletion(null);
    setManualRetryDraft(undefined);
    setManualOutboundRetryDraft(undefined);
    setOutboundCreationTasks([]);
    setOutboundCreationStatusMessages({});
    setQueuedOutboundFailedReceipts([]);
    setOutboundCreationStatusMessage('');
    setOutboundCreationStorageBlocked(false);
    pendingFailedReceiptConsumptionRef.current = null;
    setSelectedOutbound(null);
    setOutboundConfirmRetryMutationId('');
    setConfirmingOutboundRecordId('');
    setSelectedPending(null);
    setPurchaseRetryDraft(undefined);
    setRecoveredPurchaseExecutionId('');
    restoredRecoveryMutationIdRef.current = '';
    setConfirmingExecutionId('');
    setHighlightedExecutionId('');
    setPurchaseDeepLinkError('');
  }, [type]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    outboundCreationRuntimeRef.current?.stop();
    outboundCreationRuntimeRef.current = null;
    const previousNamespace = outboundPrincipalNamespaceRef.current;
    const namespace =
      getInventoryOutboundCreationTaskStorageKey(principalFingerprint);
    if (previousNamespace !== namespace) {
      setInboundState(
        createInitialInventoryInboundState<MovementMutationDraft>({
          movementResponse: EMPTY_RESPONSE,
        }),
      );
      setDeletionState(createInitialInventoryMovementDeletionState());
      setSelectedMovementForDeletion(null);
      setCreateOpen(false);
      setManualRetryDraft(undefined);
      setManualOutboundRetryDraft(undefined);
      setSelectedOutbound(null);
      setOutboundConfirmRetryMutationId('');
      setConfirmingOutboundRecordId('');
      setSelectedPending(null);
      setPurchaseRetryDraft(undefined);
      setRecoveredPurchaseExecutionId('');
      setConfirmingExecutionId('');
      setHighlightedExecutionId('');
      setPurchaseDeepLinkError('');
      setLegacyOutboundReconnectError('');
      setOutboundCreationStorageBlocked(false);
      pendingFailedReceiptConsumptionRef.current = null;
      setQueuedOutboundFailedReceipts([]);
      activeInboundMutationIdsRef.current.clear();
      activeOutboundMutationIdsRef.current.clear();
      restoredRecoveryMutationIdRef.current = '';
      restoredOutboundRecoveryRef.current = null;
      activePurchaseDeepLinkRef.current = '';
      handledPurchaseDeepLinkRef.current = '';
    }
    outboundPrincipalNamespaceRef.current = namespace;
    setOutboundCreationTasks([]);
    setOutboundCreationStatusMessages({});
    setOutboundCreationStatusMessage('');
    setOutboundCreationStorageBlocked(false);
    if (type !== 'outbound' || !namespace || !principalFingerprint) return;

    const handleCoordinatorEvent = (
      event: InventoryOutboundCreationCoordinatorEvent,
    ) => {
      if (outboundPrincipalNamespaceRef.current !== namespace) return;
      if (event.type === 'optimistic') {
        setPage(1);
        setInboundState((current) =>
          beginMutation(current, journalToOutboundSubmission(event.journal)),
        );
        setManualOutboundRetryDraft(undefined);
        createOpenRef.current = false;
        setCreateOpen(false);
        upsertOutboundCreationTask(event.journal);
        setOutboundCreationTaskStatus(event.journal.clientMutationId, '');
        return;
      }
      if (event.type === 'status') {
        upsertOutboundCreationTask(event.journal);
        setOutboundCreationTaskStatus(
          event.journal.clientMutationId,
          event.message,
        );
        return;
      }
      if (event.type === 'authoritative-refresh-required') {
        upsertOutboundCreationTask(event.journal);
        setOutboundCreationTaskStatus(
          event.journal.clientMutationId,
          event.message,
        );
        void loadMovementsRef.current?.(true);
        return;
      }
      if (event.type === 'completed') {
        setInboundState((current) =>
          confirmMutation(
            current,
            event.journal.clientMutationId,
            event.result.movement,
            movementRequestRef.current,
          ),
        );
        removeOutboundCreationTask(event.journal.clientMutationId);
        toast.success(event.result.message);
        return;
      }

      setInboundState((current) =>
        failMutation(
          current,
          event.journal.clientMutationId,
          new Error(event.message),
        ),
      );
      removeOutboundCreationTask(event.journal.clientMutationId);
      if (
        !createOpenRef.current &&
        !pendingFailedReceiptConsumptionRef.current
      ) {
        activateOutboundFailedReceipt(event.receipt);
        toast.error(`出库请求确定未写入，已恢复可编辑草稿：${event.message}`);
      } else {
        queueOutboundFailedReceipt(event.receipt);
        toast.error(
          `出库请求确定未写入，草稿已保留：${event.message}。当前编辑内容不会被后台失败任务覆盖。`,
        );
      }
    };

    const runtime = createInventoryOutboundCreationRuntime({
      principalFingerprint: principalFingerprint,
      submitOutbound: (request) => {
        if (!canUseInventoryAction(currentPrincipalRef.current, 'create')) return Promise.reject(new Error('当前权限不能提交出库，原任务记录已保留'));
        return submitInventoryOutbound(request);
      },
      getTaskStatus: getInventoryOutboundTaskStatus,
      saveJournal: saveInventoryOutboundCreationTask,
      finalizeJournal: finalizeInventoryOutboundCreationTask,
      resolveJournal: resolveInventoryOutboundCreationTask,
      readJournals: readInventoryOutboundCreationTasks,
      onEvent: handleCoordinatorEvent,
    });
    outboundCreationRuntimeRef.current = runtime;

    let disposed = false;
    void (async () => {
      const taskInspection =
        await inspectInventoryOutboundCreationTasks(principalFingerprint);
      if (
        disposed ||
        outboundPrincipalNamespaceRef.current !== namespace ||
        outboundCreationRuntimeRef.current !== runtime
      ) {
        return;
      }
      if (hasUnboundLegacyOutboundCreateRecovery()) {
        setLegacyOutboundCreateBlocked(true);
      }
      if (taskInspection.kind === 'unavailable') {
        setOutboundCreationStorageBlocked(true);
        setOutboundCreationStatusMessage(
          '本地出库任务日志异常或暂时不可读取，原记录已保留。',
        );
        return;
      }
      setOutboundCreationStorageBlocked(false);
      const savedTasks =
        taskInspection.kind === 'active' ? taskInspection.journals : [];
      if (savedTasks.length > 0 && !(await runtime.resumeAll(savedTasks))) {
        setOutboundCreationStorageBlocked(true);
        setOutboundCreationStatusMessage(
          '部分出库任务无法安全恢复，原记录已保留且不会重复发送。',
        );
      }
      const failedRecovery =
        await readUnconsumedInventoryOutboundCreationFailedReceipt(
          principalFingerprint,
        );
      if (
        disposed ||
        outboundPrincipalNamespaceRef.current !== namespace ||
        outboundCreationRuntimeRef.current !== runtime
      ) {
        return;
      }
      if (failedRecovery.kind === 'unavailable') {
        setOutboundCreationStorageBlocked(true);
        setOutboundCreationStatusMessage(
          '本地出库终态回执异常或暂时不可读取，原记录已保留。',
        );
        return;
      }
      if (failedRecovery.kind !== 'failed-recovery') return;
      const restoredImmediately =
        !createOpenRef.current && !pendingFailedReceiptConsumptionRef.current;
      if (restoredImmediately) {
        activateOutboundFailedReceipt(failedRecovery.receipt);
      } else {
        queueOutboundFailedReceipt(failedRecovery.receipt);
      }
      setOutboundCreationStatusMessage('');
      toast.error(
        restoredImmediately
          ? `出库请求确定未写入，已恢复可编辑草稿：${failedRecovery.receipt.outcome.message}`
          : `出库请求确定未写入，草稿已保留：${failedRecovery.receipt.outcome.message}。当前编辑内容不会被后台失败任务覆盖。`,
      );
    })();

    const checkNow = () => {
      void runtime.checkNow();
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === 'visible') void runtime.checkNow();
    };
    window.addEventListener('focus', checkNow);
    document.addEventListener('visibilitychange', checkWhenVisible);
    return () => {
      disposed = true;
      window.removeEventListener('focus', checkNow);
      document.removeEventListener('visibilitychange', checkWhenVisible);
      runtime.stop();
      if (outboundCreationRuntimeRef.current === runtime) {
        outboundCreationRuntimeRef.current = null;
      }
    };
  }, [
    activateOutboundFailedReceipt,
    principalFingerprint,
    queueOutboundFailedReceipt,
    removeOutboundCreationTask,
    setOutboundCreationTaskStatus,
    type,
    upsertOutboundCreationTask,
  ]);

  useEffect(() => {
    movementDeletionCoordinatorRef.current?.stop();
    movementDeletionCoordinatorRef.current = null;
    movementDeletionUncertainNotifiedRef.current.clear();
    if (
      !principalFingerprint ||
      !canDeleteMovements ||
      (type !== 'inbound' && type !== 'outbound')
    ) {
      return;
    }

    let localStorage: Storage;
    try {
      localStorage = window.localStorage;
    } catch {
      toast.error('浏览器无法读取删除任务日志，当前不会发送删除请求。');
      return;
    }

    const handleDeletionEvent = (
      event: InventoryMovementDeletionCoordinatorEvent,
    ) => {
      if (event.type === 'optimistic') {
        setDeletionState((current) =>
          beginInventoryMovementDeletion(current, {
            clientMutationId: event.journal.clientMutationId,
            movement: event.journal.movement,
            originalIndex: event.journal.originalIndex,
            requestWatermark: event.journal.requestWatermark,
            startedAt: event.journal.createdAt,
          }),
        );
        if (!event.restored) {
          setSelectedMovementForDeletion(null);
          toast.info('记录已从当前清单隐藏，正在后台同步删除');
        }
        return;
      }
      if (event.type === 'accepted' || event.type === 'status') {
        setDeletionState((current) =>
          acceptInventoryMovementDeletion(
            current,
            event.journal.clientMutationId,
            event.journal.taskId || '',
            event.journal.updatedAt,
          ),
        );
        return;
      }
      if (event.type === 'completed') {
        movementDeletionUncertainNotifiedRef.current.delete(
          event.journal.clientMutationId,
        );
        setDeletionState((current) =>
          completeInventoryMovementDeletion(
            current,
            event.journal.clientMutationId,
            movementRequestRef.current,
            event.journal.updatedAt,
          ),
        );
        toast.success(event.message);
        void loadMovementsRef.current?.(true);
        if (event.purchaseRolledBack) void loadPendingPurchases(true);
        return;
      }
      if (event.type === 'failed') {
        movementDeletionUncertainNotifiedRef.current.delete(
          event.clientMutationId,
        );
        setDeletionState((current) =>
          failInventoryMovementDeletion(
            current,
            event.clientMutationId,
            event.message,
          ),
        );
        toast.error(`删除确定未执行，记录已恢复：${event.message}`);
        return;
      }

      setDeletionState((current) =>
        markInventoryMovementDeletionUncertain(
          current,
          event.clientMutationId,
          event.message,
          event.journal.updatedAt,
        ),
      );
      if (
        !movementDeletionUncertainNotifiedRef.current.has(
          event.clientMutationId,
        )
      ) {
        movementDeletionUncertainNotifiedRef.current.add(
          event.clientMutationId,
        );
        toast.warning(
          `删除结果待核对，系统将使用原编号继续查询：${event.message}`,
        );
      }
    };

    const coordinator = createInventoryMovementDeletionCoordinator({
      principalFingerprint,
      storage: localStorage,
      submitDeletion: createInventoryMovementDeletion,
      getTaskStatus: getInventoryMovementDeletionTaskStatus,
      onEvent: handleDeletionEvent,
    });
    movementDeletionCoordinatorRef.current = coordinator;
    coordinator.resume();

    const checkNow = () => {
      void coordinator.checkNow();
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === 'visible') void coordinator.checkNow();
    };
    window.addEventListener('focus', checkNow);
    document.addEventListener('visibilitychange', checkWhenVisible);
    return () => {
      window.removeEventListener('focus', checkNow);
      document.removeEventListener('visibilitychange', checkWhenVisible);
      coordinator.stop();
      if (movementDeletionCoordinatorRef.current === coordinator) {
        movementDeletionCoordinatorRef.current = null;
      }
    };
  }, [canDeleteMovements, loadPendingPurchases, principalFingerprint, type]);

  useEffect(() => {
    const coordinator = movementDeletionCoordinatorRef.current;
    if (!coordinator) return;
    const tombstoneMutationIds = new Set(
      [...deletionState.tombstones.values()].map(
        (tombstone) => tombstone.clientMutationId,
      ),
    );
    for (const journal of coordinator.getJournals()) {
      if (
        journal.status === 'completed' &&
        !tombstoneMutationIds.has(journal.clientMutationId)
      ) {
        coordinator.removeCompleted(journal.clientMutationId);
      }
    }
  }, [deletionState.tombstones]);

  useEffect(() => {
    if (type !== 'inbound') return;

    const recovery = readInventoryInboundRecovery<InboundRecoveryDraft>();
    if (!recovery) return;
    const acceptedRecovery = recovery.status === 'accepted';
    if (
      !acceptedRecovery ||
      !recovery.taskId ||
      !recovery.request ||
      activeInboundMutationIdsRef.current.has(recovery.clientMutationId)
    ) {
      return;
    }
    activeInboundMutationIdsRef.current.add(recovery.clientMutationId);
    let transientFailureNotified = false;
    const coordinator =
      createInventoryInboundTaskReconciliationCoordinator<InventoryMovementItem>(
        {
          query: async () => {
            if (recovery.kind === 'manual') {
              const result = await queryManualInventoryInboundTask(
                recovery.taskId!,
              );
              if (isInventoryInboundTaskDeferred(result)) {
                return { status: 'pending' as const };
              }
              const movement = result.movement;
              if (
                !movement ||
                result.type !== 'inbound' ||
                movement.clientMutationId !== recovery.clientMutationId
              ) {
                throw new Error('恢复的入库任务结果与原请求不一致');
              }
              return { status: 'completed' as const, value: movement };
            }

            const result = await queryPurchaseInventoryInboundTask(
              recovery.taskId!,
            );
            if (isInventoryInboundTaskDeferred(result)) {
              return { status: 'pending' as const };
            }
            const movement = result.movement;
            if (
              !movement ||
              result.executionRecordId !== recovery.purchaseExecutionRecordId ||
              movement.clientMutationId !== recovery.clientMutationId
            ) {
              throw new Error('恢复的采购入库任务结果与原请求不一致');
            }
            return { status: 'completed' as const, value: movement };
          },
          onCompleted: async (movement) => {
            const finalized = finalizeInventoryInboundRecovery(
              recovery.clientMutationId,
              'completed',
            );
            activeInboundMutationIdsRef.current.delete(
              recovery.clientMutationId,
            );
            if (!mountedRef.current || !finalized) return;
            setInboundState((current) =>
              confirmMutation(
                current,
                recovery.clientMutationId,
                movement,
                movementRequestRef.current,
              ),
            );
            await Promise.allSettled([
              loadMovements(true),
              loadPendingPurchases(true),
            ]);
            if (!movement.operator) {
              window.setTimeout(() => {
                if (
                  mountedRef.current &&
                  document.visibilityState === 'visible'
                ) {
                  void loadMovements(true);
                }
              }, 2_000);
            }
            toast.success('入库后台同步已完成');
          },
          onError: (error) => {
            const outcome = classifyInventoryInboundFailure(error, true);
            if (outcome !== 'rejected') {
              if (mountedRef.current && !transientFailureNotified) {
                transientFailureNotified = true;
                toast.warning(
                  '入库任务查询暂时中断，任务号已保留，系统会自动继续查询。',
                );
              }
              return 'retry';
            }

            finalizeInventoryInboundRecovery(
              recovery.clientMutationId,
              'failed',
            );
            if (
              recovery.kind === 'manual' &&
              isInventoryInboundRecoveryDraft(recovery.draft)
            ) {
              saveInventoryInboundRecovery({
                kind: 'manual',
                status: 'failed',
                retryMode: 'editable',
                clientMutationId: recovery.clientMutationId,
                draft: { ...recovery.draft, clientMutationId: undefined },
              });
            } else if (
              recovery.kind === 'purchase' &&
              recovery.purchaseExecutionRecordId &&
              isPurchaseInboundRecoveryDraft(recovery.draft)
            ) {
              saveInventoryInboundRecovery({
                kind: 'purchase',
                status: 'failed',
                retryMode: 'editable',
                clientMutationId: recovery.clientMutationId,
                purchaseExecutionRecordId: recovery.purchaseExecutionRecordId,
                draft: {
                  ...recovery.draft,
                  form: {
                    ...recovery.draft.form,
                    clientMutationId: undefined,
                  },
                },
              });
            }
            activeInboundMutationIdsRef.current.delete(
              recovery.clientMutationId,
            );
            if (mountedRef.current) {
              restoreSavedInboundRecovery();
              toast.error(
                errorMessage(error, '入库后台任务失败，已恢复可编辑草稿。'),
              );
            }
            return 'stop';
          },
        },
      );

    void coordinator.start();
    const checkAcceptedInboundTaskNow = () => {
      void coordinator.checkNow();
    };
    const checkAcceptedInboundTaskWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        checkAcceptedInboundTaskNow();
      }
    };
    window.addEventListener('focus', checkAcceptedInboundTaskNow);
    document.addEventListener(
      'visibilitychange',
      checkAcceptedInboundTaskWhenVisible,
    );
    return () => {
      window.removeEventListener('focus', checkAcceptedInboundTaskNow);
      document.removeEventListener(
        'visibilitychange',
        checkAcceptedInboundTaskWhenVisible,
      );
      coordinator.stop();
      activeInboundMutationIdsRef.current.delete(recovery.clientMutationId);
    };
  }, [
    acceptedInboundRecoveryRevision,
    loadMovements,
    loadPendingPurchases,
    principalFingerprint,
    restoreSavedInboundRecovery,
    type,
  ]);

  useEffect(() => {
    if (type !== 'inbound') return;

    const restoreRecovery = () => {
      restoreSavedInboundRecovery();
    };

    restoreRecovery();
    return subscribeInventoryInboundRecovery(restoreRecovery);
  }, [restoreSavedInboundRecovery, type]);

  useEffect(() => {
    if (type !== 'outbound') return;

    const restoreRecovery = () => {
      restoreSavedOutboundRecovery();
    };

    restoreRecovery();
    return subscribeInventoryOutboundRecovery(restoreRecovery);
  }, [principalFingerprint, restoreSavedOutboundRecovery, type]);

  useEffect(() => {
    if (
      type !== 'inbound' ||
      !recoveredPurchaseExecutionId ||
      selectedPending
    ) {
      return;
    }
    const recoveredPurchase = pendingPurchases.find(
      (item) => item.executionRecordId === recoveredPurchaseExecutionId,
    );
    if (recoveredPurchase) setSelectedPending(recoveredPurchase);
  }, [pendingPurchases, recoveredPurchaseExecutionId, selectedPending, type]);

  useEffect(() => {
    setPage(1);
    setPendingPage(1);
  }, [searchQuery]);

  useEffect(() => setPendingPage(1), [building]);

  useEffect(() => {
    setPendingPage((currentPage) => Math.min(currentPage, pendingTotalPages));
  }, [pendingTotalPages]);

  useEffect(() => {
    if (!highlightedExecutionId) return;
    const targetIndex = filteredPendingPurchases.findIndex(
      (item) => item.executionRecordId === highlightedExecutionId,
    );
    if (targetIndex < 0) return;
    setPendingPage(Math.floor(targetIndex / PENDING_PAGE_SIZE) + 1);
  }, [filteredPendingPurchases, highlightedExecutionId]);

  useEffect(() => {
    if (type !== 'inbound' || !normalizedPurchaseExecutionRecordId) {
      activePurchaseDeepLinkRef.current = '';
      handledPurchaseDeepLinkRef.current = '';
      setHighlightedExecutionId('');
      setPurchaseDeepLinkError('');
      return;
    }
    if (
      handledPurchaseDeepLinkRef.current === normalizedPurchaseExecutionRecordId
    ) {
      return;
    }

    handledPurchaseDeepLinkRef.current = normalizedPurchaseExecutionRecordId;
    void openPendingPurchaseDeepLink();
  }, [normalizedPurchaseExecutionRecordId, openPendingPurchaseDeepLink, type]);

  useEffect(() => {
    if (!highlightedExecutionId) return;
    const frame = window.requestAnimationFrame(() => {
      const matchingTarget = Array.from(
        pendingSectionRef.current?.querySelectorAll<HTMLElement>(
          '[data-purchase-execution-id]',
        ) || [],
      ).find(
        (element) =>
          element.dataset.purchaseExecutionId === highlightedExecutionId &&
          element.getClientRects().length > 0,
      );
      targetPurchaseRef.current = matchingTarget || null;
      targetPurchaseRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightedExecutionId, pendingPage]);

  const statusOptions = useMemo(
    () =>
      type === 'outbound'
        ? DEFAULT_STATUSES.outbound
        : Array.from(
            new Set([
              ...DEFAULT_STATUSES[type],
              ...response.summary.statusCounts.map((item) => item.status),
            ]),
          ),
    [response.summary.statusCounts, type],
  );

  const resetFilters = () => {
    setBuilding('all');
    setStatus('all');
    setPage(1);
    setPendingPage(1);
  };

  const openMovementCreateDialog = useCallback(() => {
    if (!canCreate) return;
    if (type === 'outbound' && visibleOutboundCreationTask) {
      toast.info('当前出库尚未取得任务编号，请等待服务端受理后再办理下一笔');
      return;
    }
    if (
      type === 'outbound' &&
      (legacyOutboundCreateBlocked || hasUnboundLegacyOutboundCreateRecovery())
    ) {
      toast.error(
        '检测到未绑定身份的旧版出库恢复记录，请联系管理员处理；本次不会发送出库请求。',
      );
      return;
    }
    if (type === 'outbound' && restoreSavedOutboundRecovery()) {
      toast.info('请先处理已恢复的出库操作，系统已保留原编号');
      return;
    }
    setCreateOpen(true);
  }, [
    canCreate,
    legacyOutboundCreateBlocked,
    restoreSavedOutboundRecovery,
    type,
    visibleOutboundCreationTask,
  ]);

  const abandonManualInboundRetry = useCallback(() => {
    const clientMutationId =
      manualRetryDraft?.clientMutationId?.trim() ||
      restoredRecoveryMutationIdRef.current;
    restoredRecoveryMutationIdRef.current = '';
    if (clientMutationId) clearInventoryInboundRecovery(clientMutationId);
    setManualRetryDraft((current) =>
      current ? { ...current, clientMutationId: undefined } : current,
    );
    setCreateOpen(true);
    toast.info('已放弃原入库编号；修改或重新提交时将使用新的编号。');
  }, [manualRetryDraft?.clientMutationId]);

  const abandonPurchaseInboundRetry = useCallback(() => {
    const clientMutationId =
      purchaseRetryDraft?.clientMutationId?.trim() ||
      restoredRecoveryMutationIdRef.current;
    restoredRecoveryMutationIdRef.current = '';
    dismissedInboundRecoveryMutationIdRef.current = '';
    if (clientMutationId) clearInventoryInboundRecovery(clientMutationId);
    setPurchaseRetryDraft((current) =>
      current ? { ...current, clientMutationId: undefined } : current,
    );
    setRecoveredPurchaseExecutionId('');
    toast.info('已放弃原入库编号；修改或重新提交时将使用新的编号。');
  }, [purchaseRetryDraft?.clientMutationId]);

  const handlePurchaseInboundOpenChange = useCallback((next: boolean) => {
    if (next) return;
    if (batchAdvancingRef.current) {
      batchAdvancingRef.current = false;
      return;
    }
    setBatchInboundQueue([]);
    setBatchInboundSubmissions([]);
    setBatchInboundIndex(-1);
    const recovery = readInventoryInboundRecovery<InboundRecoveryDraft>();
    dismissedInboundRecoveryMutationIdRef.current =
      recovery?.clientMutationId || restoredRecoveryMutationIdRef.current;
    setRecoveredPurchaseExecutionId('');
    setSelectedPending(null);
  }, []);

  const reconnectLegacyOutboundCreation =
    useCallback(async (): Promise<void> => {
      if (legacyOutboundReconnectPendingRef.current) return;
      const namespace =
        getInventoryOutboundCreationTaskStorageKey(principalFingerprint);
      const runtime = outboundCreationRuntimeRef.current;
      if (
        !namespace ||
        !principalFingerprint ||
        !runtime ||
        outboundPrincipalNamespaceRef.current !== namespace ||
        visibleOutboundCreationTask ||
        runtime.hasPendingAcceptance()
      ) {
        toast.error('当前状态无法安全重新连接旧版出库任务，本次未发送请求。');
        return;
      }

      const legacyRecovery = readInventoryOutboundRecovery<
        InventoryOutboundDraftSnapshot,
        InventoryOutboundMovementItem
      >();
      if (
        !legacyRecovery ||
        legacyRecovery.kind !== 'create' ||
        legacyRecovery.status !== 'unknown' ||
        !isInventoryOutboundDraftSnapshot(legacyRecovery.draft)
      ) {
        setLegacyOutboundCreateBlocked(false);
        setLegacyOutboundReconnectError(
          '旧版出库恢复记录已不存在或无法安全读取。',
        );
        return;
      }

      let legacySubmission: InventoryOutboundSubmission;
      try {
        legacySubmission = buildInventoryOutboundSubmission({
          draft: legacyRecovery.draft,
          clientMutationId: legacyRecovery.clientMutationId,
          startedAt: legacyRecovery.updatedAt,
        });
      } catch (legacyError) {
        setLegacyOutboundCreateBlocked(true);
        setLegacyOutboundReconnectError(
          errorMessage(
            legacyError,
            '旧版出库恢复记录不完整，请联系管理员处理。',
          ),
        );
        return;
      }

      legacyOutboundReconnectPendingRef.current = true;
      setLegacyOutboundReconnectPending(true);
      setLegacyOutboundReconnectError('');
      try {
        const migrated = await migrateLegacyInventoryOutboundCreateRecovery(
          principalFingerprint,
          legacySubmission.request,
          Date.now(),
        );
        if (
          outboundPrincipalNamespaceRef.current !== namespace ||
          outboundCreationRuntimeRef.current !== runtime
        ) {
          return;
        }
        if (!migrated) {
          setLegacyOutboundCreateBlocked(true);
          setLegacyOutboundReconnectError(
            '旧版出库任务迁移失败，原记录已保留且未发送网络请求，请重试或联系管理员。',
          );
          return;
        }

        const savedTask = (
          await readInventoryOutboundCreationTasks(principalFingerprint)
        ).find(
          (task) => task.clientMutationId === legacyRecovery.clientMutationId,
        );
        if (
          outboundPrincipalNamespaceRef.current !== namespace ||
          outboundCreationRuntimeRef.current !== runtime
        ) {
          return;
        }
        if (
          !savedTask ||
          savedTask.clientMutationId !== legacyRecovery.clientMutationId
        ) {
          setLegacyOutboundCreateBlocked(true);
          setLegacyOutboundReconnectError(
            '旧版出库任务已迁移，但本地任务日志暂时无法安全读取，请保留页面并联系管理员。',
          );
          return;
        }

        upsertOutboundCreationTask(savedTask);
        setOutboundCreationTaskStatus(
          savedTask.clientMutationId,
          '正在重新连接旧版原任务。',
        );
        const resumed = await runtime.resume(savedTask);
        if (
          outboundPrincipalNamespaceRef.current !== namespace ||
          outboundCreationRuntimeRef.current !== runtime
        ) {
          return;
        }
        if (!resumed) {
          upsertOutboundCreationTask(savedTask);
          setOutboundCreationTaskStatus(
            savedTask.clientMutationId,
            '旧版任务已迁移，但自动核对尚未启动；请点击立即查询。',
          );
          return;
        }
        setLegacyOutboundCreateBlocked(false);
        setLegacyOutboundReconnectError('');
      } finally {
        legacyOutboundReconnectPendingRef.current = false;
        if (mountedRef.current) setLegacyOutboundReconnectPending(false);
      }
    }, [
      principalFingerprint,
      setOutboundCreationTaskStatus,
      upsertOutboundCreationTask,
      visibleOutboundCreationTask,
    ]);

  const sendInventoryBatch = useCallback(async (journal: InventoryBatchJournal) => {
    if (journal.principalFingerprint !== principalRequestPrincipalRef.current) return;
    if (!canUseInventoryAction(currentPrincipalRef.current, journal.kind === 'purchase' ? 'confirm' : 'create')) {
      setBatchErrors(current => ({ ...current, [journal.kind]: '当前权限不能重新提交此批任务，可继续查询已受理结果' }));
      return;
    }
    if (batchSendingRef.current.has(journal.kind)) return;
    batchSendingRef.current.add(journal.kind);
    try {
      const response: InventoryBatchAcceptanceResponse = journal.kind === 'purchase'
        ? await confirmPurchaseInboundsBatch(journal.requests as PurchaseInboundSubmission['request'][])
        : await submitInventoryOutboundsBatch(journal.requests as InventoryOutboundSubmission['request'][]);
      const updated = applyInventoryBatchAcceptance(journal, response);
      saveInventoryBatchJournal(updated);
      if (!mountedRef.current || principalRequestPrincipalRef.current !== journal.principalFingerprint) return;
      setBatchJournals((current) => ({ ...current, [journal.kind]: updated }));
      setBatchErrors((current) => ({ ...current, [journal.kind]: '' }));
      const accepted = updated.entries.filter((entry) => entry.status === 'accepted').length;
      const rejected = updated.entries.length - accepted;
      if (rejected) toast.warning(`${accepted} 项已受理，${rejected} 项未受理，请查看逐项结果`);
      else toast.success(`${accepted} 项已受理，正在后台同步`);
      if (journal.kind === 'outbound') void loadMovementsRef.current?.(true);
      else void loadPendingPurchases(true);
    } catch (error) {
      if (!mountedRef.current || principalRequestPrincipalRef.current !== journal.principalFingerprint) return;
      const message = errorMessage(error, '批量受理结果未确认，请用原编号重新核对');
      setBatchErrors((current) => ({ ...current, [journal.kind]: message }));
      toast.error(message);
    } finally {
      batchSendingRef.current.delete(journal.kind);
    }
  }, [loadPendingPurchases, canConfirm, canCreate]);

  const startInventoryBatch = useCallback((
    kind: InventoryBatchKind,
    requests: InventoryBatchJournal['requests'],
    labels: string[],
  ): boolean => {
    if (kind === 'purchase' ? !canConfirm : !canCreate) return false;
    if (!principalFingerprint) {
      toast.error('登录身份未就绪，本次未发送');
      return false;
    }
    try {
      const existing = readInventoryBatchJournal(principalFingerprint, kind);
      if (existing?.entries.some((entry) =>
        entry.status === 'submitting' || entry.status === 'accepted' || entry.status === 'uncertain'
      )) {
        toast.info('请先等待或核对上一批任务完成');
        return false;
      }
      const journal = createInventoryBatchJournal(kind, principalFingerprint, requests, labels);
      saveInventoryBatchJournal(journal);
      setBatchJournals((current) => ({ ...current, [kind]: journal }));
      setBatchErrors((current) => ({ ...current, [kind]: '' }));
      void sendInventoryBatch(journal);
      return true;
    } catch (error) {
      toast.error(errorMessage(error, '批量任务无法安全保存，本次未发送'));
      return false;
    }
  }, [principalFingerprint, sendInventoryBatch, canConfirm, canCreate]);

  const reconcileInventoryBatch = useCallback(async (journal: InventoryBatchJournal) => {
    if (batchPollingRef.current.has(journal.kind)) return;
    batchPollingRef.current.add(journal.kind);
    let updated = journal;
    let queryError = '';
    try {
      for (const entry of journal.entries) {
        if ((entry.status !== 'accepted' && entry.status !== 'uncertain') || !entry.taskId) continue;
        const request = journal.requests.find((candidate) => candidate.clientMutationId === entry.clientMutationId);
        if (!request) continue;
        try {
          const response = journal.kind === 'purchase'
            ? await getInventoryInboundTaskStatus(entry.taskId)
            : await getInventoryOutboundTaskStatus(entry.taskId, request.building);
          const task = response.task;
          if (task.id !== entry.taskId) throw new Error('任务号不一致');
          const status = task.status === 'completed' ? 'completed'
            : task.status === 'failed' ? 'failed'
              : task.status === 'uncertain' ? 'uncertain' : 'accepted';
          updated = updateInventoryBatchTask(updated, entry.clientMutationId, status, task.message);
        } catch (error) {
          queryError = errorMessage(error, '任务查询失败，稍后自动重试');
        }
      }
      if (mountedRef.current && principalRequestPrincipalRef.current === journal.principalFingerprint) setBatchErrors((current) =>
        current[journal.kind] === queryError ? current : { ...current, [journal.kind]: queryError },
      );
      if (updated !== journal) {
        saveInventoryBatchJournal(updated);
        if (mountedRef.current && principalRequestPrincipalRef.current === journal.principalFingerprint) {
          setBatchJournals((current) => ({ ...current, [journal.kind]: updated }));
          if (updated.entries.some((entry, index) =>
            entry.status === 'completed' && journal.entries[index]?.status !== 'completed'
          )) {
            if (journal.kind === 'outbound') void loadMovementsRef.current?.(true);
            else void loadPendingPurchases(true);
          }
        }
      }
    } catch (error) {
      if (mountedRef.current && principalRequestPrincipalRef.current === journal.principalFingerprint) {
        setBatchErrors((current) => ({
          ...current,
          [journal.kind]: errorMessage(error, '批量任务状态无法安全保存，请保留原编号重试'),
        }));
      }
    } finally {
      batchPollingRef.current.delete(journal.kind);
    }
  }, [loadPendingPurchases]);

  useEffect(() => {
    const journal = batchJournals[type === 'outbound' ? 'outbound' : 'purchase'];
    if (!journal?.entries.some((entry) => entry.status === 'accepted' || entry.status === 'uncertain')) return;
    void reconcileInventoryBatch(journal);
    const timer = window.setInterval(() => void reconcileInventoryBatch(journal), 5_000);
    return () => window.clearInterval(timer);
  }, [batchJournals, reconcileInventoryBatch, type]);

  const submitOutboundBatch = useCallback((submissions: InventoryOutboundSubmission[]): boolean =>
    submissions.every(submission => canActOnRecord('create', { building: submission.draft.building, specialty: submission.draft.selectedItem?.specialty })) && startInventoryBatch(
      'outbound',
      submissions.map((submission) => submission.request),
      submissions.map((submission) => `${submission.optimisticMovement.name} · ${submission.request.quantity} ${submission.optimisticMovement.unit}`),
    ), [startInventoryBatch, canActOnRecord]);

  useEffect(() => {
    if (!principalFingerprint) return;
    if (restoredBatchPrincipalRef.current === principalFingerprint) return;
    restoredBatchPrincipalRef.current = principalFingerprint;
    setBatchJournals({});
    setBatchErrors({});
    for (const kind of ['purchase', 'outbound'] as const) {
      try {
        const journal = readInventoryBatchJournal(principalFingerprint, kind);
        if (!journal) continue;
        setBatchJournals((current) => ({ ...current, [kind]: journal }));
        if (journal.entries.some((entry) => entry.status === 'submitting')) {
          void sendInventoryBatch(journal);
        }
      } catch (error) {
        setBatchErrors((current) => ({ ...current, [kind]: errorMessage(error, '批量任务记录无法读取') }));
      }
    }
  }, [principalFingerprint, sendInventoryBatch]);

  const submitOutbound = useCallback(
    async (submission: InventoryOutboundSubmission): Promise<boolean> => {
      if (!canCreate || !canActOnRecord('create', { building: submission.draft.building, specialty: submission.draft.selectedItem?.specialty })) return false;
      const namespace =
        getInventoryOutboundCreationTaskStorageKey(principalFingerprint);
      const runtime = outboundCreationRuntimeRef.current;
      if (
        !namespace ||
        !principalFingerprint ||
        !runtime ||
        outboundPrincipalNamespaceRef.current !== namespace
      ) {
        toast.error('当前登录身份无法安全标识，本次未发送出库请求。');
        return false;
      }
      if (visibleOutboundCreationTask || runtime.hasPendingAcceptance()) {
        toast.info('当前出库尚未取得任务编号，请等待服务端受理后再办理下一笔');
        return false;
      }
      if (
        legacyOutboundCreateBlocked ||
        hasUnboundLegacyOutboundCreateRecovery()
      ) {
        setLegacyOutboundCreateBlocked(true);
        toast.error('请先显式重新连接旧版原任务；确认前本次不会发送出库请求。');
        return false;
      }
      if (outboundCreationStorageBlocked) {
        toast.error(
          '本地出库任务日志异常或暂时不可读取，本次未发送出库请求；请保留原记录并刷新页面重试。',
        );
        return false;
      }

      const failedReceipt = pendingFailedReceiptConsumptionRef.current;
      let input: InventoryOutboundCreationTaskInput;
      try {
        const taskInput = outboundSubmissionToCreationTask(submission);
        input = failedReceipt
          ? {
              ...taskInput,
              recoveredFromFailedReceipt:
                getInventoryOutboundCreationFailedReceiptIdentity(
                  failedReceipt,
                ),
            }
          : taskInput;
      } catch (submissionError) {
        toast.error(
          errorMessage(submissionError, '出库草稿不完整，本次未发送请求。'),
        );
        return false;
      }
      const started = await runtime.start(input);
      if (!started) {
        if (
          outboundPrincipalNamespaceRef.current !== namespace ||
          outboundCreationRuntimeRef.current !== runtime
        ) {
          return false;
        }
        const savedTasks =
          await readInventoryOutboundCreationTasks(principalFingerprint);
        for (const savedTask of savedTasks) {
          upsertOutboundCreationTask(savedTask);
        }
        toast.error('出库任务未能安全保存，本次未发送请求；请保留当前页面后重试。');
        return false;
      }
      if (pendingFailedReceiptConsumptionRef.current === failedReceipt) {
        pendingFailedReceiptConsumptionRef.current = null;
      }
      if (failedReceipt) {
        void (async () => {
          const nextRecovery =
            await readUnconsumedInventoryOutboundCreationFailedReceipt(
              principalFingerprint,
            );
          if (
            outboundPrincipalNamespaceRef.current === namespace &&
            outboundCreationRuntimeRef.current === runtime &&
            nextRecovery.kind === 'failed-recovery' &&
            nextRecovery.receipt.clientMutationId !==
              failedReceipt.clientMutationId
          ) {
            queueOutboundFailedReceipt(nextRecovery.receipt);
          }
        })();
      }
      return true;
    },
    [
      canCreate,
      canActOnRecord,
      legacyOutboundCreateBlocked,
      outboundCreationStorageBlocked,
      principalFingerprint,
      queueOutboundFailedReceipt,
      upsertOutboundCreationTask,
      visibleOutboundCreationTask,
    ],
  );

  const openOutboundConfirmation = useCallback(
    (item: InventoryOutboundMovementItem) => {
      if (
        !canActOnRecord('confirm', item) ||
        !canConfirmInventoryOutboundForBuilding(
          canConfirmOutbound,
          item.building,
          outboundConfirmationBuilding,
        ) ||
        item.status !== '待库房确认'
      ) {
        return;
      }
      const recovery = restoreSavedOutboundRecovery();
      if (recovery) {
        toast.info('请先处理已恢复的出库操作，系统已保留原编号');
        return;
      }
      setOutboundConfirmRetryMutationId('');
      setSelectedOutbound(item);
    },
    [
      canConfirmOutbound,
      canActOnRecord,
      outboundConfirmationBuilding,
      restoreSavedOutboundRecovery,
    ],
  );

  const submitOutboundConfirmation = useCallback(
    (item: InventoryOutboundMovementItem) => {
      if (
        !canActOnRecord('confirm', item) ||
        !canConfirmInventoryOutboundForBuilding(
          canConfirmOutbound,
          item.building,
          outboundConfirmationBuilding,
        )
      ) {
        return;
      }
      const clientMutationId =
        outboundConfirmRetryMutationId ||
        createClientMutationId('outbound-confirm');
      let submission: InventoryOutboundConfirmationSubmission;
      try {
        submission = buildInventoryOutboundConfirmationSubmission(
          item,
          clientMutationId,
          Date.now(),
        );
      } catch (error) {
        toast.error(errorMessage(error, '该出库单据当前不可确认'));
        return;
      }
      if (activeOutboundMutationIdsRef.current.has(clientMutationId)) return;
      activeOutboundMutationIdsRef.current.add(clientMutationId);
      const recoveryClaimed = saveInventoryOutboundRecovery({
        kind: 'confirm',
        status: 'unknown',
        clientMutationId,
        recordId: submission.recordId,
        draft: submission.draft,
        itemSnapshot: item,
        updatedAt: submission.startedAt,
      });
      if (!recoveryClaimed) {
        activeOutboundMutationIdsRef.current.delete(clientMutationId);
        restoreSavedOutboundRecovery();
        toast.info('请先处理已恢复的出库操作，系统不会覆盖原编号');
        return;
      }
      restoredOutboundRecoveryRef.current = null;

      setConfirmingOutboundRecordId(item.recordId);
      setInboundState((current) => beginMutation(current, submission));
      setSelectedOutbound(null);

      void (async () => {
        let responseReceived = false;
        try {
          const result = await confirmInventoryOutbound(
            submission.recordId,
            submission.request,
          );
          responseReceived = true;
          const movement = requireCanonicalOutboundMovement(result.movement, {
            recordId: submission.recordId,
            status: '已出库',
            sku: item.sku,
            building: item.building,
            quantity: item.quantity,
          });
          if (
            result.success !== true ||
            result.recordId !== submission.recordId ||
            movement.recordId !== submission.recordId
          ) {
            throw new Error('后端返回的出库确认结果与本次操作不一致');
          }

          clearInventoryOutboundRecovery(clientMutationId);
          if (!mountedRef.current) return;
          setInboundState((current) =>
            confirmMutation(
              current,
              clientMutationId,
              movement,
              movementRequestRef.current,
            ),
          );
          setOutboundConfirmRetryMutationId('');
          toast.success(result.message);
        } catch (submissionError) {
          const outcome = classifyInventoryInboundFailure(
            submissionError,
            responseReceived,
          );
          const resolution =
            resolveInventoryOutboundConfirmationFailure(outcome);
          if (resolution.retainRecovery) {
            saveInventoryOutboundRecovery({
              kind: 'confirm',
              status: 'unknown',
              clientMutationId,
              recordId: submission.recordId,
              draft: submission.draft,
              itemSnapshot: item,
              updatedAt: Date.now(),
            });
          } else {
            clearInventoryOutboundRecovery(clientMutationId);
          }
          if (!mountedRef.current) return;
          setInboundState((current) =>
            failMutation(current, clientMutationId, submissionError),
          );
          setOutboundConfirmRetryMutationId(
            resolution.retryLocked ? clientMutationId : '',
          );
          setSelectedOutbound(resolution.keepDialogOpen ? item : null);
          if (resolution.refreshAuthority) void loadMovements(true);
          toast.error(
            outcome === 'unknown'
              ? '网络中断或响应未确认，结果暂不确定；请使用原编号安全重试。'
              : errorMessage(
                  submissionError,
                  '库房确认被后端拒绝，单据状态已恢复。',
                ),
          );
        }
      })().finally(() => {
        activeOutboundMutationIdsRef.current.delete(clientMutationId);
        if (!mountedRef.current) return;
        setConfirmingOutboundRecordId((current) =>
          current === item.recordId ? '' : current,
        );
      });
    },
    [
      canConfirmOutbound,
      loadMovements,
      canActOnRecord,
      outboundConfirmationBuilding,
      outboundConfirmRetryMutationId,
      restoreSavedOutboundRecovery,
    ],
  );

  const abandonOutboundConfirmationRetry = useCallback(() => {
    const clientMutationId = outboundConfirmRetryMutationId.trim();
    restoredOutboundRecoveryRef.current = null;
    if (clientMutationId) clearInventoryOutboundRecovery(clientMutationId);
    setOutboundConfirmRetryMutationId('');
    setSelectedOutbound(null);
    void loadMovements(true);
    toast.info('已放弃原确认编号并刷新单据状态；请按最新状态继续处理。');
  }, [loadMovements, outboundConfirmRetryMutationId]);

  const submitManualInbound = useCallback(
    (submission: InventoryInboundSubmission): boolean => {
      if (!canCreate || !canActOnRecord('create', { building: submission.draft.building, specialty: submission.draft.mode === 'new' ? submission.draft.newItem.specialty : submission.draft.selectedItem?.specialty })) return false;
      if (
        activeInboundMutationIdsRef.current.has(submission.clientMutationId)
      ) {
        toast.info('该入库正在后台同步，请勿重复提交；请稍后查询进度。');
        return false;
      }
      activeInboundMutationIdsRef.current.add(submission.clientMutationId);
      const recoveryClaimed = saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'pending',
        retryMode: 'locked',
        clientMutationId: submission.clientMutationId,
        draft: submission.draft,
      });
      if (!recoveryClaimed) {
        activeInboundMutationIdsRef.current.delete(submission.clientMutationId);
        const occupiedRecovery = restoreSavedInboundRecovery();
        if (occupiedRecovery) {
          toast.info('请先完成已恢复的入库草稿，系统不会覆盖原入库编号');
        } else {
          toast.error(
            '入库草稿未能安全保存，本次未发送请求；请保留当前页面后重试。',
          );
        }
        return false;
      }
      setPage(1);
      setInboundState((current) => beginMutation(current, submission));
      setManualRetryDraft(undefined);
      setCreateOpen(false);

      let resumeAcceptedTask = false;
      void (async () => {
        let result: Awaited<
          ReturnType<typeof waitForManualInventoryInboundTask>
        >;
        let movement: InventoryMovementItem;
        let responseReceived = false;
        let acceptedTask = false;
        try {
          const response = await createInventoryMovement(submission.request);
          responseReceived = true;
          if ('accepted' in response) {
            acceptedTask = true;
            acceptInventoryInboundRecovery({
              clientMutationId: submission.clientMutationId,
              taskId: response.taskId,
              kind: 'manual',
              request: submission.request,
            });
            if (mountedRef.current) {
              toast.info(
                response.message || '入库已受理，正在后台同步，可安全离开。',
              );
            }
            result = await waitForManualInventoryInboundTask(response);
          } else {
            result = response;
          }
          if (isInventoryInboundTaskDeferred(result)) {
            resumeAcceptedTask = true;
            if (mountedRef.current) {
              toast.info(
                result.message || '入库仍在后台同步，稍后可继续查询。',
              );
            }
            return;
          }
          movement = requireCanonicalInboundMovement(result.movement, {
            clientMutationId: submission.clientMutationId,
            building: submission.request.building,
            quantity: submission.request.quantity,
            occurredAt: submission.request.occurredAt,
            name: submission.optimisticMovement.name,
            specification: submission.optimisticMovement.specification,
            location: submission.optimisticMovement.location,
            ...(submission.request.mode === 'existing'
              ? { sku: submission.request.sku }
              : {}),
          });
          if (
            result.success !== true ||
            result.type !== 'inbound' ||
            result.recordId !== movement.recordId
          ) {
            throw new Error('后端返回的入库记录与本次请求不一致');
          }
        } catch (submissionError) {
          const outcome = classifyInventoryInboundFailure(
            submissionError,
            responseReceived,
          );
          if (acceptedTask && outcome === 'unknown') {
            resumeAcceptedTask = true;
            if (!mountedRef.current) return;
            setInboundState((current) =>
              failMutation(
                current,
                submission.clientMutationId,
                submissionError,
              ),
            );
            toast.error(
              '后台任务查询暂时中断，任务号已保留；系统会自动继续查询，不会重复入库。',
            );
            return;
          }
          if (acceptedTask) {
            finalizeInventoryInboundRecovery(
              submission.clientMutationId,
              'failed',
            );
          }
          const retryDraft: InventoryInboundDraft = {
            ...submission.draft,
            clientMutationId:
              outcome === 'unknown' ? submission.clientMutationId : undefined,
          };
          saveInventoryInboundRecovery({
            kind: 'manual',
            status: 'failed',
            retryMode: outcome === 'unknown' ? 'locked' : 'editable',
            clientMutationId: submission.clientMutationId,
            draft: retryDraft,
          });
          if (!mountedRef.current) return;
          setInboundState((current) =>
            failMutation(current, submission.clientMutationId, submissionError),
          );
          setManualRetryDraft(retryDraft);
          setCreateOpen(true);
          toast.error(
            outcome === 'unknown'
              ? '网络中断或响应未确认，结果暂不确定；请使用原编号安全重试，或放弃原编号后编辑。'
              : errorMessage(
                  submissionError,
                  '入库被后端拒绝，已恢复可编辑草稿；修改后将使用新编号。',
                ),
          );
          return;
        }

        if (acceptedTask) {
          finalizeInventoryInboundRecovery(
            submission.clientMutationId,
            'completed',
          );
        } else {
          clearInventoryInboundRecovery(submission.clientMutationId);
        }
        if (!mountedRef.current) return;
        setInboundState((current) =>
          confirmMutation(
            current,
            submission.clientMutationId,
            movement,
            movementRequestRef.current,
          ),
        );
        toast.success(result.message);
      })().finally(() => {
        activeInboundMutationIdsRef.current.delete(submission.clientMutationId);
        if (resumeAcceptedTask && mountedRef.current) {
          requestAcceptedInboundRecoveryCheck();
        }
      });
      return true;
    },
    [requestAcceptedInboundRecoveryCheck, restoreSavedInboundRecovery, canCreate, canActOnRecord],
  );

  const submitPurchaseInbound = useCallback(
    (submission: PurchaseInboundSubmission): boolean => {
      if (!canConfirm) return false;
      if (
        activeInboundMutationIdsRef.current.has(submission.clientMutationId)
      ) {
        toast.info(
          '该采购入库正在后台同步，请勿重复提交；可在待办清单查询进度。',
        );
        return false;
      }

      const retryItem =
        selectedPending?.executionRecordId ===
        submission.purchaseExecutionRecordId
          ? selectedPending
          : pendingPurchases.find(
              (item) =>
                item.executionRecordId === submission.purchaseExecutionRecordId,
            );
      if (!retryItem) {
        toast.error('采购待办上下文已失效，请刷新后重试');
        return false;
      }
      if (!canActOnRecord('confirm', retryItem)) return false;
      const purchaseRecoveryDraft = createPurchaseInboundRecoveryDraft(
        submission.draft,
        retryItem,
      );
      activeInboundMutationIdsRef.current.add(submission.clientMutationId);
      const recoveryClaimed = saveInventoryInboundRecovery({
        kind: 'purchase',
        status: 'pending',
        retryMode: 'locked',
        clientMutationId: submission.clientMutationId,
        draft: purchaseRecoveryDraft,
        purchaseExecutionRecordId: submission.purchaseExecutionRecordId,
      });
      if (!recoveryClaimed) {
        activeInboundMutationIdsRef.current.delete(submission.clientMutationId);
        const occupiedRecovery = restoreSavedInboundRecovery();
        if (occupiedRecovery) {
          toast.info('请先完成已恢复的入库草稿，系统不会覆盖原入库编号');
        } else {
          toast.error(
            '入库草稿未能安全保存，本次未发送请求；请保留当前页面后重试。',
          );
        }
        return false;
      }
      setPage(1);
      setConfirmingExecutionId(submission.purchaseExecutionRecordId);
      setInboundState((current) => beginMutation(current, submission));
      setPurchaseRetryDraft(undefined);
      setSelectedPending(null);

      let resumeAcceptedTask = false;
      void (async () => {
        let result: Awaited<
          ReturnType<typeof waitForPurchaseInventoryInboundTask>
        >;
        let movement: InventoryMovementItem;
        let responseReceived = false;
        let acceptedTask = false;
        try {
          const response = await confirmPurchaseInbound(submission.request);
          responseReceived = true;
          if ('accepted' in response) {
            acceptedTask = true;
            acceptInventoryInboundRecovery({
              clientMutationId: submission.clientMutationId,
              taskId: response.taskId,
              kind: 'purchase',
              request: submission.request,
            });
            if (mountedRef.current) {
              setConfirmingExecutionId((current) =>
                current === submission.purchaseExecutionRecordId ? '' : current,
              );
              toast.info(
                response.message ||
                  '采购入库已受理，正在后台同步，可安全离开。',
              );
            }
            result = await waitForPurchaseInventoryInboundTask(response);
          } else {
            result = response;
          }
          if (isInventoryInboundTaskDeferred(result)) {
            resumeAcceptedTask = true;
            if (mountedRef.current) {
              toast.info(
                result.message || '采购入库仍在后台同步，稍后可继续查询。',
              );
            }
            return;
          }
          movement = requireCanonicalInboundMovement(result.movement, {
            clientMutationId: submission.clientMutationId,
            building: submission.request.building,
            quantity: submission.request.quantity,
            occurredAt: submission.request.occurredAt,
            name: submission.optimisticMovement.name,
            specification: submission.optimisticMovement.specification,
            location: submission.optimisticMovement.location,
            sku:
              submission.request.mode === 'existing'
                ? submission.request.sku
                : submission.request.generatedSku,
          });
          const expectedCatalogRecordId =
            submission.request.mode === 'existing'
              ? submission.request.catalogRecordId
              : submission.request.preparedCatalogRecordId;
          if (
            result.success !== true ||
            result.executionRecordId !== submission.purchaseExecutionRecordId ||
            result.inboundRecordId !== movement.recordId ||
            result.catalogRecordId !== expectedCatalogRecordId
          ) {
            throw new Error('后端返回的采购入库记录与本次请求不一致');
          }
        } catch (submissionError) {
          const outcome = classifyInventoryInboundFailure(
            submissionError,
            responseReceived,
          );
          if (acceptedTask && outcome === 'unknown') {
            resumeAcceptedTask = true;
            if (!mountedRef.current) return;
            setInboundState((current) =>
              failMutation(
                current,
                submission.clientMutationId,
                submissionError,
              ),
            );
            toast.error(
              '采购入库后台任务查询暂时中断，任务号已保留；系统会自动继续查询，不会重复入库。',
            );
            return;
          }
          if (acceptedTask) {
            finalizeInventoryInboundRecovery(
              submission.clientMutationId,
              'failed',
            );
          }
          const retryDraft: PurchaseInboundDraft = {
            ...submission.draft,
            clientMutationId:
              outcome === 'unknown' ? submission.clientMutationId : undefined,
          };
          const editableRecoveryDraft = createPurchaseInboundRecoveryDraft(
            retryDraft,
            retryItem,
          );
          saveInventoryInboundRecovery({
            kind: 'purchase',
            status: 'failed',
            retryMode: outcome === 'unknown' ? 'locked' : 'editable',
            clientMutationId: submission.clientMutationId,
            draft: editableRecoveryDraft,
            purchaseExecutionRecordId: submission.purchaseExecutionRecordId,
          });
          if (!mountedRef.current) return;
          setInboundState((current) =>
            failMutation(current, submission.clientMutationId, submissionError),
          );
          setPurchaseRetryDraft(retryDraft);
          if (retryItem) setSelectedPending(retryItem);
          toast.error(
            outcome === 'unknown'
              ? '网络中断或响应未确认，结果暂不确定；请使用原编号安全重试，或放弃原编号后编辑。'
              : errorMessage(
                  submissionError,
                  '采购入库被后端拒绝，已恢复可编辑草稿；修改后将使用新编号。',
                ),
          );
          return;
        }

        if (acceptedTask) {
          finalizeInventoryInboundRecovery(
            submission.clientMutationId,
            'completed',
          );
        } else {
          clearInventoryInboundRecovery(submission.clientMutationId);
        }
        if (!mountedRef.current) return;
        setInboundState((current) =>
          confirmMutation(
            current,
            submission.clientMutationId,
            movement,
            movementRequestRef.current,
          ),
        );
        toast.success(result.message);
        const notificationWarnings = Array.isArray(
          (result as { notificationWarnings?: unknown }).notificationWarnings,
        )
          ? result.notificationWarnings.filter(
              (warning): warning is string => typeof warning === 'string',
            )
          : [];
        notificationWarnings.forEach((warning) => toast.warning(warning));
      })().finally(() => {
        activeInboundMutationIdsRef.current.delete(submission.clientMutationId);
        if (!mountedRef.current) return;
        if (resumeAcceptedTask) requestAcceptedInboundRecoveryCheck();
        setConfirmingExecutionId((current) =>
          current === submission.purchaseExecutionRecordId ? '' : current,
        );
      });
      return true;
    },
    [canConfirm, canActOnRecord,
      pendingPurchases,
      requestAcceptedInboundRecoveryCheck,
      restoreSavedInboundRecovery,
      selectedPending,
    ],
  );

  const handlePurchaseCategoryPrepared = useCallback(
    (
      executionRecordId: string,
      preparedCategory: PurchaseInboundPreparedCategory,
    ) => {
      setInboundState((current) => ({
        ...current,
        basePendingPurchases: current.basePendingPurchases.map((item) =>
          item.executionRecordId === executionRecordId
            ? {
                ...item,
                preparedCategory: clonePreparedCategory(preparedCategory),
                actionReason: `新物品类别号 ${preparedCategory.sku} 已生成，可确认入库`,
              }
            : item,
        ),
      }));
      setSelectedPending((current) =>
        current?.executionRecordId === executionRecordId
          ? {
              ...current,
              preparedCategory: clonePreparedCategory(preparedCategory),
              actionReason: `新物品类别号 ${preparedCategory.sku} 已生成，可确认入库`,
            }
          : current,
      );
    },
    [],
  );

  const handlePendingPurchaseAction = (item: PurchasePendingInboundItem) => {
    if (!canActOnRecord('confirm', item)) return;
    const recovery = readInventoryInboundRecovery<InboundRecoveryDraft>();
    if (recovery && recovery.status === 'accepted') {
      void queryAcceptedPurchaseInboundRecovery(recovery);
      return;
    }
    if (recovery && recovery.status !== 'accepted') {
      dismissedInboundRecoveryMutationIdRef.current = '';
      applyInboundRecovery(recovery);
      toast.info('请先完成已恢复的入库草稿，系统已保留原入库编号');
      return;
    }
    setPurchaseRetryDraft((current) =>
      current?.executionRecordId === item.executionRecordId
        ? current
        : undefined,
    );
    setSelectedPending(item);
  };

  const beginPurchaseBatch = () => {
    if (!canConfirm) return;
    const items = pendingPurchases.filter((item) => selectedPendingIds.has(item.executionRecordId));
    if (items.some(item => !canActOnRecord('confirm', item))) { toast.error('当前权限不能确认所选条目'); return; }
    if (items.length < 2) {
      toast.info('请至少选择两项待入库物品');
      return;
    }
    if (items.length > 50) {
      toast.info('每批最多选择 50 项，请分批办理');
      return;
    }
    if (!principalFingerprint) {
      toast.error('登录身份未就绪，本次未办理');
      return;
    }
    try {
      const existing = readInventoryBatchJournal(principalFingerprint, 'purchase');
      if (existing?.entries.some((entry) =>
        entry.status === 'submitting' || entry.status === 'accepted' || entry.status === 'uncertain'
      )) {
        toast.info('请先等待或核对上一批入库任务完成');
        return;
      }
    } catch (error) {
      toast.error(errorMessage(error, '批量任务记录无法读取'));
      return;
    }
    const recovery = readInventoryInboundRecovery<InboundRecoveryDraft>();
    if (recovery) {
      toast.info('请先处理已恢复的入库任务，再办理批量入库');
      return;
    }
    setBatchInboundQueue(items);
    setBatchInboundSubmissions([]);
    setBatchInboundIndex(0);
    setPurchaseRetryDraft(undefined);
    setSelectedPending(items[0]);
  };

  const stagePurchaseBatch = (submission: PurchaseInboundSubmission): boolean => {
    const candidate = batchInboundQueue.find(item => item.executionRecordId === submission.purchaseExecutionRecordId);
    if (!candidate || !canActOnRecord('confirm', candidate)) return false;
    const next = [...batchInboundSubmissions, submission];
    const following = batchInboundQueue[batchInboundIndex + 1];
    if (following) {
      setBatchInboundSubmissions(next);
      setBatchInboundIndex(batchInboundIndex + 1);
      batchAdvancingRef.current = true;
      setSelectedPending(following);
      return true;
    }
    const started = startInventoryBatch(
      'purchase',
      next.map((entry) => entry.request),
      next.map((entry) => `${entry.optimisticMovement.name} · ${entry.request.quantity} ${entry.optimisticMovement.unit}`),
    );
    if (!started) return false;
    setBatchInboundQueue([]);
    setBatchInboundSubmissions([]);
    setBatchInboundIndex(-1);
    setSelectedPendingIds(new Set());
    return true;
  };

  const canDeleteMovement = useCallback(
    (item: InventoryMovementItem): boolean =>
      canDeleteMovements && canActOnRecord('delete', item) &&
      (item.type === 'inbound' || item.type === 'outbound') &&
      item.pendingSync !== true &&
      !item.recordId.startsWith('pending:') &&
      (movementDeletionBuilding === null ||
        item.building === movementDeletionBuilding),
    [canDeleteMovements, movementDeletionBuilding, canActOnRecord],
  );

  const openMovementDeletion = useCallback(
    (item: InventoryMovementItem) => {
      if (!canDeleteMovement(item)) {
        if (item.pendingSync || item.recordId.startsWith('pending:')) {
          toast.info('后台尚未确认的记录不能删除');
        } else {
          toast.error('当前账号无权删除该楼栋的出入库记录');
        }
        return;
      }
      setSelectedMovementForDeletion(item);
    },
    [canDeleteMovement],
  );

  const confirmMovementDeletion = useCallback(() => {
    const item = selectedMovementForDeletion;
    const coordinator = movementDeletionCoordinatorRef.current;
    if (!item || !coordinator || !canDeleteMovement(item)) return;
    const started = coordinator.start({
      clientMutationId: createClientMutationId('inventory-movement-delete'),
      movement: item,
      originalIndex: response.items.findIndex(
        (candidate) => candidate.recordId === item.recordId,
      ),
      requestWatermark: movementRequestRef.current,
    });
    if (!started) {
      toast.error('浏览器无法安全保存删除任务，本次未发送删除请求。');
    }
  }, [canDeleteMovement, response.items, selectedMovementForDeletion]);

  return (
    <section aria-labelledby={`${type}-management-title`} className="space-y-4">
      {type === 'outbound' &&
      (legacyOutboundCreateBlocked || legacyOutboundReconnectPending) ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 shadow-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <strong className="block text-sm">
                检测到未绑定身份的旧版出库恢复记录
              </strong>
              <p className="mt-1 text-xs leading-5 opacity-80">
                点击重新连接前不会绑定当前身份，也不会发送出库请求。
                {legacyOutboundReconnectError
                  ? ` ${legacyOutboundReconnectError}`
                  : ' 如无法重新连接，请联系管理员处理。'}
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={legacyOutboundReconnectPending}
            onClick={() => {
              void reconnectLegacyOutboundCreation();
            }}
            className="shrink-0 border-current bg-white/80"
          >
            {legacyOutboundReconnectPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            重新连接旧版原任务
          </Button>
        </div>
      ) : null}
      {type === 'outbound' && outboundCreationStorageBlocked ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-900 shadow-sm"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <strong className="block text-sm">本地出库任务日志异常</strong>
            <p className="mt-1 text-xs leading-5 opacity-80">
              {outboundCreationStatusMessage || '原记录已保留。'}
              {
                ' 为避免重复出库，恢复读取前不会发送新的出库请求。请刷新页面重试；仍未恢复时联系管理员。'
              }
            </p>
          </div>
        </div>
      ) : null}
      {type === 'outbound' && queuedOutboundFailedReceipts.length > 0 ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 shadow-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <strong className="block text-sm">
                {queuedOutboundFailedReceipts.length}笔出库草稿待恢复
              </strong>
              <p className="mt-1 text-xs leading-5 opacity-80">
                后台已确认这些请求未写入；当前编辑内容不会被后台失败任务覆盖。
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={createOpen || Boolean(manualOutboundRetryDraft)}
            onClick={restoreNextQueuedOutboundDraft}
            className="shrink-0 border-current bg-white/80"
          >
            恢复下一笔出库草稿
          </Button>
        </div>
      ) : null}
      {type === 'outbound' && primaryOutboundCreationTask ? (
        <div
          role={
            primaryOutboundCreationTask.status === 'conflict' ||
            primaryOutboundCreationTask.status === 'uncertain'
              ? 'alert'
              : 'status'
          }
          aria-live="polite"
          className={cn(
            'flex flex-col gap-3 rounded-lg border px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between',
            primaryOutboundCreationTask.status === 'conflict' ||
              primaryOutboundCreationTask.status === 'uncertain'
              ? 'border-amber-200 bg-amber-50 text-amber-900'
              : 'border-blue-200 bg-blue-50 text-blue-900',
          )}
        >
          <div className="flex min-w-0 items-start gap-3">
            {primaryOutboundCreationTask.status === 'conflict' ||
            primaryOutboundCreationTask.status === 'uncertain' ? (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
            )}
            <div className="min-w-0">
              <strong className="block text-sm">
                {primaryOutboundCreationTask.status === 'uncertain'
                  ? '出库结果待核对'
                  : primaryOutboundCreationTask.status === 'conflict'
                    ? '出库数据待核对'
                    : visibleOutboundCreationTask
                      ? '等待服务端受理'
                      : `${visibleOutboundCreationTasks.length}笔出库后台同步中`}
              </strong>
              <p className="mt-1 text-xs leading-5 opacity-80">
                {outboundCreationStatusMessages[
                  primaryOutboundCreationTask.clientMutationId
                ]
                  ? `${outboundCreationStatusMessages[primaryOutboundCreationTask.clientMutationId]} `
                  : null}
                {primaryOutboundCreationTask.status === 'uncertain'
                  ? '结果尚未确认，系统正在按原编号核对；可离开页面，请不要重复提交相同出库申请。'
                  : visibleOutboundCreationTask
                    ? '系统不会重复出库；取得任务编号前暂不允许发起下一笔。'
                    : '任务均已取得服务端编号，可继续办理下一笔；系统会在后台逐笔核对。'}
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void outboundCreationRuntimeRef.current?.checkNow();
            }}
            className="shrink-0 border-current bg-white/80"
          >
            <RefreshCw className="h-4 w-4" />
            {visibleOutboundCreationTask
              ? '重新连接未受理任务'
              : '立即查询全部'}
          </Button>
        </div>
      ) : null}
      <Card className="overflow-hidden border-[#d8e5f7] bg-white/95 shadow-[0_8px_26px_rgba(27,75,143,0.08)]">
        <CardHeader className="border-b border-blue-100 bg-gradient-to-r from-blue-50/70 via-white to-cyan-50/50 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span
                className={cn(
                  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white shadow-md',
                  meta.tone,
                )}
              >
                <meta.icon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <CardTitle
                  id={`${type}-management-title`}
                  className="text-base font-bold text-slate-900"
                >
                  {meta.title}
                </CardTitle>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {meta.description}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {type === 'inbound' ? (
                <>
                  <Button
                    size="sm"
                    onClick={() =>
                      pendingSectionRef.current?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start',
                      })
                    }
                    className="bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
                  >
                    <PackagePlus className="h-4 w-4" />
                    采购完成入库 {pendingPurchases.length}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={!canCreate}
                  onClick={openMovementCreateDialog}
                  className="bg-blue-600 text-white shadow-sm hover:bg-blue-700"
                >
                  <Plus className="h-4 w-4" />
                  {meta.actionLabel}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshAll()}
                disabled={refreshing}
                className="border-blue-200 text-blue-700 hover:bg-blue-50"
              >
                <RefreshCw
                  className={cn('h-4 w-4', refreshing && 'animate-spin')}
                />
                刷新记录
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              icon={PackageSearch}
              label="记录总数"
              value={formatNumber(response.summary.totalRecords)}
            />
            <SummaryCard
              icon={meta.icon}
              label="累计数量"
              value={formatNumber(response.summary.totalQuantity)}
            />
            <SummaryCard
              icon={CheckCircle2}
              label="状态类型"
              value={`${response.summary.statusCounts.length} 类`}
            />
            <SummaryCard
              icon={Clock3}
              label={type === 'borrow' ? '逾期未归还' : '当前筛选'}
              value={
                type === 'borrow'
                  ? `${response.summary.overdueItems} 条`
                  : status === 'all'
                    ? '全部状态'
                    : formatInventoryMovementStatusLabel(type, status)
              }
              danger={type === 'borrow' && response.summary.overdueItems > 0}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-blue-100 bg-blue-50/35 p-3 lg:flex-row lg:items-center">
            <div className="grid flex-1 gap-3 sm:grid-cols-2">
              <NativeSelect
                value={building}
                onChange={(event) => {
                  setBuilding(event.target.value as WarehouseBuilding | 'all');
                  setPage(1);
                }}
                aria-label="按楼栋筛选流转记录"
              >
                <NativeSelectOption value="all">全部楼栋</NativeSelectOption>
                {WAREHOUSE_BUILDINGS.map((item) => (
                  <NativeSelectOption key={item} value={item}>
                    {item}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <NativeSelect
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(1);
                }}
                aria-label="按状态筛选流转记录"
              >
                <NativeSelectOption value="all">全部状态</NativeSelectOption>
                {statusOptions.map((item) => (
                  <NativeSelectOption key={item} value={item}>
                    {formatInventoryMovementStatusLabel(type, item)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              disabled={building === 'all' && status === 'all'}
            >
              <RotateCcw className="h-4 w-4" />
              重置筛选
            </Button>
          </div>

          {searchQuery && (
            <p className="text-xs text-slate-500">
              当前搜索：<strong className="text-blue-700">{searchQuery}</strong>
            </p>
          )}
        </CardContent>
      </Card>

      {type === 'inbound' && (
        <div ref={pendingSectionRef} className="scroll-mt-20">
          {purchaseDeepLinkError && (
            <div
              role="alert"
              className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{purchaseDeepLinkError}</span>
            </div>
          )}
          <Card className="overflow-hidden border-emerald-200 bg-white/95 shadow-[0_8px_26px_rgba(16,185,129,0.08)]">
            <CardHeader className="border-b border-emerald-100 bg-emerald-50/60 p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 text-white">
                    <PackagePlus className="h-4 w-4" />
                  </span>
                  <div>
                    <CardTitle className="text-sm text-slate-900">
                      待采购入库
                    </CardTitle>
                    <p className="mt-1 text-xs text-slate-500">
                      采购已签收，需库房管理员确认后才增加库存
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={!canConfirm || selectedPendingIds.size < 2} onClick={beginPurchaseBatch}>
                    批量办理入库（{selectedPendingIds.size}）
                  </Button>
                  <Badge className="border-emerald-200 bg-white text-emerald-700">
                    {pendingPurchases.length} 项待办
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {pendingError && (
                <div
                  role="alert"
                  className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
                >
                  <span>{pendingError}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={retryPendingPurchases}
                  >
                    重新加载
                  </Button>
                </div>
              )}
              {pendingLoading ? (
                <div
                  role="status"
                  className="flex min-h-32 items-center justify-center gap-2 p-5 text-sm text-slate-500"
                >
                  <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
                  正在加载待采购入库清单
                </div>
              ) : filteredPendingPurchases.length ? (
                <PendingPurchaseRecords
                  items={visiblePendingPurchases}
                  total={filteredPendingPurchases.length}
                  page={pendingPage}
                  totalPages={pendingTotalPages}
                  highlightedExecutionId={highlightedExecutionId}
                  confirmingExecutionId={confirmingExecutionId}
                  onPageChange={setPendingPage}
                  onAction={handlePendingPurchaseAction}
                  selectedIds={selectedPendingIds}
                  onToggleSelection={(id) => setSelectedPendingIds((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    return next;
                  })}
                  onTogglePage={() => setSelectedPendingIds((current) => {
                    const next = new Set(current);
                    const allSelected = visiblePendingPurchases.every((item) => next.has(item.executionRecordId));
                    for (const item of visiblePendingPurchases) {
                      if (allSelected) next.delete(item.executionRecordId);
                      else next.add(item.executionRecordId);
                    }
                    return next;
                  })}
                />
              ) : (
                <div className="py-8 text-center text-sm text-slate-400">
                  {pendingPurchases.length
                    ? '当前筛选暂无待采购入库记录'
                    : '暂无待库房确认的采购物品'}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {type !== 'borrow' && batchJournals[type === 'outbound' ? 'outbound' : 'purchase'] && (
        <Card className="border-blue-200 bg-white">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-sm">{type === 'outbound' ? '批量出库' : '批量入库'}处理结果</CardTitle>
            {batchJournals[type === 'outbound' ? 'outbound' : 'purchase']!.entries.some((entry) => entry.status === 'submitting') && (
              <Button size="sm" variant="outline" onClick={() => void sendInventoryBatch(batchJournals[type === 'outbound' ? 'outbound' : 'purchase']!)}>使用原编号重新核对</Button>
            )}
          </CardHeader>
          <CardContent className="max-h-72 space-y-2 overflow-y-auto">
            {batchErrors[type === 'outbound' ? 'outbound' : 'purchase'] && <p role="alert" className="text-sm text-rose-700">{batchErrors[type === 'outbound' ? 'outbound' : 'purchase']}</p>}
            {batchJournals[type === 'outbound' ? 'outbound' : 'purchase']!.entries.map((entry) => (
              <div key={entry.clientMutationId} className="flex justify-between gap-3 border-b border-slate-100 py-2 text-sm">
                <span>{entry.label}</span>
                <span className={entry.status === 'rejected' || entry.status === 'failed' ? 'text-rose-700' : 'text-blue-700'}>
                  {{ submitting: '受理结果待核对', accepted: '已受理，后台处理中', completed: '已完成', failed: '处理失败', uncertain: '结果待核对', rejected: '未受理' }[entry.status]} · {entry.message}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden border-[#d8e5f7] bg-white/95 shadow-[0_8px_26px_rgba(27,75,143,0.08)]">
        {movementLoading && response.items.length > 0 && (
          <div
            role="status"
            className="m-4 flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            正在更新流转记录
          </div>
        )}
        {movementError && response.items.length > 0 && (
          <div
            role="alert"
            className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          >
            <span className="inline-flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {movementError}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadMovements()}
            >
              重新加载
            </Button>
          </div>
        )}
        {movementError && !response.items.length ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertCircle className="h-9 w-9 text-rose-500" />
            <div>
              <strong className="text-sm text-slate-800">数据暂不可用</strong>
              <p className="mt-1 text-xs text-slate-500">{movementError}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadMovements()}
            >
              重新加载
            </Button>
          </div>
        ) : movementLoading && !response.items.length ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-slate-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin text-blue-600" />
            正在加载{meta.title}数据
          </div>
        ) : response.items.length ? (
          <MovementRecords
            type={type}
            response={response}
            onPageChange={setPage}
            canConfirmOutbound={canConfirmOutbound && canConfirm}
            outboundConfirmationBuilding={outboundConfirmationBuilding}
            confirmingOutboundRecordId={confirmingOutboundRecordId}
            onOutboundAction={openOutboundConfirmation}
            canDeleteMovement={canDeleteMovement}
            onDeleteAction={openMovementDeletion}
            uncertainOutboundMutationIds={uncertainOutboundMutationIds}
          />
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
            <PackageSearch className="h-9 w-9 text-slate-300" />
            <strong className="mt-3 text-sm text-slate-700">
              暂无匹配记录
            </strong>
            <p className="mt-1 text-xs text-slate-400">
              可清空顶部搜索词，或重置楼栋和状态筛选。
            </p>
          </div>
        )}
      </Card>

      {type === 'inbound' ? (
        <InventoryMovementCreateDialog
          type="inbound"
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialBuilding={building === 'all' ? undefined : building}
          initialDraft={manualRetryDraft}
          retryLocked={Boolean(manualRetryDraft?.clientMutationId)}
          onAbandonRetry={abandonManualInboundRetry}
          onSubmit={submitManualInbound}
          onCreated={() => undefined}
        />
      ) : type === 'outbound' ? (
        <InventoryMovementCreateDialog
          type="outbound"
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialBuilding={building === 'all' ? undefined : building}
          initialOutboundDraft={manualOutboundRetryDraft}
          onOutboundSubmit={submitOutbound}
          onOutboundBatchSubmit={submitOutboundBatch}
          outboundBatchBlocked={Boolean(batchJournals.outbound?.entries.some((entry) =>
            entry.status === 'submitting' || entry.status === 'accepted' || entry.status === 'uncertain'
          ))}
          onCreated={() => undefined}
        />
      ) : (
        <InventoryMovementCreateDialog
          type={type}
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialBuilding={building === 'all' ? undefined : building}
          onCreated={() => {
            if (page !== 1) setPage(1);
            else void loadMovements(true);
          }}
        />
      )}
      <PurchaseInboundConfirmationDialog
        key={selectedPending?.executionRecordId || 'purchase-inbound'}
        open={Boolean(selectedPending)}
        item={selectedPending}
        initialDraft={purchaseRetryDraft}
        retryLocked={Boolean(purchaseRetryDraft?.clientMutationId)}
        onAbandonRetry={abandonPurchaseInboundRetry}
        onCategoryPrepared={handlePurchaseCategoryPrepared}
        onOpenChange={handlePurchaseInboundOpenChange}
        batchPosition={batchInboundIndex >= 0 ? { current: batchInboundIndex + 1, total: batchInboundQueue.length } : undefined}
        onSubmit={batchInboundIndex >= 0 ? stagePurchaseBatch : submitPurchaseInbound}
      />
      <InventoryOutboundConfirmationDialog
        open={
          Boolean(selectedOutbound) &&
          Boolean(
            selectedOutbound && canActOnRecord('confirm', selectedOutbound) &&
            canConfirmInventoryOutboundForBuilding(
              canConfirmOutbound,
              selectedOutbound.building,
              outboundConfirmationBuilding,
            ),
          )
        }
        item={selectedOutbound}
        canConfirm={Boolean(
          selectedOutbound && canActOnRecord('confirm', selectedOutbound) &&
          canConfirmInventoryOutboundForBuilding(
            canConfirmOutbound,
            selectedOutbound.building,
            outboundConfirmationBuilding,
          ),
        )}
        submitting={
          Boolean(selectedOutbound) &&
          confirmingOutboundRecordId === selectedOutbound?.recordId
        }
        retryLocked={Boolean(outboundConfirmRetryMutationId)}
        onOpenChange={(next) => !next && setSelectedOutbound(null)}
        onAbandonRetry={abandonOutboundConfirmationRetry}
        onConfirm={submitOutboundConfirmation}
      />
      <MovementDeletionDialog
        item={selectedMovementForDeletion}
        open={Boolean(selectedMovementForDeletion)}
        onOpenChange={(next) => {
          if (!next) setSelectedMovementForDeletion(null);
        }}
        onConfirm={confirmMovementDeletion}
      />
    </section>
  );
}

function outboundSubmissionToCreationTask(
  submission: InventoryOutboundSubmission,
): InventoryOutboundCreationTaskInput {
  const selectedItem = submission.draft.selectedItem;
  const applicant = submission.draft.applicant;
  if (!selectedItem || !applicant) {
    throw new Error('出库草稿缺少物品或申请人');
  }

  return {
    clientMutationId: submission.clientMutationId,
    status: 'submitting',
    taskId: null,
    request: { ...submission.request },
    draft: {
      ...submission.draft,
      clientMutationId: submission.clientMutationId,
      selectedItem: { ...selectedItem },
      applicant: { ...applicant },
    },
    optimisticItem: { ...submission.optimisticMovement },
    createdAt: submission.startedAt,
    updatedAt: submission.startedAt,
  };
}

function journalToOutboundSubmission(
  journal: InventoryOutboundCreationTaskJournal,
): InventoryOutboundSubmission {
  return {
    clientMutationId: journal.clientMutationId,
    startedAt: journal.createdAt,
    request: { ...journal.request },
    draft: {
      ...journal.draft,
      selectedItem: { ...journal.draft.selectedItem },
      applicant: { ...journal.draft.applicant },
    },
    optimisticMovement: {
      ...journal.optimisticItem,
    } as InventoryOutboundMovementItem,
  };
}

function PendingPurchaseRecords({
  items,
  selectedIds,
  onToggleSelection,
  onTogglePage,
  total,
  page,
  totalPages,
  highlightedExecutionId,
  confirmingExecutionId,
  onPageChange,
  onAction,
}: {
  items: PurchasePendingInboundItem[];
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onTogglePage: () => void;
  total: number;
  page: number;
  totalPages: number;
  highlightedExecutionId: string;
  confirmingExecutionId: string;
  onPageChange: (page: number) => void;
  onAction: (item: PurchasePendingInboundItem) => void;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
          <caption className="sr-only">待采购入库清单</caption>
          <thead className="bg-slate-50/80 text-xs font-semibold text-slate-500">
            <tr>
              <th className="px-3 py-3">
                <input type="checkbox" aria-label="选择本页待入库物品" checked={items.length > 0 && items.every((item) => selectedIds.has(item.executionRecordId))} onChange={onTogglePage} />
              </th>
              <th className="px-5 py-3">物品 / 类别号</th>
              <th className="px-4 py-3">采购单 / 楼栋</th>
              <th className="px-4 py-3">规格 / 品牌</th>
              <th className="px-4 py-3">类型 / 待处理事项</th>
              <th className="px-4 py-3 text-right">实收数量</th>
              <th className="px-4 py-3">签收时间</th>
              <th className="px-5 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.executionRecordId}
                data-purchase-execution-id={item.executionRecordId}
                className={cn(
                  'border-t border-slate-100 align-top transition hover:bg-emerald-50/30',
                  item.executionRecordId === highlightedExecutionId &&
                    'ring-2 ring-emerald-300 ring-inset',
                )}
              >
                <td className="px-3 py-3.5">
                  <input type="checkbox" aria-label={`选择${item.itemName}入库`} checked={selectedIds.has(item.executionRecordId)} onChange={() => onToggleSelection(item.executionRecordId)} />
                </td>
                <td className="max-w-56 px-5 py-3.5">
                  <strong className="block truncate text-slate-900">
                    {item.itemName}
                  </strong>
                  <span className="mt-1 block truncate text-xs text-slate-400">
                    {item.sku || '类别号待配置'}
                  </span>
                </td>
                <td className="max-w-52 px-4 py-3.5 text-slate-600">
                  <span className="block truncate">{item.requestCode}</span>
                  <span className="mt-1 block truncate text-xs text-slate-400">
                    {item.building}
                  </span>
                </td>
                <td className="max-w-52 px-4 py-3.5 text-slate-600">
                  <span className="block truncate">
                    {item.specification || '规格待补充'}
                  </span>
                  <span className="mt-1 block truncate text-xs text-slate-400">
                    {item.brand || '品牌待补充'}
                  </span>
                </td>
                <td className="max-w-60 px-4 py-3.5">
                  <Badge
                    className={
                      item.preparedCategory
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : 'border-slate-200 bg-slate-50 text-slate-600'
                    }
                  >
                    {item.preparedCategory ? '新增（已生成）' : '待选择'}
                  </Badge>
                  <span className="mt-1.5 block text-xs text-slate-500">
                    {item.actionReason ||
                      (item.action === 'ready'
                        ? '可直接入库'
                        : '需完善库存类别')}
                  </span>
                </td>
                <td className="px-4 py-3.5 text-right font-bold tabular-nums text-slate-900">
                  {formatNumber(item.quantity)} {item.unit}
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 text-slate-500">
                  {formatDateTime(item.signedAt)}
                </td>
                <td className="px-5 py-3.5 text-right">
                  <PendingPurchaseActionButton
                    item={item}
                    confirmingExecutionId={confirmingExecutionId}
                    onAction={onAction}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 p-4 md:hidden">
        {items.map((item) => (
          <article
            key={item.executionRecordId}
            data-purchase-execution-id={item.executionRecordId}
            className={cn(
              'rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition',
              item.executionRecordId === highlightedExecutionId &&
                'ring-2 ring-emerald-300 ring-inset',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <input type="checkbox" aria-label={`选择${item.itemName}入库`} checked={selectedIds.has(item.executionRecordId)} onChange={() => onToggleSelection(item.executionRecordId)} />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-slate-900">
                  {item.itemName}
                </h3>
                <p className="mt-1 truncate text-xs text-slate-400">
                  {item.requestCode} · {item.building}
                </p>
              </div>
              <Badge
                className={
                  item.preparedCategory
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
                }
              >
                {item.preparedCategory ? '新增（已生成）' : '待选择'}
              </Badge>
            </div>
            <div className="mt-3 grid gap-1.5 text-xs text-slate-500">
              <span>类别：{item.sku || '类别号待配置'}</span>
              <span>规格：{item.specification || '待补充'}</span>
              <span>品牌：{item.brand || '待补充'}</span>
              <span>
                处理：
                {item.actionReason ||
                  (item.action === 'ready' ? '可直接入库' : '需完善库存类别')}
              </span>
              <span>签收：{formatDateTime(item.signedAt)}</span>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <span className="text-xs text-slate-500">
                实收{' '}
                <strong className="text-sm tabular-nums text-slate-900">
                  {formatNumber(item.quantity)} {item.unit}
                </strong>
              </span>
              <PendingPurchaseActionButton
                item={item}
                confirmingExecutionId={confirmingExecutionId}
                onAction={onAction}
              />
            </div>
          </article>
        ))}
      </div>

      <div className="flex flex-col gap-3 border-t border-slate-100 px-5 py-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
        <span>
          共 {formatNumber(total)} 条 · 第 {page} / {totalPages} 页
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="待采购入库清单上一页"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="待采购入库清单下一页"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            下一页
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
}

function PendingPurchaseActionButton({
  item,
  confirmingExecutionId,
  onAction,
}: {
  item: PurchasePendingInboundItem;
  confirmingExecutionId: string;
  onAction: (item: PurchasePendingInboundItem) => void;
}) {
  const canConfirm = canUseInventoryAction(useAccess(), 'confirm', item);
  const isConfirming = confirmingExecutionId === item.executionRecordId;

  return (
    <Button
      size="sm"
      aria-label={`处理${item.itemName}入库`}
      disabled={isConfirming || !canConfirm}
      className="shrink-0 bg-emerald-600 text-white hover:bg-emerald-700"
      onClick={() => onAction(item)}
    >
      {isConfirming && <Loader2 className="h-4 w-4 animate-spin" />}
      {isConfirming ? '正在受理' : '办理入库'}
    </Button>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  danger = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-white px-4 py-3 shadow-sm">
      <span
        className={cn(
          'inline-flex h-9 w-9 items-center justify-center rounded-lg',
          danger ? 'bg-rose-50 text-rose-600' : 'bg-blue-50 text-blue-600',
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span>
        <small className="block text-[11px] text-slate-400">{label}</small>
        <strong
          className={cn(
            'mt-0.5 block text-base tabular-nums',
            danger ? 'text-rose-700' : 'text-slate-900',
          )}
        >
          {value}
        </strong>
      </span>
    </div>
  );
}

function MovementRecords({
  type,
  response,
  onPageChange,
  canConfirmOutbound,
  outboundConfirmationBuilding,
  confirmingOutboundRecordId,
  onOutboundAction,
  canDeleteMovement,
  onDeleteAction,
  uncertainOutboundMutationIds,
}: {
  type: InventoryMovementType;
  response: InventoryMovementsResponse;
  onPageChange: (page: number) => void;
  canConfirmOutbound: boolean;
  outboundConfirmationBuilding: WarehouseBuilding | null;
  confirmingOutboundRecordId: string;
  onOutboundAction: (item: InventoryOutboundMovementItem) => void;
  canDeleteMovement: (item: InventoryMovementItem) => boolean;
  onDeleteAction: (item: InventoryMovementItem) => void;
  uncertainOutboundMutationIds: ReadonlySet<string>;
}) {
  const principal = useAccess();
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
          <thead className="bg-slate-50/80 text-xs font-semibold text-slate-500">
            <tr>
              <th className="px-5 py-3">物品 / 类别号</th>
              <th className="px-4 py-3">规格型号</th>
              <th className="px-4 py-3">来源楼栋 / 库位</th>
              <th className="px-4 py-3">业务明细</th>
              <th className="px-4 py-3">责任人员</th>
              <th className="px-4 py-3 text-right">数量</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-5 py-3">发生时间</th>
              {(type === 'inbound' || type === 'outbound') && (
                <th className="px-5 py-3 text-right">库房操作</th>
              )}
            </tr>
          </thead>
          <tbody>
            {response.items.map((item) => {
              const outboundItem = asOutboundMovement(item);
              const pendingSyncUncertain =
                item.pendingSync === true &&
                type === 'outbound' &&
                uncertainOutboundMutationIds.has(item.clientMutationId);
              const confirmable = Boolean(
                outboundItem &&
                canUseInventoryAction(principal, 'confirm', item) && canConfirmInventoryOutboundForBuilding(
                  canConfirmOutbound,
                  outboundItem.building,
                  outboundConfirmationBuilding,
                ) &&
                outboundItem?.status === '待库房确认' &&
                outboundItem.pendingSync !== true,
              );
              return (
                <tr
                  key={item.recordId}
                  className={cn(
                    'border-t border-slate-100 align-top hover:bg-blue-50/35',
                    confirmable && 'cursor-pointer',
                  )}
                  tabIndex={confirmable ? 0 : undefined}
                  onClick={() =>
                    confirmable &&
                    outboundItem &&
                    onOutboundAction(outboundItem)
                  }
                  onKeyDown={(event) => {
                    if (
                      confirmable &&
                      outboundItem &&
                      (event.key === 'Enter' || event.key === ' ')
                    ) {
                      event.preventDefault();
                      onOutboundAction(outboundItem);
                    }
                  }}
                >
                  <td className="max-w-60 px-5 py-3.5">
                    <strong
                      className="block truncate text-slate-900"
                      title={item.name}
                    >
                      {item.name}
                    </strong>
                    <span className="mt-1 block truncate text-xs text-slate-400">
                      {item.sku || '类别号待配置'}
                    </span>
                  </td>
                  <td className="max-w-52 px-4 py-3.5 text-slate-600">
                    <span className="block truncate" title={item.specification}>
                      {item.specification || '规格待补充'}
                    </span>
                  </td>
                  <td className="max-w-48 px-4 py-3.5 text-slate-600">
                    <span className="block truncate">{item.building}</span>
                    <span className="mt-1 block truncate text-xs text-slate-400">
                      {item.location || '库位待配置'}
                    </span>
                  </td>
                  <td className="max-w-60 px-4 py-3.5 text-slate-600">
                    <FlowDetail type={type} item={item} />
                  </td>
                  <td className="max-w-44 px-4 py-3.5 text-slate-600">
                    <span className="block truncate">
                      {item.operator ||
                        (type === 'inbound'
                          ? '入库责任人待补充'
                          : '经办人待补充')}
                    </span>
                    {type !== 'inbound' && (
                      <span className="mt-1 block truncate text-xs text-slate-400">
                        申请：{item.applicant || '待补充'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-right font-bold tabular-nums text-slate-900">
                    {formatNumber(item.quantity)} {item.unit}
                  </td>
                  <td className="px-4 py-3.5">
                    <MovementStatus
                      item={item}
                      pendingSyncUncertain={pendingSyncUncertain}
                    />
                  </td>
                  <td className="whitespace-nowrap px-5 py-3.5 text-slate-500">
                    {formatDateTime(item.occurredAt)}
                  </td>
                  {(type === 'inbound' || type === 'outbound') && (
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex justify-end gap-2">
                        {confirmable && outboundItem ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              confirmingOutboundRecordId ===
                              outboundItem.recordId
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              onOutboundAction(outboundItem);
                            }}
                            className="border-blue-200 text-blue-700 hover:bg-blue-50"
                          >
                            {confirmingOutboundRecordId ===
                            outboundItem.recordId ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-4 w-4" />
                            )}
                            查看并确认
                          </Button>
                        ) : type === 'outbound' && outboundItem ? (
                          <span className="text-xs text-slate-400">
                            {getOutboundOperationHint(
                              outboundItem,
                              canUseInventoryAction(principal, 'confirm', item) && canConfirmInventoryOutboundForBuilding(
                                canConfirmOutbound,
                                outboundItem.building,
                                outboundConfirmationBuilding,
                              ),
                            )}
                          </span>
                        ) : null}
                        {canDeleteMovement(item) && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={`删除${item.type === 'inbound' ? '入库' : '出库'}记录 ${item.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onDeleteAction(item);
                            }}
                            className="border-rose-200 text-rose-700 hover:bg-rose-50"
                          >
                            <Trash2 className="h-4 w-4" />
                            删除
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 p-4 md:hidden">
        {response.items.map((item) => {
          const outboundItem = asOutboundMovement(item);
          const pendingSyncUncertain =
            item.pendingSync === true &&
            type === 'outbound' &&
            uncertainOutboundMutationIds.has(item.clientMutationId);
          const confirmable = Boolean(
            outboundItem &&
            canUseInventoryAction(principal, 'confirm', item) && canConfirmInventoryOutboundForBuilding(
              canConfirmOutbound,
              outboundItem.building,
              outboundConfirmationBuilding,
            ) &&
            outboundItem?.status === '待库房确认' &&
            outboundItem.pendingSync !== true,
          );
          return (
            <article
              key={item.recordId}
              className={cn(
                'rounded-xl border border-[#d8e5f7] bg-white p-4 shadow-sm',
                confirmable && 'cursor-pointer active:bg-blue-50',
              )}
              tabIndex={confirmable ? 0 : undefined}
              onClick={() =>
                confirmable && outboundItem && onOutboundAction(outboundItem)
              }
              onKeyDown={(event) => {
                if (
                  confirmable &&
                  outboundItem &&
                  (event.key === 'Enter' || event.key === ' ')
                ) {
                  event.preventDefault();
                  onOutboundAction(outboundItem);
                }
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-slate-900">
                    {item.name}
                  </h3>
                  <p className="mt-1 truncate text-xs text-slate-400">
                    {item.sku || '类别号待配置'} ·{' '}
                    {item.specification || '规格待补充'}
                  </p>
                </div>
                <strong className="shrink-0 text-sm tabular-nums text-slate-900">
                  {formatNumber(item.quantity)} {item.unit}
                </strong>
              </div>
              <div className="mt-3 grid gap-2 text-xs text-slate-500">
                <span className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 text-blue-500" />
                  {item.building} · {item.location || '库位待配置'}
                </span>
                <span className="flex items-center gap-1.5">
                  <UserRound className="h-3.5 w-3.5 text-blue-500" />
                  {item.operator || '经办责任人待补充'}
                  {type !== 'inbound' &&
                    ` · 申请 ${item.applicant || '待补充'}`}
                </span>
                <span className="flex items-start gap-1.5">
                  <CalendarClock className="mt-0.5 h-3.5 w-3.5 text-blue-500" />
                  <span>
                    <FlowDetail type={type} item={item} />
                  </span>
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
                <MovementStatus
                  item={item}
                  pendingSyncUncertain={pendingSyncUncertain}
                />
                <div className="flex items-center gap-2">
                  {confirmable && outboundItem ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOutboundAction(outboundItem);
                      }}
                      className="border-blue-200 text-blue-700"
                    >
                      查看并确认
                    </Button>
                  ) : (
                    <span className="text-xs text-slate-400">
                      {type === 'outbound' && outboundItem
                        ? getOutboundOperationHint(
                            outboundItem,
                            canUseInventoryAction(principal, 'confirm', item) && canConfirmInventoryOutboundForBuilding(
                              canConfirmOutbound,
                              outboundItem.building,
                              outboundConfirmationBuilding,
                            ),
                          )
                        : formatDateTime(item.occurredAt)}
                    </span>
                  )}
                  {canDeleteMovement(item) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`删除${item.type === 'inbound' ? '入库' : '出库'}记录 ${item.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteAction(item);
                      }}
                      className="border-rose-200 text-rose-700"
                    >
                      <Trash2 className="h-4 w-4" />
                      删除
                    </Button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 border-t border-slate-100 px-5 py-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
        <span>
          共 {formatNumber(response.total)} 条 · 第 {response.page} /{' '}
          {response.totalPages} 页
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={response.page <= 1}
            onClick={() => onPageChange(response.page - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={response.page >= response.totalPages}
            onClick={() => onPageChange(response.page + 1)}
          >
            下一页
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
}

function MovementDeletionDialog({
  item,
  open,
  onOpenChange,
  onConfirm,
}: {
  item: InventoryMovementItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const impact = !item
    ? ''
    : item.type === 'inbound'
      ? item.sourceKind === 'purchase'
        ? '删除后库存将减少；采购将回到待库房入库。'
        : '删除后库存将减少。'
      : item.status === '已出库'
        ? '删除后库存将恢复。'
        : '只取消本次申请，不影响库存。';

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除出入库记录</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left">
              <p>
                此操作会在当前清单立即隐藏记录，并在后台同步到多维表。
                后台确定失败时会自动恢复。
              </p>
              {item && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-slate-700">
                  <strong className="block text-sm text-slate-900">
                    {item.name} · {item.sku || '类别号未配置'}
                  </strong>
                  <span className="mt-1 block text-xs">
                    {item.building} · {formatNumber(item.quantity)} {item.unit}{' '}
                    ·{' '}
                    {formatInventoryMovementStatusLabel(item.type, item.status)}
                  </span>
                  <span className="mt-1 block text-xs">
                    发生时间：{formatDateTime(item.occurredAt)}
                  </span>
                </div>
              )}
              <p className="font-semibold text-rose-700">{impact}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-rose-600 text-white hover:bg-rose-700"
          >
            确认删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function FlowDetail({
  type,
  item,
}: {
  type: InventoryMovementType;
  item: InventoryMovementItem;
}) {
  if (type === 'inbound') {
    return <span className="block text-slate-500">入库登记</span>;
  }
  if (type === 'outbound') {
    return (
      <span className="block truncate" title={item.reason}>
        {item.reason || '出库原因/使用地点待补充'}
      </span>
    );
  }
  if (type === 'borrow') {
    return (
      <>
        <span className="block truncate" title={item.reason}>
          {item.reason || '借调原因待补充'}
        </span>
        <span
          className={cn(
            'mt-1 block truncate text-xs',
            item.overdue ? 'font-semibold text-rose-600' : 'text-amber-600',
          )}
        >
          预计归还：{formatDateTime(item.expectedReturnAt)}
        </span>
      </>
    );
  }
  return null;
}

function MovementStatus({
  item,
  pendingSyncUncertain = false,
}: {
  item: InventoryMovementItem;
  pendingSyncUncertain?: boolean;
}) {
  const statusLabel =
    item.type === 'outbound'
      ? formatInventoryOutboundStatusLabel(item.status)
      : formatInventoryMovementStatusLabel(item.type, item.status);
  const approvalRejectionReason =
    item.type === 'outbound' && item.status === '已驳回'
      ? item.approvalRejectionReason?.trim()
      : '';
  if (item.pendingSync) {
    if (pendingSyncUncertain) {
      return (
        <Badge
          aria-live="polite"
          className="border-amber-200 bg-amber-50 text-amber-700"
        >
          <AlertCircle className="h-3.5 w-3.5" />
          {statusLabel} · 结果待核对
        </Badge>
      );
    }
    return (
      <Badge
        aria-live="polite"
        className="border-blue-200 bg-blue-50 text-blue-700"
      >
        {item.type === 'outbound' && item.status === '待审批'
          ? '待审批 · 后台同步中，可安全离开'
          : `${statusLabel} · 后台同步中，可安全离开`}
      </Badge>
    );
  }

  return (
    <div className="space-y-1">
      <Badge
        className={cn(
          item.overdue || item.status === '已驳回'
            ? 'border-rose-200 bg-rose-50 text-rose-700'
            : item.type === 'inbound'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : item.type === 'borrow'
                ? 'border-amber-200 bg-amber-50 text-amber-700'
                : item.status === '待路由'
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-blue-200 bg-blue-50 text-blue-700',
        )}
      >
        {item.overdue ? '已逾期' : statusLabel}
      </Badge>
      {approvalRejectionReason && (
        <span
          className="block max-w-56 text-xs leading-5 text-rose-600"
          title={approvalRejectionReason}
        >
          驳回原因：{approvalRejectionReason}
        </span>
      )}
    </div>
  );
}

interface CanonicalInboundExpectation {
  clientMutationId: string;
  building: WarehouseBuilding;
  quantity: number;
  occurredAt: string;
  name: string;
  specification: string;
  location: string;
  sku?: string;
}

function requireCanonicalInboundMovement(
  value: unknown,
  expectation: CanonicalInboundExpectation,
): InventoryMovementItem {
  if (!value || typeof value !== 'object') {
    throw new Error('后端未返回已确认的入库记录，请使用原草稿重试');
  }
  const movement = value as Partial<InventoryMovementItem>;
  const requiredText = [
    movement.recordId,
    movement.sku,
    movement.name,
    movement.specification,
    movement.location,
    movement.unit,
    movement.status,
    movement.occurredAt,
  ];
  if (
    movement.type !== 'inbound' ||
    !requiredText.every((item) => typeof item === 'string') ||
    !String(movement.recordId).trim() ||
    !String(movement.sku).trim() ||
    !String(movement.name).trim() ||
    !String(movement.location).trim() ||
    !String(movement.status).trim() ||
    !WAREHOUSE_BUILDINGS.includes(movement.building as WarehouseBuilding) ||
    !Number.isFinite(movement.quantity) ||
    Number(movement.quantity) <= 0 ||
    !Number.isFinite(Date.parse(String(movement.occurredAt))) ||
    typeof movement.destinationBuilding !== 'string' ||
    typeof movement.reason !== 'string' ||
    typeof movement.operator !== 'string' ||
    typeof movement.applicant !== 'string' ||
    typeof movement.overdue !== 'boolean'
  ) {
    throw new Error('后端返回的入库记录不完整，请使用原草稿重试');
  }
  if (
    movement.clientMutationId !== expectation.clientMutationId ||
    movement.building !== expectation.building ||
    movement.quantity !== expectation.quantity ||
    String(movement.name).trim() !== expectation.name.trim() ||
    String(movement.specification).trim() !==
      expectation.specification.trim() ||
    String(movement.location).trim() !== expectation.location.trim() ||
    (expectation.sku !== undefined &&
      String(movement.sku).trim().toUpperCase() !==
        expectation.sku.trim().toUpperCase()) ||
    Date.parse(String(movement.occurredAt)) !==
      Date.parse(expectation.occurredAt)
  ) {
    throw new Error('后端返回的入库记录与本次请求不一致');
  }
  return movement as InventoryMovementItem;
}

function clonePreparedCategory(
  preparedCategory: PurchaseInboundPreparedCategory,
): PurchaseInboundPreparedCategory {
  return {
    ...preparedCategory,
    newItem: { ...preparedCategory.newItem },
  };
}

function hasUnboundLegacyOutboundCreateRecovery(): boolean {
  const recovery = readInventoryOutboundRecovery();
  return recovery?.kind === 'create' && recovery.status === 'unknown';
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(
    value || 0,
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return '未填写';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
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

function asOutboundMovement(
  item: InventoryMovementItem,
): InventoryOutboundMovementItem | null {
  if (
    item.type !== 'outbound' ||
    (item.status !== '待路由' &&
      item.status !== '待审批' &&
      item.status !== '待库房确认' &&
      item.status !== '已驳回' &&
      item.status !== '已出库')
  ) {
    return null;
  }
  return item as InventoryOutboundMovementItem;
}

function getOutboundOperationHint(
  item: InventoryOutboundMovementItem,
  canConfirm: boolean,
): string {
  if (item.pendingSync) return '后台同步中';
  if (item.status === '待路由') return '等待分配审批人';
  if (item.status === '待审批') return '等待审批';
  if (item.status === '已驳回') return '已驳回';
  if (item.status === '已出库') return '已完成';
  return canConfirm ? '审批已通过，待库房确认' : '审批已通过，仅库房人员可确认';
}

function createClientMutationId(prefix: string): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
