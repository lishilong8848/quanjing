import { useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAccess } from '@/access/AccessProvider';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { getCurrentCsrfToken } from '@/api/csrf-token';
import { Button } from '@/components/ui/button';
import { finishPaymentAttempt, parsePaymentPending, parsePaymentTarget, paymentPendingKey, reservePaymentAttempt, validatePaymentFiles, type PaymentPending } from './state';

function endpoint(): string {
  const base = String(process.env.CLIENT_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
  if (base && base.split('/').some(part => { const decoded = decodeURIComponent(part); return !decoded || decoded === '.' || decoded === '..' || /[\\/?:#\u0000-\u0020]/.test(decoded); })) throw new Error('访问地址无效');
  return `${base ? `/${base}` : ''}/api/purchase-inventory/lifecycle/payment-attachments`;
}

/** Isolated component only: no route, API provider or lifecycle switch is enabled here. */
export default function PurchaseLifecyclePaymentUploadPage() {
  const location = useLocation(), access = useAccess();
  const target = useMemo(() => parsePaymentTarget(location.search), [location.search]);
  const [files, setFiles] = useState<File[]>([]), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(true);
  const [message, setMessage] = useState(''), [success, setSuccess] = useState(false);
  const [pending, setPending] = useState<PaymentPending | null>(null), [canCancel, setCanCancel] = useState(false);
  const [canResume,setCanResume]=useState(false);
  const generation = useRef(0), busyRef = useRef(false), controller = useRef<AbortController | null>(null), input = useRef<HTMLInputElement>(null);
  const authenticated = hasAuthenticatedAccessIdentity(access) && !!access.accountId && !access.impersonation && !access.requiresPasswordChange;
  useEffect(() => {
    generation.current += 1; controller.current?.abort(); controller.current = null; busyRef.current = false;
    setFiles([]); setBusy(false); setBlocked(true); setSuccess(false); setMessage('');setPending(null);setCanCancel(false);setCanResume(false);
    if (target && authenticated && access.accountId) {
      try {
        const saved=parsePaymentPending(window.localStorage.getItem(paymentPendingKey(access.accountId, target)), access.accountId, target);
        setPending(saved);setBlocked(!!saved);
        if(saved)void recover(saved,'status',generation.current);
      }
      catch { setBlocked(true); setMessage('无法核对上次上传记录，请联系管理员。'); }
    }
    return () => { generation.current += 1; controller.current?.abort(); };
  }, [location.search, access.accountId, access.authorizationVersion, authenticated, target]);

  async function recover(saved: PaymentPending, action: 'status' | 'cancel', current = generation.current) {
    if(busyRef.current)return;
    const csrf=getCurrentCsrfToken();
    if(!csrf){setMessage('登录校验信息尚未就绪，请稍后重新核对。');return;}
    busyRef.current=true;setBusy(true);setCanCancel(false);setCanResume(false);setBlocked(true);
    const abort=new AbortController();controller.current=abort;
    const timer=window.setTimeout(()=>abort.abort(),60_000);
    try {
      const response=await fetch(`${endpoint()}/${action}`,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:abort.signal,
        headers:{'Content-Type':'application/json','X-Suda-Csrf-Token':csrf},
        body:JSON.stringify({approvalBatchId:saved.approvalBatchId,executionRecordId:saved.executionRecordId,generation:saved.generation,requestId:saved.requestId})});
      if(!response.ok)throw Error('unconfirmed');
      const result:unknown=await response.json();
      if(generation.current!==current)return;
      const state=result&&typeof result==='object'&&!Array.isArray(result)?(result as {state?:unknown}).state:undefined;
      if(state==='completed'||state==='cancelled'){
        finishPaymentAttempt(window.localStorage,saved.accountId,saved,saved.requestId);
        setPending(null);setBlocked(false);setSuccess(state==='completed');
        setMessage(state==='completed'?'已确认付款附件上传成功，请返回飞书卡片继续办理。':'已确认取消未完成的上传，可以重新选择附件。');
      }else if(state==='not_found'||state==='prepared'){
        setCanCancel(true);setMessage('该请求尚未发送附件。可取消此请求后重新上传。');
      }else if(state==='resumable' && saved.generation===target?.generation){
        setCanResume(true);setBlocked(false);setMessage('部分附件尚未上传，请重新选择原来的全部文件后继续；已确认的附件不会重复上传。');
      }else if(state==='resumable')setMessage('原卡片已有未完成上传，请联系管理员核对，不能在续卡中重新上传同一批附件。');
      else if(state==='dispatching'||state==='uploaded')setMessage('原上传任务仍在处理，请稍后重新核对，勿重复上传。');
      else if(state==='manual_reconciliation')setMessage('原上传结果需要管理员核对，请勿重复上传。');
      else throw Error('unconfirmed');
    }catch{if(generation.current===current)setMessage('暂时无法核对上传结果，原请求已保留，请稍后重新核对。');}
    finally{window.clearTimeout(timer);if(generation.current===current){busyRef.current=false;setBusy(false);controller.current=null;}}
  }

  async function submit() {
    if (!target || !authenticated || !access.accountId || busyRef.current || blocked) return;
    const issue = validatePaymentFiles(files);
    if (issue) { setMessage(issue); return; }
    const csrf = getCurrentCsrfToken();
    if (!csrf || typeof crypto.randomUUID !== 'function') { setMessage('登录校验信息不可用，请刷新页面后重试。'); return; }
    let requestUrl: string;
    try { requestUrl = endpoint(); } catch { setMessage('上传地址不可用，请联系管理员。'); return; }
    const accountId = access.accountId, requestId = canResume && pending ? pending.requestId : crypto.randomUUID(), current = generation.current;
    try {
      if(canResume && pending){
        const saved=parsePaymentPending(window.localStorage.getItem(paymentPendingKey(accountId,target)),accountId,target);
        if(saved?.requestId!==requestId || saved.generation!==target.generation)throw Error('changed');
      }else setPending(reservePaymentAttempt(window.localStorage, accountId, target, requestId));
      setCanCancel(false);setCanResume(false);
    }
    catch { setBlocked(true); setMessage('无法安全记录上传请求，或上次结果待核对，请联系管理员。'); return; }
    busyRef.current = true; setBusy(true); setMessage(''); setSuccess(false);
    const abort = new AbortController(); controller.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 60_000);
    try {
      const body = new FormData();
      body.append('approvalBatchId', target.approvalBatchId); body.append('executionRecordId', target.executionRecordId);
      body.append('generation', String(target.generation)); body.append('requestId', requestId);
      files.forEach(file => body.append('files', file, file.name));
      const response = await fetch(requestUrl, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'X-Suda-Csrf-Token': csrf }, body, signal: abort.signal });
      if (!response.ok) throw new Error('unconfirmed');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result) || (result as { state?: unknown }).state !== 'completed') throw new Error('unconfirmed');
      if (generation.current !== current) return;
      finishPaymentAttempt(window.localStorage, accountId, target, requestId);
      setPending(null);
      if (input.current) input.current.value = '';
      setFiles([]); setSuccess(true); setMessage('付款附件已上传，请返回飞书卡片继续填写下单结果。');
    } catch {
      if (generation.current === current) { setBlocked(true); setMessage('上传结果待核对，请勿重复上传，联系管理员处理。'); }
    } finally {
      window.clearTimeout(timeout);
      if (generation.current === current) { busyRef.current = false; setBusy(false); controller.current = null; }
    }
  }

  return <main className="min-h-[60vh] bg-slate-50 px-4 py-8">
    <section className="mx-auto max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="bg-blue-800 px-5 py-5 text-white sm:px-6"><h1 className="flex items-center gap-2 text-xl font-semibold"><FileUp className="size-6" aria-hidden="true" />上传付款附件</h1></header>
      <div className="space-y-4 p-5 sm:p-6">
        {!target ? <p role="alert" className="text-sm text-red-700">附件链接无效，请从最新采购卡片重新打开。</p> : access.isLoading ? <p role="status" className="text-sm text-slate-600">正在确认登录身份…</p> : !authenticated ? <>
          <p className="text-sm leading-6 text-slate-700">请使用本人飞书账号登录后上传。</p>
          <Button type="button" className="min-h-11 w-full sm:w-auto" onClick={() => access.requestLogin('请登录本人飞书账号。', location.pathname + location.search, undefined, undefined, false, { method: 'feishu' })}>飞书登录</Button>
        </> : <>
          <p className="text-sm leading-6 text-slate-700">每次选择 1 至 5 个附件，每个不超过 20 MB。</p>
          {blocked && !message && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">上次上传结果待核对，请勿重复上传，联系管理员处理。</p>}
          {message && <p role={success ? 'status' : 'alert'} className={`rounded-lg border p-3 text-sm ${success ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>{message}</p>}
          {pending && <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={()=>void recover(pending,'status')}>重新核对上传结果</Button>
            {canCancel && <Button type="button" variant="outline" disabled={busy} onClick={()=>void recover(pending,'cancel')}>取消未开始的上传</Button>}
          </div>}
          <div className="space-y-2"><label htmlFor="payment-files" className="block text-sm font-medium text-slate-900">付款附件</label>
            <input ref={input} id="payment-files" type="file" multiple disabled={busy || blocked} className="block min-h-11 w-full rounded-md border border-slate-300 p-2 text-sm disabled:opacity-60" onChange={event => { setFiles(Array.from(event.currentTarget.files || [])); setMessage(''); setSuccess(false); }} />
            {files.length > 0 && <ul className="space-y-1 text-sm text-slate-700">{files.map((file, index) => <li key={`${file.name}-${file.size}-${index}`} className="break-all">{file.name}</li>)}</ul>}
          </div>
          <Button type="button" disabled={busy || blocked || !files.length} className="min-h-11 w-full sm:w-auto" onClick={() => void submit()}>{busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <FileUp className="size-4" aria-hidden="true" />}{busy ? '正在上传…' : canResume ? '继续原上传任务' : '上传付款附件'}</Button>
        </>}
      </div>
    </section>
  </main>;
}
