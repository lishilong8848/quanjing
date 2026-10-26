import '../../client/src/polyfills';
import './meeting-browser.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AccessProvider } from '../../client/src/access/AccessProvider';
import { GlobalNavigation } from '../../client/src/components/GlobalNavigation';
import MeetingManagement from '../../client/src/pages/MeetingManagement';

if (location.port === '4203') {
  document.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button');
    if (button?.textContent?.trim() !== '保存' ||
        !button.closest('[role="dialog"]')?.textContent?.includes('修改待办')) return;
    const started = performance.now();
    const observer = new MutationObserver(() => {
      if (document.querySelector('[role="dialog"]')) return;
      document.documentElement.dataset.qaActionFeedbackMs = String(performance.now() - started);
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 3000);
  }, true);
}

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <AccessProvider>
      <GlobalNavigation />
      <div className="pt-16">
        <MeetingManagement />
      </div>
    </AccessProvider>
  </BrowserRouter>,
);
