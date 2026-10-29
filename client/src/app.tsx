import React, { useEffect } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import RouteAccessGuard from './access/RouteAccessGuard';
import { GlobalAppShell } from './components/GlobalAppShell';
import Layout from './components/Layout';
import { getNavigationBrowserTitle } from './navigation/page-switcher';
import { PURCHASE_APPLICATION_DIRECT_PATH } from './navigation/purchase-application-route';
import NotFound from './pages/NotFound/NotFound';

const AliMonthlyReportPage = React.lazy(
  () => import('./pages/AliMonthlyReport'),
);
const SystemMonthlyReportPage = React.lazy(
  () => import('./pages/SystemMonthlyReport'),
);
const CampusOperationsDashboardPage = React.lazy(
  () => import('./pages/CampusOperationsDashboard'),
);
const TodayOperationsPanoramaPage = React.lazy(
  () => import('./pages/TodayOperationsPanorama'),
);
const MonthlyOperationsPage = React.lazy(
  () => import('./pages/MonthlyOperations'),
);
const TrainingCertificationManagementPage = React.lazy(
  () => import('./pages/TrainingCertificationManagement'),
);
const EquipmentLedgerManagementPage = React.lazy(
  () => import('./pages/EquipmentLedgerManagement'),
);
const ThresholdManagementPage = React.lazy(() => import('./pages/ThresholdManagement'));
const RiskInspectionDashboardPage = React.lazy(
  () => import('./pages/RiskInspectionDashboard'),
);
const MonthlyAlarmOverviewPage = React.lazy(
  () => import('./pages/MonthlyAlarmOverview'),
);
const ConstructionManagementPage = React.lazy(
  () => import('./pages/ConstructionManagement'),
);
const DutyStaffRepairPage = React.lazy(() => import('./pages/DutyStaffRepair'));
const EquipmentPatrolDashboardPage = React.lazy(
  () => import('./pages/EquipmentPatrolDashboard'),
);
const ExhaustValveMapPage = React.lazy(() => import('./pages/ExhaustValveMap'));
const MonthlySchedule = React.lazy(() => import('./pages/MonthlySchedule'));
const MbtiAssessmentFlow = React.lazy(() => import('./pages/MbtiAssessment/MbtiAssessmentFlow'));
const OvertimeConfirmationPage = React.lazy(
  () => import('./pages/OvertimeConfirmation'),
);
const NantongBaseHomePage = React.lazy(() => import('./pages/NantongBaseHome'));
const OrganizationPage = React.lazy(
  () => import('./pages/OrganizationPage/OrganizationPage'),
);
const OperationsArchitecturePage = React.lazy(
  () => import('./pages/OperationsArchitecture'),
);
const OperationsKnowledgeBasePage = React.lazy(
  () => import('./pages/OperationsKnowledgeBase'),
);
const MeetingManagementPage = React.lazy(
  () => import('./pages/MeetingManagement'),
);
const PurchaseInventoryManagementPage = React.lazy(
  () => import('./pages/PurchaseInventoryManagement'),
);
const InventoryManagementPage = React.lazy(
  () => import('./pages/InventoryManagement'),
);
const OperationsToolsManagementPage = React.lazy(
  () => import('./pages/OperationsToolsManagement'),
);
const ContractManagementPage = React.lazy(
  () => import('./pages/ContractManagement'),
);
const FrameworkContractsPage = React.lazy(
  () => import('./pages/ContractManagement/FrameworkContractsPage'),
);
const TodayFocusChecklistPage = React.lazy(
  () => import('./pages/TodayFocusChecklist'),
);

const APP_BROWSER_TITLE = '世纪互联-南通基地';
const SystemConfigurationPage = React.lazy(() => import('./pages/SystemConfiguration'));
const PersonalCenterPage = React.lazy(() => import('./pages/PersonalCenter'));

function RouteLoadingFallback() {
  return (
    <main
      className="flex min-h-[50vh] items-center justify-center bg-slate-50 px-4"
      aria-busy="true"
    >
      <p
        className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-sm"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        页面加载中…
      </p>
    </main>
  );
}

const DYNAMIC_IMPORT_ERROR_PATTERNS = [
  /Loading (?:CSS )?chunk \S+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Unable to preload CSS for/i,
] as const;

function getStringErrorProperty(
  error: unknown,
  property: 'name' | 'message' | 'code',
) {
  if (typeof error !== 'object' || error === null) return '';
  const value = (error as Record<string, unknown>)[property];
  return typeof value === 'string' ? value : '';
}

function isDynamicImportLoadError(error: unknown) {
  const name = getStringErrorProperty(error, 'name');
  const code = getStringErrorProperty(error, 'code');
  const message =
    typeof error === 'string'
      ? error
      : getStringErrorProperty(error, 'message');

  return (
    name === 'ChunkLoadError' ||
    code === 'CSS_CHUNK_LOAD_FAILED' ||
    DYNAMIC_IMPORT_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  );
}

