import '../../client/src/polyfills';
import './threshold-browser.css';
import React, { type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AccessProvider } from '../../client/src/access/AccessProvider';
import { GlobalNavigation } from '../../client/src/components/GlobalNavigation';
import Layout from '../../client/src/components/Layout';
import { GLOBAL_NAVIGATION_HEIGHT_PX } from '../../client/src/navigation/global-navigation-layout';
import ThresholdManagement from '../../client/src/pages/ThresholdManagement';
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <AccessProvider>
      <div
        className="global-app-shell min-h-dvh bg-background"
        style={
          {
            '--global-navigation-height': `${GLOBAL_NAVIGATION_HEIGHT_PX}px`,
          } as CSSProperties
        }
      >
        <GlobalNavigation />
        <div className="global-app-content min-h-[calc(100dvh-var(--global-navigation-height))] pt-16">
          <Routes>
            <Route element={<Layout />}>
              <Route
                path="/threshold-management"
                element={<ThresholdManagement />}
              />
            </Route>
          </Routes>
        </div>
      </div>
      <Toaster />
    </AccessProvider>
  </BrowserRouter>,
);
