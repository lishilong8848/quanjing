import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ClipboardPlus,
  Loader2,
  PackageSearch,
  Pencil,
  ShieldCheck,
  ShoppingCart,
  Trash2,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAccess } from '@/access/AccessProvider';
import {
  canCreatePurchaseApplication,
  canDeleteCompletedPurchaseRecords,
  canDeletePurchaseRecord,
  canEditPurchaseRecord,
  canOrderPurchaseRecord,
  canReceivePurchaseRecord,
} from '@/access/access-policy';
import { getPurchaseInventoryDashboard } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  PURCHASE_INVENTORY_MANAGEMENT_PATH,
  isPurchaseApplicationDirectPath,
} from '@/navigation/purchase-application-route';
import type {
  PurchaseInventoryRequestItem,
  PurchaseInventoryResponse,
} from '@shared/purchase-inventory.interface';
import type {
  PurchaseApplicationBatchRequest,
  PurchaseApplicationSubmitResponse,
} from '@shared/purchase-application.interface';

import { ManagementHeader } from './ManagementHeader';
import { PurchaseApplicationDialog } from './PurchaseApplicationDialog';
import { PurchaseRecordEditDialog } from './PurchaseAnomalyEditDialog';
import { PurchaseCompletionAnalysisDialog } from './PurchaseCompletionAnalysisDialog';
import { PurchaseDeleteDialog } from './PurchaseDeleteDialog';
import { PurchaseOnlineApprovalDialog } from './PurchaseOnlineApprovalDialog';
import { PurchaseWorkflowDialog } from './PurchaseWorkflowDialog';
import {
  buildPendingPurchaseApplicationItems,
  buildPurchaseAnomalies,
  createEmptyPurchaseInventoryDashboard,
  filterPurchaseApplicationItems,
  filterPurchaseExecutionItems,
  filterPurchaseInboundItems,
  groupPurchaseOrderItems,
  prunePurchaseSelection,
  reconcilePendingPurchaseApplicationItems,
  removeDeletedPurchaseRequests,
  replacePurchaseApplicationOverlay,
  toggleVisiblePurchaseSelection,
  type PurchaseApplicationFilter,
  type PurchaseAnomalyItem,
  type PurchaseExecutionFilter,
} from './logic';
import {
  applyPurchaseApprovalOptimisticUpdate,
  applyPurchaseOrderOptimisticUpdate,
  applyPurchaseReceiptOptimisticUpdate,
  canApprovePurchaseOnline,
  restorePurchaseOptimisticItem,
} from './purchase-online-approval.logic';

const AUTO_REFRESH_MS = 4 * 60 * 60 * 1000;
const ACTIVE_AUTO_REFRESH_MS = 15 * 1000;
const EMPTY_REQUESTS: PurchaseInventoryRequestItem[] = [];

type DashboardRefreshMode = boolean | 'active';

interface DashboardRequestInFlight {
  mode: DashboardRefreshMode;
  principalKey: string;
  promise: Promise<boolean>;
  queuedForceRefresh?: Promise<boolean>;
}

type OverviewCardKey =
  | 'application-stage'
  | 'executing'
  | 'receiving'
  | 'completed';

interface FlowChartItem {
  key: string;
  label: string;
  color: string;
  value: number;
  percentage: number;
}

const applicationFilters: Array<{
  key: PurchaseApplicationFilter;
  label: string;
}> = [
  { key: 'all', label: '全部申请' },
  { key: 'application', label: '待提交' },
  { key: 'approval', label: '审批中' },
];

const executionFilters: Array<{
  key: PurchaseExecutionFilter;
  label: string;
}> = [
  { key: 'all', label: '全部执行' },
  { key: 'executing', label: '采购执行' },
  { key: 'receiving', label: '待收货签收' },
];

const inboundFilters = [{ key: 'all', label: '全部待入库' }];

const activeStages: Array<{
  key:
    | 'application'
    | 'approval'
    | 'rejected'
    | 'executing'
    | 'receiving'
    | 'inbound';
  label: string;
  detail: string;
  icon: LucideIcon;
  color: string;
  iconClass: string;
  panelClass: string;
}> = [
  {
    key: 'application',
    label: '采购申请',
    detail: '待提交采购需求',
    icon: ClipboardCheck,
    color: '#2F6BFF',
    iconClass: 'bg-blue-500 text-white shadow-blue-200',
    panelClass: 'border-blue-200 bg-blue-50/55',
  },
  {
    key: 'approval',
    label: '审批中',
    detail: '等待审批处理',
    icon: ShieldCheck,
    color: '#F59E0B',
    iconClass: 'bg-amber-500 text-white shadow-amber-200',
    panelClass: 'border-amber-200 bg-amber-50/55',
  },
  {
    key: 'rejected',
    label: '已驳回',
    detail: '采购申请已驳回',
    icon: AlertCircle,
    color: '#E11D48',
    iconClass: 'bg-rose-500 text-white shadow-rose-200',
    panelClass: 'border-rose-200 bg-rose-50/70 text-rose-700',
  },
  {
    key: 'executing',
    label: '采购执行',
    detail: '询价、下单与合同',
    icon: ShoppingCart,
    color: '#F97316',
    iconClass: 'bg-orange-500 text-white shadow-orange-200',
    panelClass: 'border-orange-200 bg-orange-50/55',
  },
  {
    key: 'receiving',
    label: '待收货签收',
    detail: '到货、质检与签收',
    icon: Truck,
    color: '#06B6D4',
    iconClass: 'bg-cyan-500 text-white shadow-cyan-200',
    panelClass: 'border-cyan-200 bg-cyan-50/55',
  },
  {
    key: 'inbound',
    label: '签收待入库',
    detail: '已签收，等待库房入库',
    icon: PackageSearch,
    color: '#10B981',
    iconClass: 'bg-emerald-500 text-white shadow-emerald-200',
    panelClass: 'border-emerald-200 bg-emerald-50/55',
  },
];

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return '未填写';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未填写';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间待同步';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatQuantity(item: PurchaseInventoryRequestItem): string {
  const quantity = item.actualQuantity ?? item.quantity;
  return `${quantity.toLocaleString('zh-CN')} ${item.unit || '件'}`;
}

