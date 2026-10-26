import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssetDetail } from '../../../client/src/pages/EquipmentLedgerManagement/LedgerDialogs';
import type { LedgerAsset } from '@shared/equipment-ledger.interface';
import { Button } from '../../../client/src/components/ui/button';
import '../../../client/src/pages/EquipmentLedgerManagement/styles.css';
import './styles.css';

function Fixture() {
  const [assets, setAssets] = useState<LedgerAsset[]>([]);
  const [asset, setAsset] = useState<LedgerAsset | null>(null);
  const [mode, setMode] = useState('normal');
  useEffect(() => {
    void fetch('/fixture/assets')
      .then((r) => r.json())
      .then(setAssets);
  }, []);
  return (
    <main style={{ maxWidth: '60rem', margin: '2rem auto', padding: '1rem' }}>
      <h1>设备机历开发验收</h1>
      <label>
        场景{' '}
        <select
          aria-label="验收场景"
          value={mode}
          onChange={(e) => {
            sessionStorage.setItem('ledger-fixture-mode', e.target.value);
            setMode(e.target.value);
          }}
        >
          {['normal', 'cold', 'error', 'timeout', 'stale', 'late'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
          marginBlock: '1rem',
        }}
      >
        {assets.map((a, i) => (
          <Button key={a.id} variant="outline" onClick={() => setAsset(a)}>
            {['已完成维修设备', '未开始维修设备', '无维修设备'][i]} ·{' '}
            {a.sourceCode}
          </Button>
        ))}
      </div>
      <AssetDetail
        asset={asset}
        lifecycleLoading={false}
        lifecycleError=""
        detailLoading={false}
        detailError=""
        onRetry={() => {}}
        onDetailRetry={() => {}}
        onClose={() => setAsset(null)}
        onRestoreFocus={() => {}}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
