import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { AlarmTagAnomalyDialog } from '../../../client/src/pages/TodayOperationsPanorama/AlarmTagAnomalyDialog';
import '../../../client/src/pages/TodayOperationsPanorama/styles.css';
import { snapshot } from './stubs';
function Fixture() {
  const [open, setOpen] = useState(true);
  return <main><button onClick={() => setOpen(true)}>打开异常清单</button><AlarmTagAnomalyDialog open={open} onOpenChange={setOpen} snapshot={snapshot as never} initialPageLoaded /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
