import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { HotfixActivation } from './hotfix-activation';

const RETRY_SECONDS = 5;
const MAINTENANCE_SCRIPT = `(() => {
  if (!window.fetch || !window.AbortController) return;
  const retry = document.getElementById('retry');
  const status = document.getElementById('status');
  const health = new URL(retry.dataset.health, location.origin);
  if (health.origin !== location.origin) return;
  const interval = ${RETRY_SECONDS * 1_000};
  const checking = '正在检查平台状态…';
  let timer;
  let controller;
  let failures = 0;
  let leaving = false;

  function show(message) {
    if (status.textContent !== message) status.textContent = message;
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (!document.hidden && !leaving) timer = setTimeout(check, delay);
  }

  function pause() {
    clearTimeout(timer);
    const current = controller;
    controller = undefined;
    if (current) current.abort();
  }

  async function check() {
    if (document.hidden || leaving || controller) return;
    clearTimeout(timer);
    const current = new AbortController();
    controller = current;
    const timeout = setTimeout(() => current.abort(), interval);
    try {
      const response = await fetch(health, {
        method: 'GET', mode: 'same-origin', credentials: 'omit', redirect: 'error',
        cache: 'no-store', headers: { Accept: 'application/json' }, signal: current.signal
      });
      if (controller !== current || document.hidden) return;
      if (response.status === 200 &&
          response.headers.get('X-Nantong-Hotfix-Activation') === 'active' &&
          response.headers.get('X-Nantong-Hotfix-Accepting') === 'true' &&
          response.headers.get('X-Nantong-Hotfix-Deployment') &&
          /^application\\/json(?:\\s*;|$)/i.test(response.headers.get('Content-Type') || '')) {
        const body = await response.json();
        if (controller !== current || document.hidden) return;
        if (body && typeof body.role === 'string' && body.role &&
            body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities)) {
          leaving = true;
          show('平台已恢复，正在重新加载…');
          location.reload();
          return;
        }
      }
      failures = 0;
      show('平台正在更新，稍后会再次检查。');
    } catch {
      if (controller !== current || document.hidden) return;
      failures = Math.min(failures + 1, 3);
      show('暂时无法连接，将稍后重试。');
    } finally {
      clearTimeout(timeout);
      if (controller === current) {
        controller = undefined;
        schedule(Math.min(interval * 2 ** failures, 30000));
      }
    }
  }

  retry.addEventListener('click', event => {
    event.preventDefault();
    failures = 0;
    show(checking);
    void check();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else { failures = 0; void check(); }
  });
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', event => {
    if (event.persisted) { leaving = false; schedule(interval); }
  });
  schedule(interval);
})();`;

