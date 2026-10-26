import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AccessProvider } from '../../../client/src/access/AccessProvider';
import { GlobalNavigation } from '../../../client/src/components/GlobalNavigation';
import RouteAccessGuard from '../../../client/src/access/RouteAccessGuard';
import SystemConfiguration from '../../../client/src/pages/SystemConfiguration';
import './styles.css';
import { installPerformanceProbe } from './performance';

if (document.body.dataset.fixtureRuntime === 'production') installPerformanceProbe();
createRoot(document.getElementById('root')!).render(<BrowserRouter><AccessProvider><GlobalNavigation /><div className="pt-20"><Routes><Route element={<RouteAccessGuard />}><Route path="/system-configuration" element={<SystemConfiguration />} /></Route><Route path="*" element={<main className="p-8"><h1>配置隔离验收</h1><a href="/fixture/login">登录合成管理员</a></main>} /></Routes></div><Toaster /></AccessProvider></BrowserRouter>);
