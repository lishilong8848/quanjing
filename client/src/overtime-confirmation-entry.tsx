import React from 'react';
import { createRoot } from 'react-dom/client';

import OvertimeConfirmationPage from './pages/OvertimeConfirmation';
import './overtime-confirmation.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OvertimeConfirmationPage />
  </React.StrictMode>,
);
