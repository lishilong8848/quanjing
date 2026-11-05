import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileLock2, Loader2 } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAccess } from '@/access/AccessProvider';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { Button } from '@/components/ui/button';
import { getCurrentCsrfToken } from '@/api/csrf-token';
import { parsePurchaseAttachmentLocation } from './location';

/** Not routed until the lifecycle service and its authorization checks are ready. */
export default function PurchaseLifecycleAttachmentPage() {
  const location = useLocation(), access = useAccess();
  const target = useMemo(() => parsePurchaseAttachmentLocation(location.search), [location.search]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; setBusy(false); setError(''); return () => { generation.current += 1; }; }, [location.search, access.accountId, access.authorizationVersion]);
  const authenticated = hasAuthenticatedAccessIdentity(access);
  async function download() {
    if (!target || busy || !authenticated) return;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const csrf = getCurrentCsrfToken();
      if (!csrf) throw new Error();
      const base = String(process.env.CLIENT_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
      if (base && base.split('/').some(part => { const decoded = decodeURIComponent(part); return !decoded || decoded === '.' || decoded === '..' || /[\\/?:#\u0000-\u0020]/.test(decoded); })) throw new Error();
      const endpoint = `${base ? `/${base}` : ''}/api/purchase-inventory/lifecycle/attachments`;
      const headers = { 'Content-Type': 'application/json', 'X-Suda-Csrf-Token': csrf };
      const issue = await fetch(`${endpoint}/current-ticket`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers, body: JSON.stringify(target),
      });
      if (!issue.ok) throw new Error();
      const issued: unknown = await issue.json();
      const ticket = typeof issued === 'object' && issued !== null && 'ticket' in issued ? issued.ticket : null;
      if (typeof ticket !== 'string' || generation.current !== current) throw new Error();
      const response = await fetch(`${endpoint}/download`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers, body: JSON.stringify({ ticket }),
      });
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      if (generation.current !== current) return;
      const url = URL.createObjectURL(blob);
      const suffix: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
      const link = document.createElement('a'); link.href = url; link.download = `采购附件.${suffix[blob.type] || 'bin'}`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { if (generation.current === current) setError('附件暂时无法查看，请确认登录账号及当前采购权限后重试。'); }
    finally { if (generation.current === current) setBusy(false); }
  }
  return <main className="min-h-[60vh] bg-slate-50 px-4 py-8">
    <section className="mx-auto max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="bg-blue-800 px-5 py-5 text-white sm:px-6"><h1 className="flex items-center gap-2 text-xl font-semibold"><FileLock2 className="size-6" aria-hidden="true" />采购附件</h1></header>
      <div className="space-y-4 p-5 sm:p-6">
        {!target ? <p role="alert" className="text-sm text-red-700">附件链接无效，请从最新采购卡片重新打开。</p> : <>
          <p className="text-sm leading-6 text-slate-700">附件仅对当前获授权的人员开放。下载前会重新核验身份及采购权限。</p>
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          {access.isLoading ? <p role="status" className="text-sm text-slate-600">正在确认登录身份…</p> : authenticated ?
            <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => void download()}>{busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}{busy ? '正在核验并下载…' : '下载附件'}</Button> :
            <Button type="button" className="min-h-11 w-full sm:w-auto" onClick={() => access.requestLogin('请登录有权限的飞书个人账号。', location.pathname + location.search, undefined, undefined, false, { method: 'feishu' })}>飞书登录</Button>}
        </>}
      </div>
    </section>
  </main>;
}
