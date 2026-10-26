import '../../client/src/polyfills';
import './login-entry-browser.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AccessProvider, useAccess } from '../../client/src/access/AccessProvider';
import RouteAccessGuard from '../../client/src/access/RouteAccessGuard';
import { GlobalNavigation } from '../../client/src/components/GlobalNavigation';
import SystemConfigurationPage from '../../client/src/pages/SystemConfiguration';
import MonthlySchedule from '../../client/src/pages/MonthlySchedule';
import { Toaster } from '../../client/src/components/ui/sonner';
function Controls() { const {requestLogin,logout}=useAccess();return <div className="fixed bottom-2 right-2 z-20 flex gap-2"><button onClick={()=>requestLogin()}>登录验收</button><button onClick={()=>void logout()}>切换游客</button></div>; }
createRoot(document.getElementById('root')!).render(<BrowserRouter><AccessProvider><GlobalNavigation/><div className="pt-16"><Routes><Route element={<RouteAccessGuard/>}><Route path="/system-configuration" element={<SystemConfigurationPage/>}/><Route path="/monthly-schedule" element={<MonthlySchedule/>}/><Route path="/nantong-base" element={<div className="p-8">登录界面隔离验收</div>}/></Route></Routes></div><Controls/><Toaster/></AccessProvider></BrowserRouter>);