const MAINTENANCE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${createHash('sha256').update(MAINTENANCE_SCRIPT).digest('base64')}'`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function renderMaintenancePage(healthPath: string): string {
  const healthAttribute = healthPath.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>平台更新中 · 南通基地运营平台</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:20px;background:linear-gradient(150deg,#eaf2ff,#f8fbff 64%,#eef5ff);color:#102039;font:1rem/1.6 system-ui,"Microsoft YaHei",sans-serif}
.card{width:min(100%,36rem);overflow:hidden;background:#fff;border:1px solid #d8e5f7;border-radius:20px;box-shadow:0 18px 48px #153b791a}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:20px 30px;color:#fff;background:linear-gradient(125deg,#064fc5,#00359b 62%,#012a7d)}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:700}
.brand strong{font:800 1.25rem/1 system-ui,sans-serif;letter-spacing:.04em}
.brand span{font-size:.78rem}
header p{margin:0;font-size:.92rem;font-weight:600}
.body{padding:34px 30px 30px}
.badge{display:inline-flex;align-items:center;gap:8px;padding:4px 10px;border-radius:999px;background:#edf4ff;color:#154ba9;font-size:.82rem;font-weight:700}
.indicator{width:14px;height:14px;flex:none;border:2px solid #b1cbf9;border-top-color:#1554df;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{margin:12px 0 8px;font-size:1.9rem;line-height:1.3}
.description{margin:0;color:#40536f;overflow-wrap:anywhere}
footer{display:flex;align-items:center;justify-content:space-between;gap:12px 16px;flex-wrap:wrap;margin-top:26px;padding-top:18px;border-top:1px solid #d8e5f7}
#status{margin:0;color:#40536f;font-size:.9rem}
a{display:inline-flex;justify-content:center;align-items:center;min-height:44px;padding:8px 16px;border-radius:9px;background:#1554d1;color:#fff;font-size:.92rem;font-weight:700;text-decoration:none}
a:hover{background:#103e9d}a:focus-visible{outline:3px solid #005bff;outline-offset:4px}
@media(max-width:420px){body{padding:12px}header,.body{padding:20px}h1{font-size:1.6rem}footer{margin-top:20px}a{width:100%}}
@media(prefers-reduced-motion:reduce){.indicator{animation:none}}
</style>
</head>
<body>
<main class="card" aria-labelledby="heading">
  <header><div class="brand"><strong>VNET</strong><span>世纪互联</span></div><p>南通基地运营平台</p></header>
  <div class="body">
    <span class="badge"><span class="indicator" aria-hidden="true"></span>系统维护</span>
    <h1 id="heading">平台正在更新</h1>
    <p class="description">更新完成后会自动返回当前页面。你也可以手动检查更新状态。</p>
    <footer>
      <p id="status" role="status">等待平台恢复…</p>
      <a id="retry" href="" data-health="${healthAttribute}">重新尝试</a>
    </footer>
  </div>
</main>
<script>${MAINTENANCE_SCRIPT}</script>
</body>
</html>`;
}

function isPageNavigation(request: Request, apiMountPath: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = request.path.toLowerCase();
  const apiPath = apiMountPath.toLowerCase();
  const callbackPath = apiPath.slice(0, apiPath.lastIndexOf('/')) + '/callbacks';
  if ([apiPath, '/api', callbackPath, '/callbacks'].some(prefix => path === prefix || path.startsWith(prefix + '/'))) {
    return false;
  }
  const mode = request.get('Sec-Fetch-Mode');
  const destination = request.get('Sec-Fetch-Dest');
  if ((mode && mode !== 'navigate') || (destination && !['document', 'frame', 'iframe'].includes(destination))) return false;
  // Older embedded browsers omit Fetch Metadata but still explicitly accept HTML.
  const acceptsHtml = request.get('Accept')?.split(',').some(type => type.split(';', 1)[0].trim().toLowerCase() === 'text/html');
  return Boolean(acceptsHtml && request.accepts('html', 'json') === 'html');
}

export function createHotfixActivationMiddleware(
  gate: Pick<HotfixActivation, 'status' | 'isAcceptingNewWork'>,
  apiMountPath: string,
): RequestHandler {
  const sessionPath = `${apiMountPath}/access/session`;
  const healthPaths = new Set([sessionPath, `${apiMountPath}/feishu-card-callback/health`]);
  const maintenancePage = renderMaintenancePage(sessionPath);
  return (request, response, next) => {
    const accepting = gate.isAcceptingNewWork(), state = gate.status();
    const health = request.method === 'GET' && healthPaths.has(request.path);
    if (health) {
      response.setHeader('X-Nantong-Hotfix-Activation', state.phase);
      response.setHeader('X-Nantong-Hotfix-Deployment', state.deploymentId ?? 'unmanaged');
      response.setHeader('X-Nantong-Hotfix-Accepting', String(accepting && state.phase === 'active'));
      response.setHeader('Cache-Control', 'no-store');
    }
    if (state.phase !== 'failed' && state.phase !== 'closed' && (health || accepting && state.phase === 'active')) {
      next(); return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Retry-After', String(RETRY_SECONDS));
    response.vary('Accept').vary('Sec-Fetch-Mode').vary('Sec-Fetch-Dest');
    if (isPageNavigation(request, apiMountPath)) {
      response.setHeader('Content-Security-Policy', MAINTENANCE_CSP);
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.status(503).type('html').send(maintenancePage);
      return;
    }
    response.status(503).json({ status: 'maintenance', message: '系统更新中，请稍后重试' });
  };
}
