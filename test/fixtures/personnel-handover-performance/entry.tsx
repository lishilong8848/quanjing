import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AccessProvider } from '../../../client/src/access/AccessProvider';
import { GlobalNavigation } from '../../../client/src/components/GlobalNavigation';
import RouteAccessGuard from '../../../client/src/access/RouteAccessGuard';
import SystemConfiguration from '../../../client/src/pages/SystemConfiguration';
import '../admin-configuration-browser/styles.css';
import { installHandoverFeedbackProbe } from './probe';

installHandoverFeedbackProbe();
createRoot(document.getElementById('root')!).render(<BrowserRouter><AccessProvider><GlobalNavigation /><div className="pt-20"><Routes><Route element={<RouteAccessGuard />}><Route path="/system-configuration" element={<SystemConfiguration />} /></Route></Routes></div><Toaster /></AccessProvider></BrowserRouter>);
