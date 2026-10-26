import React, { Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { Toaster } from 'sonner';
import { AccessProvider, useAccess } from '../../../client/src/access/AccessProvider';
import RouteAccessGuard from '../../../client/src/access/RouteAccessGuard';
import { GlobalAppShell } from '../../../client/src/components/GlobalAppShell';
import TodayOperationsPanorama from '../../../client/src/pages/TodayOperationsPanorama';
import { getAlarmReviewPeople } from '../../../client/src/pages/TodayOperationsPanorama/alarm-review-api';
import '../../../client/src/index.css';

// Test-only observation: it reads the real context and calls the real API; never sets either.
function Observation() {
  const access = useAccess();
  useEffect(() => {
    Object.assign(window, { __alarmEntryObservation: {
      role: access.role, loading: access.isLoading,
      readReviewPeople: () => getAlarmReviewPeople().then(() => true).catch(() => false),
    } });
  }, [access.role, access.isLoading]);
  return null;
}
function ContentBoundary() {
  const location = useLocation();
  return <ErrorBoundary resetKeys={[location.pathname, location.search, location.hash]}
    fallbackRender={({ resetErrorBoundary }) => <main role="alert">当前页面暂时不可用<button onClick={resetErrorBoundary}>重试当前页面</button></main>}>
    <Suspense fallback={<p role="status">页面加载中…</p>}><Outlet /></Suspense>
  </ErrorBoundary>;
}
// AppContainer's light visual shell only. Platform AuthProvider, telemetry, safety,
// inspector, QueryProvider and IframeBridge are excluded, not presented as tested.
function LightShell({ children }: React.PropsWithChildren) {
  return <><div data-fixture-shell="light">{children}</div><Toaster /></>;
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter><LightShell><ErrorBoundary fallback={<main role="alert">页面加载失败</main>}>
    <AccessProvider><Observation /><Routes>
      <Route element={<RouteAccessGuard />}><Route element={<GlobalAppShell />}>
        <Route element={<ContentBoundary />}><Route element={<Outlet />}>
          <Route path="/today-operations-panorama" element={<TodayOperationsPanorama />} />
        </Route></Route>
      </Route></Route>
      <Route path="*" element={<Navigate to="/today-operations-panorama" replace />} />
    </Routes></AccessProvider>
  </ErrorBoundary></LightShell></BrowserRouter>,
);
