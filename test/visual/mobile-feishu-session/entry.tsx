import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { AccessProvider, useAccess } from '../../../client/src/access/AccessProvider';
import RouteAccessGuard from '../../../client/src/access/RouteAccessGuard';
import { UnifiedAccessControl } from '../../../client/src/components/Layout';
import './styles.css';

declare global {
  interface Window { __fixtureBusiness: { mounts: number; requests: number } }
  interface Window { __fixtureSessionWarnings: number; __fixtureSessionWarningDismissals: number }
}
window.__fixtureBusiness = { mounts: 0, requests: 0 };
window.__fixtureSessionWarnings = 0;
window.__fixtureSessionWarningDismissals = 0;
const originalWarning = toast.warning, originalDismiss = toast.dismiss;
toast.warning = (...args: Parameters<typeof toast.warning>) => { window.__fixtureSessionWarnings++; return originalWarning(...args); };
toast.dismiss = (...args: Parameters<typeof toast.dismiss>) => { window.__fixtureSessionWarningDismissals++; return originalDismiss(...args); };

function BusinessPage() {
  const [draft, setDraft] = React.useState('');
  React.useEffect(() => {
    window.__fixtureBusiness.mounts += 1;
    window.__fixtureBusiness.requests += 1;
    void fetch('/api/fixture/business').then(response => {
      if (!response.ok) throw new Error('Synthetic business request failed');
    });
  }, []);
  return <section data-testid="business-page" className="mx-auto mt-5 w-full max-w-md rounded-lg border p-6">
    <h1 className="text-xl font-semibold">合成业务页面</h1>
    <p className="mt-3 text-sm text-muted-foreground">登录身份确认后才会读取本机合成数据。</p>
    <label className="mt-3 block text-sm">合成未保存草稿<input data-testid="draft" className="mt-2 w-full rounded border p-2" value={draft} onChange={event => setDraft(event.target.value)} /></label>
  </section>;
}

function Fixture() {
  const access = useAccess();
  const navigate = useNavigate();
  return <>
    <header className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      <UnifiedAccessControl />
      <button onClick={() => access.requestLogin()}>打开登录</button>
      <button data-testid="callback" onClick={() => navigate(`${location.pathname}?feishu_auth=success&fixture=kept#kept`)}>模拟授权回跳</button>
      <output data-testid="identity" className="break-words">{access.isLoading || access.isConfirmingIdentity ? '确认中' : `${access.displayName || '未登录'} / ${access.role}`}</output>
    </header>
    <Routes><Route element={<RouteAccessGuard />}><Route path="*" element={<BusinessPage />} /></Route></Routes>
    <Toaster />
  </>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><AccessProvider><Fixture /></AccessProvider></BrowserRouter>);
