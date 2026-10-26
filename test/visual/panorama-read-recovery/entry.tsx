import { createRoot } from 'react-dom/client';
import TodayOperationsPanoramaPage from '../../../client/src/pages/TodayOperationsPanorama';
import { TooltipProvider } from '../../../client/src/components/ui/tooltip';

createRoot(document.getElementById('root')!).render(
  <TooltipProvider><TodayOperationsPanoramaPage /></TooltipProvider>,
);
