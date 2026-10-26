import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import EquipmentLedgerManagement from '../../../client/src/pages/EquipmentLedgerManagement';
import { FixtureAccessProvider } from './permission-access';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <FixtureAccessProvider>
      <EquipmentLedgerManagement />
    </FixtureAccessProvider>
  </BrowserRouter>,
);
