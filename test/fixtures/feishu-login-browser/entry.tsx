import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import {
  AccessProvider,
  useAccess,
} from '../../../client/src/access/AccessProvider';
import './styles.css';
import { GlobalNavigation } from '../../../client/src/components/GlobalNavigation';
import RouteAccessGuard from '../../../client/src/access/RouteAccessGuard';

function Fixture() {
  const access = useAccess();
  return (
    <>
      <GlobalNavigation />
      <main className="mx-auto max-w-4xl p-4 pt-20">
        <header className="flex items-center justify-between rounded-lg border bg-card p-4">
          <h1>飞书登录验收</h1>
        </header>
        <p className="mt-4" role="status">
          当前权限：{access.role}；编辑：{String(access.capabilities.canEdit)}
          ；删除：{String(access.capabilities.canDelete)}
        </p>
        <p>楼栋范围：{access.purchaseBuilding || '无楼栋限制'}</p>
        <p>登录姓名：{access.displayName || '未提供'}</p>
        <a href="/fixture/admin-callback">模拟马进宇授权回调（隔离测试）</a>
        <a className="block" href="/fixture/identities">
          查看本次授权身份（隔离测试）
        </a>
        <a className="block" href="/construction-management">
          直接访问施工管理（隔离测试）
        </a>
        <Routes>
          <Route element={<RouteAccessGuard />}>
            <Route
              path="/construction-management"
              element={<p>施工管理已授权内容（隔离测试）</p>}
            />
          </Route>
          <Route path="*" element={null} />
        </Routes>
        <Toaster />
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <AccessProvider>
      <Fixture />
    </AccessProvider>
  </BrowserRouter>,
);
