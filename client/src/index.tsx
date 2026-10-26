import './polyfills';
import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from 'react-error-boundary';
import { isChangeRequestDirectPath } from './navigation/change-request-route';
import { isEmployeeOnboardingDirectPath } from './navigation/employee-onboarding-route';
import { isAlarmTagAnomaliesDirectPath } from './navigation/alarm-tag-anomalies-route';
import './index.css';

const base = String(process.env.CLIENT_BASE_PATH || '').replace(
  /^\/+|\/+$/g,
  '',
);
const pathname =
  base && window.location.pathname.startsWith(`/${base}/`)
    ? window.location.pathname.slice(base.length + 1)
    : window.location.pathname;
const Entry = React.lazy(() =>
  isChangeRequestDirectPath(pathname)
    ? import('./pages/ChangeRequestApply')
    : isEmployeeOnboardingDirectPath(pathname)
      ? import('./pages/EmployeeOnboarding')
      : isAlarmTagAnomaliesDirectPath(pathname)
        ? import('./pages/AlarmTagAnomalies')
        : import('./app-entry'),
);

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary
    fallbackRender={() => (
      <main className="min-h-dvh bg-background p-6" role="alert">
        <p>页面加载失败，请重试。</p>
        <button
          className="mt-4 text-primary underline"
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </main>
    )}
  >
    <Suspense
      fallback={
        <p className="p-6" role="status">
          页面加载中…
        </p>
      }
    >
      <Entry />
    </Suspense>
  </ErrorBoundary>,
);
