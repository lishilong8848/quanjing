import '../../client/src/polyfills';
import './multi-building-browser.css';
import '../../client/src/pages/SystemConfiguration/configuration.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountEditor } from '../../client/src/pages/SystemConfiguration/AccountEditor';
import { loadConfiguration } from '../../client/src/pages/SystemConfiguration/api';
import type { AccessConfigurationResponse, ManagedAccount } from '../../shared/access-configuration.interface';

function Fixture() {
  const [data, setData] = useState<AccessConfigurationResponse>(), [open, setOpen] = useState(false), [message, setMessage] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<ManagedAccount>();
  useEffect(() => { void loadConfiguration().then(setData).catch(error => setMessage(error.message)); }, []);
  useEffect(() => { const refresh = () => { void loadConfiguration().then(setData).catch(error => setMessage(error.message)); }; window.addEventListener('configuration-refresh-request', refresh); return () => window.removeEventListener('configuration-refresh-request', refresh); }, []);
  const account = data?.accounts.find(item => item.openId === 'ou_permission_browser_synthetic');
  return <main className="p-6"><h1>个人权限隔离验收</h1><button onClick={() => { setSelectedAccount(account); setOpen(true); }} disabled={!account}>编辑合成人员</button><p role="status">{message}</p><pre className="whitespace-pre-wrap break-all" aria-label="保存回读">{JSON.stringify(account && { role: account.role, buildings: account.buildings, specialties: account.specialties, personalRules: account.personalRules, version: account.version })}</pre>
    {open && data && <AccountEditor account={selectedAccount} external data={data} people={[]} onClose={() => setOpen(false)} onSaved={result => { setData(result); setOpen(false); setMessage('配置已保存'); }} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
