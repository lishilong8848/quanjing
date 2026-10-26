import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AccessProvider } from '../../../client/src/access/AccessProvider';
import { InventoryMovementPage } from '../../../client/src/pages/InventoryManagement/InventoryMovementPage';
import '../inventory-stocktake-browser/styles.css';

function Fixture() {
  const [createRequested, setCreateRequested] = useState(false);
  const [storageFault, setStorageFault] = useState(false);
  useEffect(() => {
    const setItem = Storage.prototype.setItem;
    if (storageFault)
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('inventory-management:'))
          throw new DOMException('合成测试：存储不可用', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    return () => {
      Storage.prototype.setItem = setItem;
    };
  }, [storageFault]);
  const [type, setType] = useState<'inbound' | 'outbound'>(() =>
    new URLSearchParams(location.search).get('type') === 'outbound'
      ? 'outbound'
      : 'inbound',
  );
  return (
    <>
      <div className="fixture-label">
        出入库回归验收 · 合成测试数据 · 不写真实库存
        <button
          onClick={() => {
            history.replaceState(null, '', '?type=inbound');
            setType('inbound');
          }}
        >
          测试入库
        </button>
        <button
          onClick={() => {
            history.replaceState(null, '', '?type=outbound');
            setType('outbound');
          }}
        >
          测试出库
        </button>
        <button onClick={() => setCreateRequested(true)}>
          新增{type === 'inbound' ? '入库' : '出库'}
        </button>
        <label>
          <input
            type="checkbox"
            checked={storageFault}
            onChange={(event) => setStorageFault(event.target.checked)}
          />
          模拟保存失败
        </label>
        <button
          onClick={() => {
            for (const storage of [localStorage, sessionStorage]) {
              for (const key of Object.keys(storage))
                if (key.startsWith('inventory-management:'))
                  storage.removeItem(key);
            }
          }}
        >
          清理测试缓存
        </button>
      </div>
      <main className="p-6">
        <InventoryMovementPage
          key={type}
          type={type}
          searchQuery=""
          canConfirmOutbound
          createRequested={createRequested}
          onCreateRequestHandled={() => setCreateRequested(false)}
        />
      </main>
      <Toaster />
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