export default function PurchaseOverviewPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    role,
    purchaseBuilding, buildings,
    capabilities: { canForceRefresh },
  } = useAccess();
  const principal = useMemo(
    () => ({ role, purchaseBuilding, buildings }),
    [purchaseBuilding, buildings, role],
  );
  const principalKey = `${role}:${purchaseBuilding || ''}:${(buildings || []).join(',')}`;
  const canCreateApplication = canCreatePurchaseApplication(principal);
  const canDeleteCompletedRecords =
    canDeleteCompletedPurchaseRecords(principal);
  const canEditRecord = useCallback(
    (item: PurchaseInventoryRequestItem) =>
      !item.pendingSync && canEditPurchaseRecord(principal, item),
    [principal],
  );
  const canDeleteRecord = useCallback(
    (item: PurchaseInventoryRequestItem) =>
      !item.pendingSync && canDeletePurchaseRecord(principal, item),
    [principal],
  );
  const canApproveItem = useCallback(
    (item: PurchaseInventoryRequestItem) =>
      !item.pendingSync && canApprovePurchaseOnline(principal, item),
    [principal],
  );
  const canOrderItem = useCallback(
    (item: PurchaseInventoryRequestItem) =>
      !item.pendingSync && canOrderPurchaseRecord(principal, item),
    [principal],
  );
  const canReceiveItem = useCallback(
    (item: PurchaseInventoryRequestItem) =>
      !item.pendingSync && canReceivePurchaseRecord(principal, item),
    [principal],
  );
  const [applicationDialogOpen, setApplicationDialogOpen] = useState(false);
  const [completionDialogOpen, setCompletionDialogOpen] = useState(false);
  const [approvalItem, setApprovalItem] =
    useState<PurchaseInventoryRequestItem | null>(null);
  const [workflowItem, setWorkflowItem] =
    useState<PurchaseInventoryRequestItem | null>(null);
  const [editingRecord, setEditingRecord] = useState<{
    item: PurchaseInventoryRequestItem;
    issues?: string[];
  } | null>(null);
  const [deleteItems, setDeleteItems] = useState<
    PurchaseInventoryRequestItem[]
  >([]);
  const [applicationFilter, setApplicationFilter] =
    useState<PurchaseApplicationFilter>('all');
  const [executionFilter, setExecutionFilter] =
    useState<PurchaseExecutionFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dashboardState, setDashboard] =
    useState<PurchaseInventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dashboardNotice, setDashboardNotice] = useState<string | null>(null);
  const dashboardRef = useRef<PurchaseInventoryResponse | null>(null);
  const optimisticItemSnapshotsRef = useRef<
    Map<string, PurchaseInventoryRequestItem>
  >(new Map());
  const deletedRequestIdsRef = useRef<Set<string>>(new Set());
  const pendingApplicationItemsRef = useRef<
    Map<string, PurchaseInventoryRequestItem[]>
  >(new Map());
  const dashboardRequestSequenceRef = useRef(0);
  const dashboardRequestInFlightRef = useRef<DashboardRequestInFlight | null>(
    null,
  );
  const previousPrincipalKeyRef = useRef(principalKey);
  const activePrincipalKeyRef = useRef(principalKey);
  activePrincipalKeyRef.current = principalKey;
  const principalMatchesRenderedData =
    previousPrincipalKeyRef.current === principalKey;
  const dashboard = principalMatchesRenderedData ? dashboardState : null;
  const renderedLoading = principalMatchesRenderedData ? loading : true;
  const renderedLoadError = principalMatchesRenderedData ? loadError : null;
  const renderedDashboardNotice = principalMatchesRenderedData
    ? dashboardNotice
    : null;
  const applicationListRef = useRef<HTMLElement>(null);
  const executionListRef = useRef<HTMLElement>(null);

  const loadDashboard = useCallback(function runDashboardRequest(
    refresh: DashboardRefreshMode = false,
  ): Promise<boolean> {
    const requestPrincipalKey = activePrincipalKeyRef.current;
    const currentRequest = dashboardRequestInFlightRef.current;
    if (currentRequest && currentRequest.principalKey === requestPrincipalKey) {
      if (refresh === true && currentRequest.mode !== true) {
        currentRequest.queuedForceRefresh ??= currentRequest.promise.then(() =>
          activePrincipalKeyRef.current === requestPrincipalKey
            ? runDashboardRequest(true)
            : false,
        );
        return currentRequest.queuedForceRefresh;
      }
      return currentRequest.promise;
    }

    const requestSequence = ++dashboardRequestSequenceRef.current;
    if (refresh === true) setRefreshing(true);
    else if (!dashboardRef.current) setLoading(true);

    let requestState: DashboardRequestInFlight;
    const promise = (async () => {
      try {
        const response = await getPurchaseInventoryDashboard(refresh);
        if (
          activePrincipalKeyRef.current !== requestPrincipalKey ||
          dashboardRequestSequenceRef.current !== requestSequence
        ) {
          return false;
        }
        const responseIds = new Set(
          response.requests.map((item) => item.recordId),
        );
        for (const [mutationId, items] of pendingApplicationItemsRef.current) {
          const remaining = items.filter(
            (item) => item.pendingSync || !responseIds.has(item.recordId),
          );
          if (remaining.length) {
            pendingApplicationItemsRef.current.set(mutationId, remaining);
          } else {
            pendingApplicationItemsRef.current.delete(mutationId);
          }
        }
        const withApplicationOverlay = replacePurchaseApplicationOverlay(
          response,
          [...pendingApplicationItemsRef.current.values()].flat(),
        );
        const visibleResponse = removeDeletedPurchaseRequests(
          withApplicationOverlay,
          deletedRequestIdsRef.current,
        );
        dashboardRef.current = visibleResponse;
        setDashboard(visibleResponse);
        setDashboardNotice(null);
        setLoadError(
          response.refreshState === 'partial' ||
            response.refreshState === 'stale'
            ? response.refreshError ||
                '采购数据暂未完全同步，当前显示最近一次可用结果。'
            : null,
        );
        return true;
      } catch {
        if (
          activePrincipalKeyRef.current !== requestPrincipalKey ||
          dashboardRequestSequenceRef.current !== requestSequence
        ) {
          return false;
        }
        setLoadError('采购数据读取失败，请检查网络或飞书数据源后重试。');
        if (dashboardRef.current?.refreshError?.includes('正在加载')) {
          setDashboardNotice('采购基础数据尚未同步，本次申请已先显示。');
        }
        return false;
      } finally {
        if (
          activePrincipalKeyRef.current === requestPrincipalKey &&
          dashboardRequestSequenceRef.current === requestSequence
        ) {
          setLoading(false);
          setRefreshing(false);
        }
        if (dashboardRequestInFlightRef.current === requestState) {
          dashboardRequestInFlightRef.current = null;
        }
      }
    })();
    requestState = {
      mode: refresh,
      principalKey: requestPrincipalKey,
      promise,
    };
    dashboardRequestInFlightRef.current = requestState;
    return promise;
  }, []);

  useEffect(() => {
    if (previousPrincipalKeyRef.current === principalKey) return;
    previousPrincipalKeyRef.current = principalKey;
    setApplicationDialogOpen(false);
    setCompletionDialogOpen(false);
    setApprovalItem(null);
    setWorkflowItem(null);
    setEditingRecord(null);
    setDeleteItems([]);
    dashboardRef.current = null;
    optimisticItemSnapshotsRef.current = new Map();
    deletedRequestIdsRef.current = new Set();
    pendingApplicationItemsRef.current = new Map();
    dashboardRequestInFlightRef.current = null;
    dashboardRequestSequenceRef.current += 1;
    setDashboard(null);
    setLoadError(null);
    setDashboardNotice(null);
    void loadDashboard('active');
  }, [loadDashboard, principalKey]);

  useEffect(() => {
    const refreshActiveDashboard = () => {
      if (document.visibilityState !== 'hidden') {
        void loadDashboard('active');
      }
    };
    refreshActiveDashboard();
    const activeTimer = window.setInterval(
      refreshActiveDashboard,
      ACTIVE_AUTO_REFRESH_MS,
    );
    const fullTimer = window.setInterval(
      () => void loadDashboard(false),
      AUTO_REFRESH_MS,
    );
    window.addEventListener('focus', refreshActiveDashboard);
    document.addEventListener('visibilitychange', refreshActiveDashboard);
    return () => {
      window.clearInterval(activeTimer);
      window.clearInterval(fullTimer);
      window.removeEventListener('focus', refreshActiveDashboard);
      document.removeEventListener('visibilitychange', refreshActiveDashboard);
    };
  }, [loadDashboard]);

  useEffect(() => {
    if (!canCreateApplication) setApplicationDialogOpen(false);
  }, [canCreateApplication]);

  useEffect(() => {
    if (editingRecord && !canEditRecord(editingRecord.item)) {
      setEditingRecord(null);
    }
  }, [canEditRecord, editingRecord]);

  useEffect(() => {
    if (approvalItem && !canApproveItem(approvalItem)) {
      setApprovalItem(null);
    }
  }, [approvalItem, canApproveItem]);

  useEffect(() => {
    if (
      deleteItems.length > 0 &&
      !deleteItems.every((item) => canDeleteRecord(item))
    ) {
      setDeleteItems([]);
    }
  }, [canDeleteRecord, deleteItems]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const legacyApplyRequested = params.get('apply') === '1';
    const directApplyRequested = isPurchaseApplicationDirectPath(
      location.pathname,
    );
    if (
      (legacyApplyRequested || directApplyRequested) &&
      canCreateApplication
    ) {
      setApplicationDialogOpen(true);
      if (legacyApplyRequested) {
        params.delete('apply');
        const query = params.toString();
        navigate(
          {
            pathname: location.pathname,
            search: query ? `?${query}` : '',
          },
          { replace: true },
        );
      }
    }
  }, [canCreateApplication, location.pathname, location.search, navigate]);

  const handleApplicationDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      setApplicationDialogOpen(nextOpen);
      if (!nextOpen && isPurchaseApplicationDirectPath(location.pathname)) {
        navigate(PURCHASE_INVENTORY_MANAGEMENT_PATH, { replace: true });
      }
    },
    [location.pathname, navigate],
  );

  const requests = dashboard?.requests ?? EMPTY_REQUESTS;
  const anomalies = useMemo(() => buildPurchaseAnomalies(requests), [requests]);
  const applicationItems = useMemo(
    () =>
      filterPurchaseApplicationItems(requests, applicationFilter, searchQuery),
    [applicationFilter, requests, searchQuery],
  );
  const executionItems = useMemo(
    () => filterPurchaseExecutionItems(requests, executionFilter, searchQuery),
    [executionFilter, requests, searchQuery],
  );
  const inboundItems = useMemo(
    () => filterPurchaseInboundItems(requests, searchQuery),
    [requests, searchQuery],
  );
  const metrics = dashboard?.summary;
  const stageCounts = metrics?.stageCounts ?? {
    application: 0,
    approval: 0,
    rejected: 0,
    executing: 0,
    receiving: 0,
    inbound: 0,
    stocked: 0,
  };
  const applicationStageCount = stageCounts.application + stageCounts.approval;
  const activeTotal =
    applicationStageCount +
    stageCounts.executing +
    stageCounts.receiving +
    stageCounts.inbound;
  const chartData: FlowChartItem[] = [
    {
      key: 'application-stage',
      label: '采购申请阶段',
      color: '#2F6BFF',
      value: applicationStageCount,
    },
    {
      key: 'executing',
      label: '采购执行',
      color: '#F97316',
      value: stageCounts.executing,
    },
    {
      key: 'receiving',
      label: '待收货签收',
      color: '#06B6D4',
      value: stageCounts.receiving,
    },
    {
      key: 'inbound',
      label: '签收待入库',
      color: '#10B981',
      value: stageCounts.inbound,
    },
  ].map((item) => ({
    ...item,
    percentage: activeTotal
      ? Math.round((item.value / activeTotal) * 1000) / 10
      : 0,
  }));
  const overviewCards: Array<{
    key: OverviewCardKey;
    label: string;
    detail: string;
    count: number;
    icon: LucideIcon;
    iconClass: string;
  }> = [
    {
      key: 'application-stage',
      label: '采购申请阶段',
      detail: `待提交 ${stageCounts.application} · 审批中 ${stageCounts.approval}`,
      count: applicationStageCount,
      icon: ClipboardCheck,
      iconClass: 'bg-blue-500 text-white shadow-blue-200',
    },
    {
      key: 'executing',
      label: '采购执行',
      detail: '询价、下单与合同',
      count: stageCounts.executing,
      icon: ShoppingCart,
      iconClass: 'bg-orange-500 text-white shadow-orange-200',
    },
    {
      key: 'receiving',
      label: '待收货签收',
      detail: '到货、质检与签收',
      count: stageCounts.receiving,
      icon: Truck,
      iconClass: 'bg-cyan-500 text-white shadow-cyan-200',
    },
    {
      key: 'completed',
      label: '采购完成',
      detail: '查看完成采购分析',
      count: stageCounts.stocked,
      icon: CheckCircle2,
      iconClass: 'bg-emerald-500 text-white shadow-emerald-200',
    },
  ];

  function handleOverviewCard(key: OverviewCardKey) {
    if (key === 'completed') {
      setCompletionDialogOpen(true);
      return;
    }
    if (key === 'application-stage') {
      setApplicationFilter('all');
      applicationListRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
      return;
    }

    setExecutionFilter(key);
    executionListRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  function handleLocateAnomaly(anomaly: PurchaseAnomalyItem) {
    if (!canEditRecord(anomaly.item)) return;
    setEditingRecord({ item: anomaly.item, issues: anomaly.issues });
  }

  function handleDeleteAnomaly(anomaly: PurchaseAnomalyItem) {
    requestDeletion([anomaly.item]);
  }

  function requestEdit(item: PurchaseInventoryRequestItem) {
    if (!canEditRecord(item)) return;
    setEditingRecord({ item });
  }

  function requestApproval(item: PurchaseInventoryRequestItem) {
    if (!canApproveItem(item)) return;
    setApprovalItem(item);
  }

  function requestOrder(item: PurchaseInventoryRequestItem) {
    if (item.stage !== 'executing' || !canOrderItem(item)) return;
    setWorkflowItem(item);
  }

  function requestReceipt(item: PurchaseInventoryRequestItem) {
    if (!canReceiveItem(item)) return;
    setWorkflowItem(item);
  }

  function openInbound(item: PurchaseInventoryRequestItem) {
    if (!item.executionRecordId) return;
    const nextSearchParams = new URLSearchParams();
    nextSearchParams.set('view', 'inbound');
    nextSearchParams.set('purchase', item.executionRecordId);
    navigate({
      pathname: '/inventory-management',
      search: `?${nextSearchParams.toString()}`,
    });
  }

  function requestDeletion(items: PurchaseInventoryRequestItem[]) {
    if (items.length === 0 || !items.every((item) => canDeleteRecord(item))) {
      return;
    }
    setDeleteItems(items);
  }

  function handleApplicationSubmissionStarted(
    mutationId: string,
    request: PurchaseApplicationBatchRequest,
  ) {
    const pendingItems = buildPendingPurchaseApplicationItems(
      request,
      mutationId,
    );
    pendingApplicationItemsRef.current.set(mutationId, pendingItems);
    const isColdStart = !dashboardRef.current;
    const baseline =
      dashboardRef.current ?? createEmptyPurchaseInventoryDashboard();
    const next = replacePurchaseApplicationOverlay(
      baseline,
      [...pendingApplicationItemsRef.current.values()].flat(),
    );
    dashboardRef.current = next;
    setDashboard(next);
    setLoading(false);
    if (isColdStart) {
      setDashboardNotice('采购基础数据正在同步，本次申请已先显示。');
    }
  }

  async function handleApplicationSubmissionSettled(
    mutationId: string,
    result: PurchaseApplicationSubmitResponse | null,
  ): Promise<boolean> {
    const pendingItems = pendingApplicationItemsRef.current.get(mutationId);
    if (result && pendingItems) {
      const reconciled = reconcilePendingPurchaseApplicationItems(
        pendingItems,
        result,
      );
      if (reconciled.length) {
        pendingApplicationItemsRef.current.set(mutationId, reconciled);
      } else {
        pendingApplicationItemsRef.current.delete(mutationId);
      }
    } else {
      pendingApplicationItemsRef.current.delete(mutationId);
    }
    updateDashboardState((current) =>
      replacePurchaseApplicationOverlay(
        current,
        [...pendingApplicationItemsRef.current.values()].flat(),
      ),
    );
    if (!result?.created.length) return true;
    return loadDashboard('active');
  }

  function requestForceRefresh() {
    if (!canForceRefresh) return;
    void loadDashboard(true);
  }

  async function refreshDashboardAfterMutation(): Promise<boolean> {
    return loadDashboard(true);
  }

  function applyOptimisticApproval(
    item: PurchaseInventoryRequestItem,
    decision: 'approved' | 'rejected',
  ) {
    rememberOptimisticSnapshot(item.recordId, item);
    updateDashboardState((current) =>
      applyPurchaseApprovalOptimisticUpdate(current, item.recordId, decision),
    );
  }

  function applyOptimisticReceipt(recordId: string) {
    const currentItem = dashboardRef.current?.requests.find(
      (item) =>
        item.recordId === recordId || item.executionRecordId === recordId,
    );
    if (currentItem) rememberOptimisticSnapshot(recordId, currentItem);
    updateDashboardState((current) =>
      applyPurchaseReceiptOptimisticUpdate(current, recordId),
    );
  }

  function applyOptimisticOrder(
    recordId: string,
    actualQuantity: number,
    actualAmount: number,
  ) {
    const currentItem = dashboardRef.current?.requests.find(
      (item) =>
        item.recordId === recordId || item.executionRecordId === recordId,
    );
    if (currentItem) rememberOptimisticSnapshot(recordId, currentItem);
    updateDashboardState((current) =>
      applyPurchaseOrderOptimisticUpdate(
        current,
        recordId,
        actualQuantity,
        actualAmount,
      ),
    );
  }

  async function settleOptimisticMutation(
    recordId: string,
    outcome: 'completed' | 'failed',
  ): Promise<boolean> {
    const originalItem = optimisticItemSnapshotsRef.current.get(recordId);
    if (outcome === 'failed' && originalItem) {
      updateDashboardState((current) =>
        restorePurchaseOptimisticItem(current, originalItem),
      );
    }
    optimisticItemSnapshotsRef.current.delete(recordId);
    return loadDashboard(true);
  }

  function rememberOptimisticSnapshot(
    recordId: string,
    item: PurchaseInventoryRequestItem,
  ) {
    if (!optimisticItemSnapshotsRef.current.has(recordId)) {
      optimisticItemSnapshotsRef.current.set(recordId, { ...item });
    }
  }

  function updateDashboardState(
    update: (current: PurchaseInventoryResponse) => PurchaseInventoryResponse,
  ) {
    setDashboard((current) => {
      if (!current) return current;
      const next = update(current);
      dashboardRef.current = next;
      return next;
    });
  }

  function handleRecordsDeleted() {
    const deletedIds = deleteItems.map((item) => item.recordId);
    deletedRequestIdsRef.current = new Set([
      ...deletedRequestIdsRef.current,
      ...deletedIds,
    ]);
    setDashboard((current) => {
      if (!current) return current;
      const next = removeDeletedPurchaseRequests(current, deletedIds);
      dashboardRef.current = next;
      return next;
    });
    setDeleteItems([]);
    requestForceRefresh();
  }

  return (
    <div className="min-h-screen bg-[#f4f7fc] text-slate-900">
      <ManagementHeader
        activePage="purchase"
        searchValue={searchQuery}
        searchPlaceholder="搜索单号、物品、申请人、供应商"
        sourceLabel="飞书多维表 · 采购申请与采购执行实时数据"
        updatedAt={
          renderedDashboardNotice
            ? '基础数据同步中'
            : dashboard
              ? formatUpdatedAt(dashboard.generatedAt)
              : '同步中'
        }
        refreshing={refreshing}
        filterLabel="定位采购筛选"
        onFilter={() => handleOverviewCard('application-stage')}
        onSearchChange={setSearchQuery}
        onRefresh={requestForceRefresh}
        actions={
          canCreateApplication ? (
            <Button
              type="button"
              onClick={() => setApplicationDialogOpen(true)}
              className="h-11 rounded-lg bg-white px-4 font-semibold text-blue-700 shadow-sm hover:bg-blue-50 hover:text-blue-800"
            >
              <ClipboardPlus className="h-4 w-4" />
              新建采购申请
            </Button>
          ) : null
        }
      />

      <main className="mx-auto max-w-[1920px] space-y-5 px-4 py-5 sm:px-6 xl:px-8">
        {renderedDashboardNotice && (
          <div
            aria-live="polite"
            className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span>{renderedDashboardNotice}</span>
          </div>
        )}

        {renderedLoadError && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <span className="flex min-w-0 items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="truncate">{renderedLoadError}</span>
            </span>
            <button
              type="button"
              onClick={requestForceRefresh}
              className="shrink-0 font-semibold text-rose-700 hover:text-rose-900"
            >
              重新加载
            </button>
          </div>
        )}

        {renderedLoading && !dashboard ? (
          <DashboardSkeleton />
        ) : (
          <>
            <section
              aria-label="采购经营概览"
              className="grid items-stretch gap-5 xl:grid-cols-2"
            >
              <div
                aria-label="采购阶段概览"
                className="grid gap-3 sm:grid-cols-2"
              >
                {overviewCards.map((card) => {
                  const Icon = card.icon;
                  return (
                    <button
                      key={card.key}
                      type="button"
                      onClick={() => handleOverviewCard(card.key)}
                      className="group min-h-[150px] min-w-0 rounded-lg border border-slate-200 bg-white p-5 text-left shadow-[0_6px_20px_rgba(42,68,112,0.07)] transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-[0_10px_26px_rgba(42,68,112,0.11)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
                    >
                      <span className="flex items-start gap-4">
                        <span
                          className={cn(
                            'inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-lg shadow-lg',
                            card.iconClass,
                          )}
                        >
                          <Icon className="h-7 w-7" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-slate-600">
                            {card.label}
                          </span>
                          <span className="mt-1 flex items-end gap-1">
                            <strong className="text-3xl font-bold tabular-nums text-slate-950">
                              {card.count.toLocaleString('zh-CN')}
                            </strong>
                            <span className="pb-1 text-xs text-slate-400">
                              项
                            </span>
                          </span>
                          <span className="mt-2 block truncate text-xs text-slate-500">
                            {card.detail}
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <StageDistributionChart data={chartData} total={activeTotal} />
            </section>

            <PurchaseAnomalyPanel
              anomalies={anomalies}
              canDeleteItem={canDeleteRecord}
              canEditItem={canEditRecord}
              onEdit={handleLocateAnomaly}
              onDeleteAnomaly={handleDeleteAnomaly}
              onDeleteSelected={requestDeletion}
            />

            <section ref={applicationListRef} className="scroll-mt-4">
              <ActivityPanel
                mode="application"
                title="采购申请阶段清单"
                subtitle="采购申请与审批节点"
                items={applicationItems}
                filters={applicationFilters}
                activeFilter={applicationFilter}
                onFilterChange={(value) =>
                  setApplicationFilter(value as PurchaseApplicationFilter)
                }
                emptyText="暂无匹配的采购申请"
                canDeleteItem={canDeleteRecord}
                canEditItem={canEditRecord}
                canApproveItem={canApproveItem}
                onEditItem={requestEdit}
                onApproveItem={requestApproval}
                onDeleteItem={(item) => requestDeletion([item])}
                onDeleteSelected={requestDeletion}
              />
            </section>

            <section ref={executionListRef} className="scroll-mt-4">
              <ActivityPanel
                mode="execution"
                title="采购执行动态明细"
                subtitle="采购执行与收货签收节点"
                items={executionItems}
                filters={executionFilters}
                activeFilter={executionFilter}
                onFilterChange={(value) =>
                  setExecutionFilter(value as PurchaseExecutionFilter)
                }
                emptyText="暂无匹配的采购执行记录"
                canDeleteItem={canDeleteRecord}
                canEditItem={canEditRecord}
                canOrderItem={canOrderItem}
                canReceiveItem={canReceiveItem}
                onOrderItem={requestOrder}
                onReceiveItem={requestReceipt}
                onEditItem={requestEdit}
                onDeleteItem={(item) => requestDeletion([item])}
                onDeleteSelected={requestDeletion}
              />
            </section>

            <SourceStatus dashboard={dashboard} />

            <section className="scroll-mt-4">
              <ActivityPanel
                mode="inbound"
                title="签收待入库明细"
                subtitle="已完成签收，等待库房入库确认"
                items={inboundItems}
                filters={inboundFilters}
                activeFilter="all"
                onFilterChange={() => undefined}
                emptyText="暂无签收待入库记录"
                canDeleteItem={canDeleteRecord}
                canEditItem={canEditRecord}
                onEditItem={requestEdit}
                onOpenItem={openInbound}
                onDeleteItem={(item) => requestDeletion([item])}
                onDeleteSelected={requestDeletion}
              />
            </section>
          </>
        )}
      </main>

      {canCreateApplication ? (
        <PurchaseApplicationDialog
          open={principalMatchesRenderedData && applicationDialogOpen}
          onOpenChange={handleApplicationDialogOpenChange}
          onSubmissionStarted={handleApplicationSubmissionStarted}
          onSubmissionSettled={handleApplicationSubmissionSettled}
        />
      ) : null}
      <PurchaseOnlineApprovalDialog
        item={principalMatchesRenderedData ? approvalItem : null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setApprovalItem(null);
        }}
        onOptimisticDecision={applyOptimisticApproval}
        onTaskSettled={settleOptimisticMutation}
      />
      <PurchaseWorkflowDialog
        open={Boolean(principalMatchesRenderedData && workflowItem)}
        item={workflowItem}
        recordId={
          principalMatchesRenderedData
            ? (workflowItem?.executionRecordId ?? null)
            : null
        }
        canOperate={Boolean(
          workflowItem &&
          ((workflowItem.stage === 'executing' && canOrderItem(workflowItem)) ||
            (workflowItem.stage === 'receiving' &&
              canReceiveItem(workflowItem))),
        )}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setWorkflowItem(null);
        }}
        onUpdated={() => void refreshDashboardAfterMutation()}
        onOrderAccepted={applyOptimisticOrder}
        onOrderTaskSettled={settleOptimisticMutation}
        onReceiptAccepted={applyOptimisticReceipt}
        onReceiptTaskSettled={settleOptimisticMutation}
      />
      <PurchaseRecordEditDialog
        item={
          principalMatchesRenderedData ? (editingRecord?.item ?? null) : null
        }
        issues={
          principalMatchesRenderedData ? editingRecord?.issues : undefined
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setEditingRecord(null);
        }}
        onSaved={refreshDashboardAfterMutation}
      />
      <PurchaseCompletionAnalysisDialog
        open={principalMatchesRenderedData && completionDialogOpen}
        dashboard={dashboard}
        canDelete={canDeleteCompletedRecords}
        onOpenChange={setCompletionDialogOpen}
        onDeleteSelected={requestDeletion}
      />
      {principalMatchesRenderedData && deleteItems.length > 0 && (
        <PurchaseDeleteDialog
          open={deleteItems.length > 0}
          items={deleteItems}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setDeleteItems([]);
          }}
          onDeleted={handleRecordsDeleted}
        />
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5" aria-label="采购数据加载中">
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="h-[150px] animate-pulse rounded-lg border border-slate-200 bg-white"
            />
          ))}
        </div>
        <div className="flex min-h-[312px] items-center justify-center rounded-lg border border-slate-200 bg-white text-sm text-slate-500">
          <Loader2 className="mr-2 h-5 w-5 animate-spin text-blue-500" />
          正在同步采购数据
        </div>
      </div>
    </div>
  );
}

