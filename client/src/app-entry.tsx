import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';

import { AppContainer } from '@lark-apaas/client-toolkit/components/AppContainer';
import { ErrorRender } from '@lark-apaas/client-toolkit/components/ErrorRender';

import { AccessProvider } from './access/AccessProvider';
import RoutesComponent from './app.tsx';

const CLIENT_BASE_PATH = process.env.CLIENT_BASE_PATH || '/';

export default function MainApp() {
  return (
    <BrowserRouter basename={CLIENT_BASE_PATH}>
      <AppContainer defaultTheme="light">
        <ErrorBoundary
          fallbackRender={({ error, resetErrorBoundary }) => (
            <ErrorRender
              error={error as Error}
              resetErrorBoundary={resetErrorBoundary}
            />
          )}
        >
          <AccessProvider>
            <RoutesComponent />
          </AccessProvider>
        </ErrorBoundary>
      </AppContainer>
    </BrowserRouter>
  );
}