function RouteLoadErrorFallback({ error }: FallbackProps) {
  if (!isDynamicImportLoadError(error)) {
    throw error;
  }

  return (
    <main className="flex min-h-[50vh] items-center justify-center bg-slate-50 px-4">
      <section
        className="w-full max-w-md rounded-lg border border-red-200 bg-white p-6 text-center shadow-sm"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        <h1 className="text-lg font-semibold text-slate-900">
          页面资源加载失败
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          系统可能已更新，请刷新页面以加载最新版本。
        </p>
        <button
          type="button"
          className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          onClick={() => window.location.reload()}
        >
          刷新页面
        </button>
      </section>
    </main>
  );
}

function RouteContentErrorFallback({
  error,
  resetErrorBoundary,
}: FallbackProps) {
  if (isDynamicImportLoadError(error)) {
    return (
      <RouteLoadErrorFallback
        error={error}
        resetErrorBoundary={resetErrorBoundary}
      />
    );
  }

  return (
    <main className="flex min-h-[50vh] items-center justify-center bg-slate-50 px-4">
      <section
        className="w-full max-w-md rounded-lg border border-amber-200 bg-white p-6 text-center shadow-sm"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        <h1 className="text-lg font-semibold text-slate-900">
          当前页面暂时不可用
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          页面数据或组件加载异常，请稍后重试。
        </p>
        <button
          type="button"
          className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          onClick={resetErrorBoundary}
        >
          重试当前页面
        </button>
      </section>
    </main>
  );
}

function useLockedDocumentTitle() {
  const location = useLocation();

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const browserTitle =
      (location.pathname === '/personal-center' ? '个人主页 · 南通基地运营平台' : getNavigationBrowserTitle(location.pathname)) || APP_BROWSER_TITLE;

    const applyTitle = () => {
      if (document.title !== browserTitle) {
        document.title = browserTitle;
      }
    };

    applyTitle();

    const titleElement =
      document.querySelector('title') ??
      document.head.appendChild(document.createElement('title'));
    const observer =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(applyTitle)
        : null;
    observer?.observe(titleElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    const titleRefreshTimers = [100, 300, 800, 1500, 3000].map((delay) =>
      window.setTimeout(applyTitle, delay),
    );
    const titleRefreshInterval = window.setInterval(applyTitle, 2000);

    window.addEventListener('focus', applyTitle);
    document.addEventListener('visibilitychange', applyTitle);

    return () => {
      observer?.disconnect();
      titleRefreshTimers.forEach((timer) => window.clearTimeout(timer));
      window.clearInterval(titleRefreshInterval);
      window.removeEventListener('focus', applyTitle);
      document.removeEventListener('visibilitychange', applyTitle);
    };
  }, [location.pathname]);
}

function RouteContentBoundary() {
  const location = useLocation();

  return (
    <ErrorBoundary
      FallbackComponent={RouteContentErrorFallback}
      resetKeys={[location.pathname, location.search, location.hash]}
    >
      <React.Suspense fallback={<RouteLoadingFallback />}>
        <Outlet />
      </React.Suspense>
    </ErrorBoundary>
  );
}

