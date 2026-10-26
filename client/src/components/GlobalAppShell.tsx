import type { CSSProperties } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { isControlledScreenshotPageRequest } from '@/access/access-policy';
import { GlobalNavigation } from '@/components/GlobalNavigation';
import { NantongAssistantHost } from '@/components/NantongAssistantHost';
import { GLOBAL_NAVIGATION_HEIGHT_PX } from '@/navigation/global-navigation-layout';

export function shouldSuppressGlobalChrome(
  pathname: string,
  search: string,
): boolean {
  const normalizedPath = pathname.toLowerCase().replace(/\/+$/, '') || '/';

  return (
    normalizedPath === '/calendar-embed' ||
    isControlledScreenshotPageRequest(pathname, search)
  );
}

export function GlobalAppShell() {
  const location = useLocation();
  const suppressChrome = shouldSuppressGlobalChrome(
    location.pathname,
    location.search,
  );

  if (suppressChrome) {
    return (
      <NantongAssistantHost visible={false}>
        <Outlet />
      </NantongAssistantHost>
    );
  }

  return (
    <NantongAssistantHost>
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
          <Outlet />
        </div>
      </div>
    </NantongAssistantHost>
  );
}
