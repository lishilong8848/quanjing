import { createRoot } from 'react-dom/client';
import { PersonnelTaskRecoveryPanel } from '../../../client/src/pages/SystemConfiguration/PersonnelTaskRecoveryPanel';
import './styles.css';
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-5xl p-4"><PersonnelTaskRecoveryPanel accountId="synthetic-admin" /></main>);