interface ActivityPanelProps {
  mode: 'application' | 'execution' | 'inbound';
  title: string;
  subtitle: string;
  items: PurchaseInventoryRequestItem[];
  filters: Array<{ key: string; label: string }>;
  activeFilter: string;
  onFilterChange: (value: string) => void;
  emptyText: string;
  canDeleteItem: (item: PurchaseInventoryRequestItem) => boolean;
  canEditItem: (item: PurchaseInventoryRequestItem) => boolean;
  canApproveItem?: (item: PurchaseInventoryRequestItem) => boolean;
  canOrderItem?: (item: PurchaseInventoryRequestItem) => boolean;
  canReceiveItem?: (item: PurchaseInventoryRequestItem) => boolean;
  onOrderItem?: (item: PurchaseInventoryRequestItem) => void;
  onReceiveItem?: (item: PurchaseInventoryRequestItem) => void;
  onOpenItem?: (item: PurchaseInventoryRequestItem) => void;
  onEditItem: (item: PurchaseInventoryRequestItem) => void;
  onApproveItem?: (item: PurchaseInventoryRequestItem) => void;
  onDeleteItem: (item: PurchaseInventoryRequestItem) => void;
  onDeleteSelected: (items: PurchaseInventoryRequestItem[]) => void;
}

function ActivityPanel({
  mode,
  title,
  subtitle,
  items,
  filters,
  activeFilter,
  onFilterChange,
  emptyText,
  canDeleteItem,
  canEditItem,
  canApproveItem,
  canOrderItem,
  canReceiveItem,
  onOrderItem,
  onReceiveItem,
  onOpenItem,
  onEditItem,
  onApproveItem,
  onDeleteItem,
  onDeleteSelected,
}: ActivityPanelProps) {
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const pageSize = 10;
  const purchaseGroups = useMemo(() => groupPurchaseOrderItems(items), [items]);
  const totalPages = Math.max(1, Math.ceil(purchaseGroups.length / pageSize));
  const visibleGroups = purchaseGroups.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );
  const visibleItems = visibleGroups.flatMap((group) => group.items);
  const deletableItems = items.filter(canDeleteItem);
  const deletableIds = deletableItems.map((item) => item.recordId);
  const visibleDeletableIds = visibleItems
    .filter(canDeleteItem)
    .map((item) => item.recordId);
  const selectedItems = deletableItems.filter((item) =>
    selectedIds.has(item.recordId),
  );
  const visibleSelectedCount = visibleDeletableIds.filter((id) =>
    selectedIds.has(id),
  ).length;
  const allVisibleSelected =
    visibleDeletableIds.length > 0 &&
    visibleSelectedCount === visibleDeletableIds.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  const hasDeletableItems = deletableItems.length > 0;
  const hasRecordActions = items.some(
    (item) =>
      canEditItem(item) ||
      canDeleteItem(item) ||
      Boolean(canApproveItem?.(item)),
  );
  const isApplication = mode === 'application';
  const isInbound = mode === 'inbound';
  const PanelIcon = isApplication
    ? ClipboardCheck
    : isInbound
      ? PackageSearch
      : ShoppingCart;
  const totalAmount = items.reduce(
    (sum, item) => sum + (item.actualAmount ?? item.estimatedAmount),
    0,
  );

  useEffect(() => {
    setPage(1);
  }, [activeFilter, purchaseGroups.length]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  useEffect(() => {
    setSelectedIds((current) => prunePurchaseSelection(current, deletableIds));
  }, [deletableIds.join('|')]);

  function toggleItem(recordId: string, checked: boolean) {
    if (!deletableIds.includes(recordId)) return;
    setSelectedIds((current) =>
      toggleVisiblePurchaseSelection(current, [recordId], checked),
    );
  }

  function toggleVisible(checked: boolean) {
    setSelectedIds((current) =>
      toggleVisiblePurchaseSelection(current, visibleDeletableIds, checked),
    );
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_6px_20px_rgba(42,68,112,0.06)]">
      <div
        className={cn(
          'border-b px-5 py-4',
          isApplication
            ? 'border-blue-100 bg-blue-50/35'
            : isInbound
              ? 'border-emerald-100 bg-emerald-50/35'
              : 'border-orange-100 bg-orange-50/35',
        )}
      >
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                isApplication
                  ? 'bg-blue-500 text-white shadow-sm shadow-blue-200'
                  : isInbound
                    ? 'bg-emerald-500 text-white shadow-sm shadow-emerald-200'
                    : 'bg-orange-500 text-white shadow-sm shadow-orange-200',
              )}
            >
              <PanelIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-slate-900">{title}</h2>
                <span
                  className={cn(
                    'rounded-md px-2 py-0.5 text-xs font-semibold',
                    isApplication
                      ? 'bg-blue-100 text-blue-700'
                      : isInbound
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-orange-100 text-orange-700',
                  )}
                >
                  {purchaseGroups.length} 单 · {items.length} 条
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {hasDeletableItems && selectedItems.length > 0 && (
              <div className="flex shrink-0 items-center gap-2 rounded-lg border border-rose-200 bg-white px-2 py-1.5 shadow-sm">
                <span className="pl-1 text-xs font-semibold text-rose-600">
                  已选 {selectedItems.length} 条
                </span>
                <button
                  type="button"
                  onClick={() => onDeleteSelected(selectedItems)}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-rose-500 px-2.5 text-xs font-semibold text-white transition hover:bg-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除所选
                </button>
              </div>
            )}
            <div className="shrink-0 text-xs text-slate-500">
              当前金额{' '}
              <strong className="font-semibold tabular-nums text-slate-800">
                {formatCurrency(totalAmount)}
              </strong>
            </div>
            <div
              role="tablist"
              aria-label={`${title}筛选`}
              className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1"
            >
              {filters.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  role="tab"
                  aria-selected={activeFilter === filter.key}
                  onClick={() => onFilterChange(filter.key)}
                  className={cn(
                    'h-8 shrink-0 rounded-md px-3 text-xs font-semibold transition',
                    activeFilter === filter.key
                      ? cn(
                          'bg-white shadow-sm',
                          isApplication
                            ? 'text-blue-600'
                            : isInbound
                              ? 'text-emerald-600'
                              : 'text-orange-600',
                        )
                      : 'text-slate-500 hover:text-slate-800',
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {items.length ? (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table
              className={cn(
                'w-full border-collapse text-left text-sm',
                isApplication
                  ? 'min-w-[1400px]'
                  : isInbound
                    ? 'min-w-[1180px]'
                    : 'min-w-[1300px]',
              )}
            >
              <thead className="bg-slate-50/90 text-xs font-semibold text-slate-500">
                <tr>
                  {hasDeletableItems && (
                    <th className="w-12 px-4 py-2.5 text-center">
                      <Checkbox
                        aria-label="选择当前页全部记录"
                        checked={
                          allVisibleSelected
                            ? true
                            : someVisibleSelected
                              ? 'indeterminate'
                              : false
                        }
                        onCheckedChange={(checked) =>
                          toggleVisible(checked === true)
                        }
                      />
                    </th>
                  )}
                  <th className="px-5 py-2.5">采购单号</th>
                  <th className="px-4 py-2.5">
                    {isApplication ? '申请人 / 楼栋' : '采购人 / 供应商'}
                  </th>
                  <th className="px-4 py-2.5">物资名称 / 分类</th>
                  <th className="px-4 py-2.5">规格型号</th>
                  <th className="px-4 py-2.5 text-right">数量 / 单位</th>
                  {isApplication && <th className="px-4 py-2.5">供应商</th>}
                  {isApplication && <th className="px-4 py-2.5">采购方式</th>}
                  <th className="px-4 py-2.5 text-right">金额</th>
                  {!isApplication && !isInbound && (
                    <th className="px-4 py-2.5">采购链接</th>
                  )}
                  <th className="px-4 py-2.5">
                    {isApplication ? '当前状态' : '当前节点'}
                  </th>
                  <th className="px-5 py-2.5">计划到货</th>
                  {hasRecordActions && (
                    <th className="w-24 px-4 py-2.5 text-center">操作</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {visibleGroups.flatMap((group) =>
                  group.items.map((item, itemIndex) => {
                    const itemCanDelete = canDeleteItem(item);
                    const itemCanEdit = canEditItem(item);
                    const itemCanApprove = Boolean(canApproveItem?.(item));
                    const itemCanOrder = Boolean(canOrderItem?.(item));
                    const itemCanReceive = Boolean(canReceiveItem?.(item));
                    const itemCanOpen = Boolean(
                      onOpenItem && item.executionRecordId,
                    );
                    const isFirstItem = itemIndex === 0;
                    const rowSpan = group.items.length;
                    const actor = isApplication
                      ? item.requester || '申请人待补充'
                      : item.purchaser || '采购人待确定';
                    const actorDetail = isApplication
                      ? item.building || '楼栋未匹配'
                      : item.supplier || '暂无';
                    return (
                      <tr
                        key={item.recordId}
                        className={cn(
                          'border-b border-slate-100 transition last:border-b-0',
                          isApplication
                            ? 'hover:bg-blue-50/45'
                            : isInbound
                              ? 'hover:bg-emerald-50/45'
                              : 'hover:bg-orange-50/45',
                        )}
                      >
                        {hasDeletableItems && (
                          <td
                            className="w-12 px-4 py-2.5 text-center"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            {itemCanDelete ? (
                              <Checkbox
                                aria-label={`选择 ${item.requestCode || item.title}`}
                                checked={selectedIds.has(item.recordId)}
                                onCheckedChange={(checked) =>
                                  toggleItem(item.recordId, checked === true)
                                }
                              />
                            ) : null}
                          </td>
                        )}
                        {isFirstItem && (
                          <td
                            rowSpan={rowSpan}
                            className="max-w-48 align-middle px-5 py-2.5 text-center"
                          >
                            <span
                              className="block truncate font-semibold text-slate-800"
                              title={group.requestCode || '待生成'}
                            >
                              {group.requestCode || '待生成'}
                            </span>
                            <span className="mt-0.5 block text-[11px] text-slate-400">
                              {rowSpan} 项 · {formatDate(item.createdAt)}
                            </span>
                          </td>
                        )}
                        <td className="max-w-44 px-4 py-2.5">
                          <PersonChatLink
                            name={actor}
                            chatUrl={
                              isApplication
                                ? item.requesterChatUrl
                                : item.purchaserChatUrl
                            }
                          />
                          <span
                            className="mt-0.5 block truncate text-xs text-slate-400"
                            title={actorDetail}
                          >
                            {actorDetail}
                          </span>
                        </td>
                        <td className="max-w-64 px-4 py-2.5">
                          <span
                            className="block truncate font-medium text-slate-800"
                            title={item.title}
                          >
                            {item.title}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-slate-400">
                            {[item.specialty, item.primaryCategory]
                              .filter(Boolean)
                              .join(' · ') || '分类待补充'}
                          </span>
                        </td>
                        <td className="max-w-52 px-4 py-2.5 text-slate-600">
                          <span
                            className="block truncate"
                            title={item.specification || '未填写'}
                          >
                            {item.specification || '未填写'}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums text-slate-700">
                          {formatQuantity(item)}
                        </td>
                        {isApplication && (
                          <td className="max-w-40 px-4 py-2.5 text-slate-600">
                            <span
                              className="block truncate"
                              title={item.supplier || '暂无'}
                            >
                              {item.supplier || '暂无'}
                            </span>
                          </td>
                        )}
                        {isApplication && (
                          <td className="max-w-36 px-4 py-2.5">
                            <PurchaseMethodBadge method={item.purchaseMethod} />
                          </td>
                        )}
                        <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums text-slate-800">
                          {formatCurrency(
                            item.actualAmount ?? item.estimatedAmount,
                          )}
                        </td>
                        {!isApplication && !isInbound && (
                          <td className="max-w-40 px-4 py-2.5">
                            <PurchaseLinks links={item.purchaseLinks || []} />
                          </td>
                        )}
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            <StageBadge
                              item={item}
                              canApprove={itemCanApprove}
                              onApprove={() => onApproveItem?.(item)}
                              canOrder={itemCanOrder}
                              onOrder={() => onOrderItem?.(item)}
                              canReceive={itemCanReceive}
                              onReceive={() => onReceiveItem?.(item)}
                              canOpen={itemCanOpen}
                              onOpen={() => onOpenItem?.(item)}
                            />
                            {isApplication && item.approvalTarget && (
                              <span
                                className="max-w-32 truncate text-xs font-medium text-slate-500"
                                title={`申请审批 · ${item.approvalTarget}`}
                              >
                                申请审批 · {item.approvalTarget}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-5 py-2.5 text-slate-500">
                          {formatDate(item.expectedArrival)}
                        </td>
                        {hasRecordActions && (
                          <td
                            className="px-4 py-2.5"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <div className="flex items-center justify-center gap-1">
                              {itemCanApprove && (
                                <button
                                  type="button"
                                  aria-label={`进入审批 ${item.requestCode || item.title}`}
                                  title="进入审批"
                                  onClick={() => onApproveItem?.(item)}
                                  className="inline-flex h-8 items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30"
                                >
                                  <ShieldCheck className="h-3.5 w-3.5" />
                                  审批
                                </button>
                              )}
                              {itemCanEdit && (
                                <button
                                  type="button"
                                  aria-label={`编辑 ${item.requestCode || item.title}`}
                                  title="编辑"
                                  onClick={() => onEditItem(item)}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-blue-200 bg-white text-blue-600 transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              )}
                              {itemCanDelete && (
                                <button
                                  type="button"
                                  aria-label={`删除 ${item.requestCode || item.title}`}
                                  title="删除"
                                  onClick={() => onDeleteItem(item)}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-rose-200 bg-white text-rose-600 transition hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 p-4 md:hidden">
            {hasDeletableItems && (
              <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <Checkbox
                    aria-label="选择当前页全部记录"
                    checked={
                      allVisibleSelected
                        ? true
                        : someVisibleSelected
                          ? 'indeterminate'
                          : false
                    }
                    onCheckedChange={(checked) =>
                      toggleVisible(checked === true)
                    }
                  />
                  选择本页
                </label>
                <span className="text-xs text-slate-400">
                  {visibleSelectedCount} / {visibleDeletableIds.length}
                </span>
              </div>
            )}
            {visibleGroups.map((group) => (
              <section
                key={group.requestCode || group.items[0]?.recordId}
                className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50/70"
              >
                <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-slate-400">
                      采购单号
                    </p>
                    <p className="mt-0.5 truncate text-sm font-semibold text-slate-800">
                      {group.requestCode || '待生成'}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">
                    {group.items.length} 项
                  </span>
                </div>
                <div className="grid gap-3 p-3">
                  {group.items.map((item) => {
                    const itemCanDelete = canDeleteItem(item);
                    const itemCanEdit = canEditItem(item);
                    const itemCanApprove = Boolean(canApproveItem?.(item));
                    const itemCanOrder = Boolean(canOrderItem?.(item));
                    const itemCanReceive = Boolean(canReceiveItem?.(item));
                    const itemCanOpen = Boolean(
                      onOpenItem && item.executionRecordId,
                    );
                    const actor = isApplication
                      ? item.requester || '申请人待补充'
                      : item.purchaser || '采购人待确定';
                    return (
                      <article
                        key={item.recordId}
                        className={cn(
                          'min-w-0 w-full rounded-lg border bg-white p-4 shadow-sm',
                          itemCanDelete && selectedIds.has(item.recordId)
                            ? 'border-rose-200 ring-1 ring-rose-100'
                            : isApplication
                              ? 'border-blue-100'
                              : isInbound
                                ? 'border-emerald-100'
                                : 'border-orange-100',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-3">
                            {itemCanDelete && (
                              <span
                                className="pt-0.5"
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                              >
                                <Checkbox
                                  aria-label={`选择 ${item.requestCode || item.title}`}
                                  checked={selectedIds.has(item.recordId)}
                                  onCheckedChange={(checked) =>
                                    toggleItem(item.recordId, checked === true)
                                  }
                                />
                              </span>
                            )}
                            <div className="min-w-0">
                              <h3 className="truncate text-sm font-semibold text-slate-900">
                                {item.title}
                              </h3>
                            </div>
                          </div>
                          <StageBadge
                            item={item}
                            canApprove={itemCanApprove}
                            onApprove={() => onApproveItem?.(item)}
                            canOrder={itemCanOrder}
                            onOrder={() => onOrderItem?.(item)}
                            canReceive={itemCanReceive}
                            onReceive={() => onReceiveItem?.(item)}
                            canOpen={itemCanOpen}
                            onOpen={() => onOpenItem?.(item)}
                          />
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                          <Meta
                            label={isApplication ? '申请人' : '采购人'}
                            value={
                              <PersonChatLink
                                name={actor}
                                chatUrl={
                                  isApplication
                                    ? item.requesterChatUrl
                                    : item.purchaserChatUrl
                                }
                              />
                            }
                          />
                          <Meta
                            label={isApplication ? '楼栋' : '供应商'}
                            value={
                              isApplication
                                ? item.building || '未匹配'
                                : item.supplier || '暂无'
                            }
                          />
                          <Meta
                            label="规格型号"
                            value={item.specification || '未填写'}
                          />
                          <Meta label="数量" value={formatQuantity(item)} />
                          {isApplication && (
                            <div className="min-w-0">
                              <span className="block text-slate-400">
                                采购方式
                              </span>
                              <span className="mt-1 block">
                                <PurchaseMethodBadge
                                  method={item.purchaseMethod}
                                />
                              </span>
                            </div>
                          )}
                          <Meta
                            label="金额"
                            value={formatCurrency(
                              item.actualAmount ?? item.estimatedAmount,
                            )}
                          />
                          {!isApplication && !isInbound && (
                            <div className="min-w-0">
                              <span className="block text-slate-400">
                                采购链接
                              </span>
                              <span className="mt-1 block">
                                <PurchaseLinks
                                  links={item.purchaseLinks || []}
                                />
                              </span>
                            </div>
                          )}
                          <Meta
                            label="计划到货"
                            value={formatDate(item.expectedArrival)}
                          />
                          {isApplication && item.approvalTarget && (
                            <Meta
                              label="审批责任"
                              value={`申请审批 · ${item.approvalTarget}`}
                            />
                          )}
                        </div>
                        {(itemCanApprove || itemCanEdit || itemCanDelete) && (
                          <div
                            className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-3"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            {itemCanApprove && (
                              <button
                                type="button"
                                aria-label={`进入审批 ${item.requestCode || item.title}`}
                                onClick={() => onApproveItem?.(item)}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 text-xs font-semibold text-amber-700 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30"
                              >
                                <ShieldCheck className="h-3.5 w-3.5" />
                                审批
                              </button>
                            )}
                            {itemCanEdit && (
                              <button
                                type="button"
                                aria-label={`编辑 ${item.requestCode || item.title}`}
                                onClick={() => onEditItem(item)}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-600 transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                                编辑
                              </button>
                            )}
                            {itemCanDelete && (
                              <button
                                type="button"
                                aria-label={`删除 ${item.requestCode || item.title}`}
                                onClick={() => onDeleteItem(item)}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-rose-200 bg-white px-3 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                删除
                              </button>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
            <span>
              共 {purchaseGroups.length} 单 · {items.length} 条
              {hasDeletableItems &&
                selectedItems.length > 0 &&
                ` · 已选 ${selectedItems.length} 条`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                title="上一页"
                aria-label="上一页"
                disabled={page === 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                className={cn(
                  'inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 disabled:cursor-not-allowed disabled:opacity-40',
                  isApplication
                    ? 'hover:border-blue-200 hover:text-blue-600'
                    : isInbound
                      ? 'hover:border-emerald-200 hover:text-emerald-600'
                      : 'hover:border-orange-200 hover:text-orange-600',
                )}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span
                className={cn(
                  'min-w-14 text-center font-semibold',
                  isApplication
                    ? 'text-blue-600'
                    : isInbound
                      ? 'text-emerald-600'
                      : 'text-orange-600',
                )}
              >
                {page} / {totalPages}
              </span>
              <button
                type="button"
                title="下一页"
                aria-label="下一页"
                disabled={page === totalPages}
                onClick={() =>
                  setPage((current) => Math.min(totalPages, current + 1))
                }
                className={cn(
                  'inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 disabled:cursor-not-allowed disabled:opacity-40',
                  isApplication
                    ? 'hover:border-blue-200 hover:text-blue-600'
                    : isInbound
                      ? 'hover:border-emerald-200 hover:text-emerald-600'
                      : 'hover:border-orange-200 hover:text-orange-600',
                )}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="flex min-h-60 flex-col items-center justify-center px-4 text-center">
          <PackageSearch className="h-8 w-8 text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-500">{emptyText}</p>
        </div>
      )}
    </div>
  );
}

function StageBadge({
  item,
  canApprove = false,
  canOrder = false,
  canReceive = false,
  canOpen = false,
  onApprove,
  onOrder,
  onReceive,
  onOpen,
}: {
  item: PurchaseInventoryRequestItem;
  canApprove?: boolean;
  canOrder?: boolean;
  canReceive?: boolean;
  canOpen?: boolean;
  onApprove?: () => void;
  onOrder?: () => void;
  onReceive?: () => void;
  onOpen?: () => void;
}) {
  const stage = activeStages.find((entry) => entry.key === item.stage);
  const Icon = stage?.icon ?? CheckCircle2;
  const badgeClassName = cn(
    'inline-flex max-w-36 items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold',
    stage?.panelClass ?? 'border-slate-200 bg-slate-50 text-slate-600',
    (canApprove || canOrder || canReceive || canOpen) &&
      'transition hover:-translate-y-0.5 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
  );
  const content = (
    <>
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{item.statusLabel}</span>
    </>
  );
  if (canApprove || canOrder || canReceive || canOpen) {
    const actionLabel = canApprove
      ? '审批'
      : canOrder
        ? '下单'
        : canReceive
          ? '签收'
          : '入库';
    const actionTitle = canApprove
      ? '打开采购审批'
      : canOrder
        ? '填写下单信息'
        : canReceive
          ? '打开到货签收'
          : '前往库存管理入库';
    return (
      <button
        type="button"
        aria-label={`${actionLabel} ${item.requestCode || item.title}`}
        title={actionTitle}
        className={badgeClassName}
        onClick={
          canApprove
            ? onApprove
            : canOrder
              ? onOrder
              : canReceive
                ? onReceive
                : onOpen
        }
      >
        {content}
      </button>
    );
  }
  return <span className={badgeClassName}>{content}</span>;
}

function PurchaseLinks({ links }: { links: string[] }) {
  if (!links.length) {
    return <span className="text-xs text-slate-400">未填写</span>;
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {links.slice(0, 3).map((link, index) => (
        <a
          key={`${link}-${index}`}
          href={link}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 transition hover:bg-blue-100"
          onClick={(event) => event.stopPropagation()}
        >
          {`链接${index + 1}`}
        </a>
      ))}
    </span>
  );
}

function PersonChatLink({
  name,
  chatUrl,
}: {
  name: string;
  chatUrl: string | null;
}) {
  if (!chatUrl) {
    return (
      <span className="block truncate font-semibold text-slate-800">
        {name}
      </span>
    );
  }

  return (
    <a
      href={chatUrl}
      target="_blank"
      rel="noreferrer noopener"
      title={`与${name}发起飞书对话`}
      aria-label={`与${name}发起飞书对话`}
      className="inline-block max-w-full truncate border-b border-blue-300 font-semibold leading-5 text-slate-800 transition-colors hover:border-blue-600 hover:text-blue-700 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
      onClick={(event) => event.stopPropagation()}
    >
      {name}
    </a>
  );
}

function PurchaseMethodBadge({ method }: { method: string }) {
  const label = method || '未填写';
  const color =
    method === '驳回'
      ? 'red'
      : method.includes('需求自采')
        ? 'emerald'
        : method === '综合采购'
          ? 'blue'
          : 'neutral';

  return (
    <Badge
      color={color}
      className="max-w-full rounded-md px-2.5 py-1 font-semibold"
      title={label}
    >
      <span className="truncate">{label}</span>
    </Badge>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="block text-slate-400">{label}</span>
      <span className="mt-1 block truncate font-medium text-slate-700">
        {value}
      </span>
    </div>
  );
}

function PurchaseAnomalyPanel({
  anomalies,
  canDeleteItem,
  canEditItem,
  onEdit,
  onDeleteAnomaly,
  onDeleteSelected,
}: {
  anomalies: PurchaseAnomalyItem[];
  canDeleteItem: (item: PurchaseInventoryRequestItem) => boolean;
  canEditItem: (item: PurchaseInventoryRequestItem) => boolean;
  onEdit: (anomaly: PurchaseAnomalyItem) => void;
  onDeleteAnomaly: (anomaly: PurchaseAnomalyItem) => void;
  onDeleteSelected: (items: PurchaseInventoryRequestItem[]) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const deletableAnomalies = anomalies.filter((anomaly) =>
    canDeleteItem(anomaly.item),
  );
  const anomalyIds = deletableAnomalies.map((anomaly) => anomaly.item.recordId);
  const selectedItems = deletableAnomalies
    .filter((anomaly) => selectedIds.has(anomaly.item.recordId))
    .map((anomaly) => anomaly.item);
  const allSelected =
    anomalyIds.length > 0 && selectedItems.length === anomalyIds.length;
  const someSelected = selectedItems.length > 0 && !allSelected;

  useEffect(() => {
    setSelectedIds((current) => prunePurchaseSelection(current, anomalyIds));
  }, [anomalyIds.join('|')]);

  function toggleAnomaly(recordId: string, checked: boolean) {
    if (!anomalyIds.includes(recordId)) return;
    setSelectedIds((current) =>
      toggleVisiblePurchaseSelection(current, [recordId], checked),
    );
  }

  function toggleAllAnomalies(checked: boolean) {
    setSelectedIds((current) =>
      toggleVisiblePurchaseSelection(current, anomalyIds, checked),
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-rose-200 bg-white shadow-[0_6px_20px_rgba(42,68,112,0.06)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-100 bg-rose-50/55 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-600">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-950">
                采购异常项目
              </h2>
              <span className="rounded-md bg-rose-100 px-2 py-0.5 text-xs font-bold tabular-nums text-rose-700">
                {anomalies.length} 项
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              自动检查物品名称、数量、楼栋、申请人和计数单位
            </p>
          </div>
        </div>
        {deletableAnomalies.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-9 items-center gap-2 rounded-md border border-rose-200 bg-white px-3 text-xs font-semibold text-slate-600">
              <Checkbox
                aria-label="选择全部采购异常"
                checked={
                  allSelected ? true : someSelected ? 'indeterminate' : false
                }
                onCheckedChange={(checked) =>
                  toggleAllAnomalies(checked === true)
                }
              />
              全选异常
            </label>
            {selectedItems.length > 0 && (
              <button
                type="button"
                onClick={() => onDeleteSelected(selectedItems)}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-rose-500 px-3 text-xs font-semibold text-white transition hover:bg-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除所选（{selectedItems.length}）
              </button>
            )}
          </div>
        )}
      </div>

      {anomalies.length ? (
        <div className="max-h-80 overflow-y-auto">
          {anomalies.map((anomaly) => {
            const itemCanDelete = canDeleteItem(anomaly.item);
            const itemCanEdit = canEditItem(anomaly.item);
            return (
              <div
                key={anomaly.item.recordId}
                className={cn(
                  'grid items-center gap-4 border-b border-slate-100 px-5 py-3.5 last:border-b-0',
                  deletableAnomalies.length > 0
                    ? 'grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[auto_minmax(220px,1fr)_minmax(150px,0.55fr)_minmax(260px,1fr)_auto]'
                    : 'grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(220px,1fr)_minmax(150px,0.55fr)_minmax(260px,1fr)_auto]',
                )}
              >
                {deletableAnomalies.length > 0 && (
                  <div className="flex items-center justify-center">
                    {itemCanDelete ? (
                      <Checkbox
                        aria-label={`选择异常 ${anomaly.item.requestCode || anomaly.item.title}`}
                        checked={selectedIds.has(anomaly.item.recordId)}
                        onCheckedChange={(checked) =>
                          toggleAnomaly(anomaly.item.recordId, checked === true)
                        }
                      />
                    ) : null}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {anomaly.item.title || '未命名物品'}
                  </p>
                  <p className="mt-1 truncate text-xs text-slate-400">
                    {anomaly.item.requestCode || '单号待生成'}
                  </p>
                </div>
                <div className="hidden min-w-0 md:block">
                  <p className="truncate text-xs font-medium text-slate-700">
                    {anomaly.item.requester || '申请人未填写'}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-slate-400">
                    {anomaly.item.building || '楼栋未匹配'}
                  </p>
                </div>
                <div className="hidden flex-wrap gap-1.5 md:flex">
                  {anomaly.issues.map((issue) => (
                    <span
                      key={issue}
                      className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700"
                    >
                      {issue}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  {itemCanEdit && (
                    <button
                      type="button"
                      aria-label={`编辑 ${anomaly.item.requestCode || anomaly.item.title}`}
                      onClick={() => onEdit(anomaly)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-blue-200 bg-white px-2.5 text-xs font-semibold text-blue-700 transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      编辑
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {itemCanDelete && (
                    <button
                      type="button"
                      aria-label={`删除 ${anomaly.item.requestCode || anomaly.item.title}`}
                      title="删除"
                      onClick={() => onDeleteAnomaly(anomaly)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-rose-200 bg-white text-rose-600 transition hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div
                  className={cn(
                    'flex flex-wrap gap-1.5 md:hidden',
                    deletableAnomalies.length > 0 ? 'col-span-3' : 'col-span-2',
                  )}
                >
                  {anomaly.issues.map((issue) => (
                    <span
                      key={issue}
                      className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700"
                    >
                      {issue}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-28 items-center justify-center px-5 text-sm font-medium text-emerald-700">
          当前采购数据完整，暂无异常项目
        </div>
      )}
    </section>
  );
}

function StageDistributionChart({
  data,
  total,
}: {
  data: FlowChartItem[];
  total: number;
}) {
  return (
    <div className="h-full min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-[0_6px_20px_rgba(42,68,112,0.06)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-slate-900">采购阶段分布</h2>
          <p className="mt-1 text-xs text-slate-500">当前未闭环采购业务</p>
        </div>
        <span className="rounded-md bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600">
          {total} 项进行中
        </span>
      </div>
      <div className="mt-3 grid min-h-[250px] items-center gap-5 sm:grid-cols-[minmax(210px,0.9fr)_minmax(0,1fr)]">
        <div className="mx-auto h-[250px] w-full max-w-[290px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="label"
                innerRadius={67}
                outerRadius={96}
                paddingAngle={2}
                stroke="#ffffff"
                strokeWidth={2}
                isAnimationActive={false}
              >
                {data.map((entry) => (
                  <Cell key={entry.key} fill={entry.color} />
                ))}
              </Pie>
              <text
                x="50%"
                y="46%"
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-slate-950 text-[28px] font-bold"
              >
                {total}
              </text>
              <text
                x="50%"
                y="59%"
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-slate-400 text-[12px] font-medium"
              >
                进行中
              </text>
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="grid gap-3 sm:grid-cols-1 2xl:grid-cols-2">
          {data.map((entry) => (
            <div
              key={entry.key}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs"
            >
              <span
                className="h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: entry.color }}
              />
              <span className="truncate text-slate-600">{entry.label}</span>
              <span className="whitespace-nowrap font-semibold tabular-nums text-slate-800">
                {entry.value}{' '}
                <span className="font-normal text-slate-400">
                  ({entry.percentage}%)
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SourceStatus({
  dashboard,
}: {
  dashboard: PurchaseInventoryResponse | null;
}) {
  if (!dashboard) return null;
  const sources = [
    { label: '采购申请表', status: dashboard.sectionStatus.submissions },
    { label: '采购执行表', status: dashboard.sectionStatus.executions },
    { label: '物品类别表', status: dashboard.sectionStatus.catalog },
    { label: '库存台账表', status: dashboard.sectionStatus.inventory },
    { label: '入库表', status: dashboard.sectionStatus.inbound },
    { label: '出库表', status: dashboard.sectionStatus.outbound },
  ];
  const unavailable = sources.filter(
    (item) => !item.status.configured || Boolean(item.status.message),
  );
  if (!unavailable.length) return null;

  const hasReadFailure = unavailable.some(
    (item) => item.status.configured && Boolean(item.status.message),
  );

  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 text-xs',
        hasReadFailure
          ? 'border-rose-200 bg-rose-50 text-rose-800'
          : 'border-amber-200 bg-amber-50 text-amber-800',
      )}
    >
      <strong>
        {hasReadFailure ? '数据源读取异常：' : '数据源配置待完成：'}
      </strong>
      <span>
        {unavailable
          .map(
            (item) =>
              `${item.label}：${item.status.message || '数据源暂不可用'}`,
          )
          .join('；')}
      </span>
    </div>
  );
}
