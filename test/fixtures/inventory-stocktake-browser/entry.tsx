import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AccessProvider } from '../../../client/src/access/AccessProvider';
import InventoryManagementPage from '../../../client/src/pages/InventoryManagement';
import './performance';
import './styles.css';
createRoot(document.getElementById('root')!).render(
  <>
    <div className="fixture-label">盘点开发验收 · 测试数据</div>
    <BrowserRouter>
      <AccessProvider>
        <Routes>
          <Route path="*" element={<InventoryManagementPage />} />
        </Routes>
      </AccessProvider>
    </BrowserRouter>
    <output id="fixture-performance" aria-label="测试反馈耗时" />
  </>,
);
