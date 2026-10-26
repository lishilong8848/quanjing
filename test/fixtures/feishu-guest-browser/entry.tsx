import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AccessProvider, useAccess } from '../../../client/src/access/AccessProvider';
import { GlobalUserControl, UnifiedAccessControl } from '../../../client/src/components/Layout';
import RouteAccessGuard from '../../../client/src/access/RouteAccessGuard';
import { Button } from '../../../client/src/components/ui/button';
import './styles.css';

function Fixture() {
  const access = useAccess();
  return <>
    <header className="flex items-center justify-between border-b bg-card p-4">
      <span className="font-semibold">南通基地运营平台 · 登录验收</span>
      <div className="flex items-center gap-3"><UnifiedAccessControl compact /><GlobalUserControl /></div>
    </header>
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">具名游客登录</h1>
      <p role="status">姓名：{access.displayName || '未登录'}；权限：{access.role}；编辑：{String(access.capabilities.canEdit)}；删除：{String(access.capabilities.canDelete)}</p>
      <div className="flex flex-wrap gap-4">
        <a href="/fixture/guest-callback">模拟无授权人员扫码成功</a>
        <a href="/fixture/admin-callback">模拟管理员扫码成功</a>
        <a href="/fixture/guest-expiring">模拟即将到期的游客</a>
        <Link to="/system-configuration">直接进入配置页</Link>
        <Link to="/construction-management">直接进入施工管理</Link>
        <Link to="/nantong-base">返回公开页</Link>
      </div>
      <Button onClick={() => void access.refreshSession()}>重新确认身份</Button>
      <Routes><Route element={<RouteAccessGuard />}>
        <Route path="/system-configuration" element={<p>管理员配置内容</p>} />
        <Route path="/construction-management" element={<p>施工管理内容</p>} />
      </Route></Routes>
      <Toaster />
    </main>
  </>;
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><AccessProvider><Fixture /></AccessProvider></BrowserRouter>);
