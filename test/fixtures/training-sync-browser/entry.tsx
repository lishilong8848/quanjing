import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import TrainingCertificationManagement from '../../../client/src/pages/TrainingCertificationManagement';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <TrainingCertificationManagement />
  </BrowserRouter>,
);
