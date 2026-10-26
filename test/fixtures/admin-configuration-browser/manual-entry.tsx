import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AccessProvider } from '../../../client/src/access/AccessProvider';
import { GlobalNavigation } from '../../../client/src/components/GlobalNavigation';
import RouteAccessGuard from '../../../client/src/access/RouteAccessGuard';
import SystemConfiguration from '../../../client/src/pages/SystemConfiguration';
import './styles.css';
import { installPerformanceProbe } from './performance';

const probe = installPerformanceProbe();
const guide = document.createElement('aside');
guide.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:9999;background:#eff6ff;color:#172554;border:1px solid #93c5fd;border-radius:8px;padding:8px 16px;font:14px Arial;pointer-events:none';
guide.setAttribute('aria-live', 'polite');
guide.textContent = '先点第一行“编辑”→右上角“关闭”预热一次，不保存';
document.body.append(guide);
let closes = 0;
const exportButton = document.querySelector<HTMLButtonElement>('button[data-probe-export="true"]')!;
exportButton.hidden = true;
const controlButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Fixture frame control');
if (controlButton) controlButton.hidden = true;
document.addEventListener('click', event => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
  if (!event.isTrusted || button?.getAttribute('aria-label') !== '关闭' || button.disabled) return;
  closes += 1;
  // Update guidance after this interaction's measured paint window, never by clicking UI for the user.
  window.setTimeout(() => {
    if (closes === 1) guide.textContent = '预热完成。重复“编辑→关闭”20组；不改内容、不点保存';
    else if (closes < 21) guide.textContent = `已完成 ${closes - 1}/20 组；继续点第一行编辑→右上角关闭`;
    else {
      probe.exportMeasurements();
      guide.textContent = '已完成20组，结果已自动保留；不用再点，回复我“好了”';
    }
  }, 1500);
}, true);
createRoot(document.getElementById('root')!).render(<BrowserRouter><AccessProvider><GlobalNavigation /><div className="pt-20"><Routes><Route element={<RouteAccessGuard />}><Route path="/system-configuration" element={<SystemConfiguration />} /></Route><Route path="*" element={<main className="p-8"><h1>配置隔离验收</h1><a href="/fixture/login">登录合成管理员</a></main>} /></Routes></div><Toaster /></AccessProvider></BrowserRouter>);
