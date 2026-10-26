import { createRoot } from 'react-dom/client';
import { PersonnelHandoverPanel } from '../../../client/src/pages/SystemConfiguration/PersonnelHandoverPanel';
import { overview } from './fixture';
import './styles.css';
import '../../../client/src/pages/SystemConfiguration/configuration.css';
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-6xl space-y-4 p-4"><h1 className="text-xl font-semibold">岗位交接 · 隔离验收</h1><PersonnelHandoverPanel overview={overview} accountId="synthetic-admin" onRefresh={()=>{}} /></main>);