const RoutesComponent = () => {
  useLockedDocumentTitle();
  const location = useLocation();

  return (
    <ErrorBoundary
      FallbackComponent={RouteLoadErrorFallback}
      resetKeys={[location.pathname]}
    >
      <Routes>
        <Route index element={<Navigate to="/nantong-base" replace />} />
        <Route element={<RouteContentBoundary />}>
          <Route
            path="/overtime-confirmation"
            element={<OvertimeConfirmationPage />}
          />
        </Route>
        <Route element={<RouteAccessGuard />}>
          <Route element={<GlobalAppShell />}>
            <Route element={<RouteContentBoundary />}>
              <Route element={<Layout />}>
                {/* 兼容旧路由：/monthly-schedule 也指向月度值班一览 */}
                <Route path="/monthly-schedule" element={<MonthlySchedule />} />
                <Route path="/system-configuration" element={<SystemConfigurationPage />} />
                <Route path="/personal-center" element={<PersonalCenterPage />} />
                <Route path="/mbti-assessment" element={<MbtiAssessmentFlow />} />
                <Route
                  path="/monthly-schedule/apply/leave"
                  element={<MonthlySchedule />}
                />
                <Route
                  path="/monthly-schedule/apply/overtime"
                  element={<MonthlySchedule />}
                />
                {/* 南通基地官网首页模块 */}
                <Route path="/nantong-base" element={<NantongBaseHomePage />} />
                {/* 南通全景运维调度中心业务架构图 */}
                <Route
                  path="/operations-architecture"
                  element={<OperationsArchitecturePage />}
                />
                {/* 运维藏经阁 */}
                <Route
                  path="/meeting-management"
                  element={<MeetingManagementPage />}
                />
                <Route
                  path="/meeting-management/nantong-weekly"
                  element={<MeetingManagementPage />}
                />
                <Route
                  path="/meeting-management/history"
                  element={<MeetingManagementPage />}
                />
                <Route path="/meeting-management/training" element={<MeetingManagementPage />} />
                <Route path="/meeting-management/ali-meetings" element={<MeetingManagementPage />} />
                <Route
                  path="/operations-kb"
                  element={<OperationsKnowledgeBasePage />}
                />
                <Route
                  path="/operations-kb/results"
                  element={<OperationsKnowledgeBasePage />}
                />
                <Route
                  path="/operations-kb/records/:recordId"
                  element={<OperationsKnowledgeBasePage />}
                />
                {/* 组织架构页面 */}
                <Route path="/organization" element={<OrganizationPage />} />
                {/* 值班人员修正页面 */}
                <Route
                  path="/duty-staff-repair"
                  element={<DutyStaffRepairPage />}
                />
                {/* 今日值班页面 */}
                <Route
                  path="/today-duty"
                  element={<Navigate to="/" replace />}
                />
                {/* 施工管理页面 */}
                <Route
                  path="/construction-management"
                  element={<ConstructionManagementPage />}
                />
                <Route
                  path="/equipment-patrol-dashboard"
                  element={<EquipmentPatrolDashboardPage />}
                />
                <Route
                  path="/purchase-inventory-management"
                  element={<PurchaseInventoryManagementPage />}
                />
                <Route
                  path={PURCHASE_APPLICATION_DIRECT_PATH}
                  element={<PurchaseInventoryManagementPage />}
                />
                <Route
                  path="/inventory-management"
                  element={<InventoryManagementPage />}
                />
                <Route
                  path="/operations-tools-management"
                  element={<OperationsToolsManagementPage />}
                />
                <Route
                  path="/contract-management"
                  element={<ContractManagementPage />}
                />
                <Route
                  path="/contract-management/frameworks"
                  element={<FrameworkContractsPage />}
                />
                <Route
                  path="/ali-monthly-report"
                  element={<AliMonthlyReportPage />}
                />
                <Route
                  path="/system-monthly-report"
                  element={<SystemMonthlyReportPage />}
                />
              </Route>
              <Route element={<StandaloneAccessLayout />}>
                <Route
                  path="/today-focus-checklist"
                  element={<TodayFocusChecklistPage />}
                />
                <Route
                  path="/campus-operations-dashboard"
                  element={<CampusOperationsDashboardPage />}
                />
                <Route
                  path="/today-operations-panorama"
                  element={<TodayOperationsPanoramaPage />}
                />
                <Route
                  path="/monthly-operations"
                  element={<MonthlyOperationsPage />}
                />
                <Route
                  path="/training-certification-management"
                  element={<TrainingCertificationManagementPage />}
                />
                <Route
                  path="/campus-certificate-dashboard"
                  element={
                    <Navigate
                      replace
                      to="/training-certification-management?module=certificate"
                    />
                  }
                />
                <Route
                  path="/campus-training-dashboard"
                  element={
                    <Navigate
                      replace
                      to="/training-certification-management?module=training"
                    />
                  }
                />
                <Route
                  path="/equipment-lifecycle-dashboard"
                  element={<Navigate replace to="/equipment-ledger-management?view=lifecycle" />}
                />
                <Route
                  path="/equipment-ledger-management"
                  element={<EquipmentLedgerManagementPage />}
                />
                <Route path="/threshold-management" element={<ThresholdManagementPage />} />
                <Route
                  path="/risk-inspection-dashboard"
                  element={
                    <RiskInspectionDashboardPage key="risk-inspection-dashboard" />
                  }
                />
                <Route
                  path="/quality-assessment"
                  element={
                    <RiskInspectionDashboardPage
                      key="quality-assessment"
                      standaloneQuality
                    />
                  }
                />
                <Route
                  path="/monthly-alarm-overview"
                  element={<MonthlyAlarmOverviewPage />}
                />
                <Route
                  path="/exhaust-valve-map"
                  element={<ExhaustValveMapPage />}
                />
                <Route
                  path="/schedule-calendar"
                  element={<TodayFocusChecklistPage />}
                />
                <Route
                  path="/calendar-embed"
                  element={<TodayFocusChecklistPage />}
                />
              </Route>
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ErrorBoundary>
  );
};

function StandaloneAccessLayout() {
  return <Outlet />;
}

export default RoutesComponent;
