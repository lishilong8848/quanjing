import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { resetPersonalPassword } from '@/api/personal-access';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createPersonalMutationIdentity, validateNewPersonalPassword, validatePasswordResetIdentity } from './personal-password.logic';

export function ForgotPasswordDialog({ open, initialName, onClose, onSuccess }: { open: boolean; initialName: string; onClose: () => void; onSuccess: () => void }) {
  const [employeeName, setEmployeeName] = useState(initialName), [identityNumber, setIdentityNumber] = useState('');
  const [newPassword, setNewPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), identity = useRef(createPersonalMutationIdentity()), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; identity.current.clear(); }; }, []);
  useEffect(() => { if (open) setEmployeeName(initialName); else { setIdentityNumber(''); setNewPassword(''); setConfirmPassword(''); setError(''); identity.current.clear(); } }, [open, initialName]);
  async function submit() {
    if (pending.current) return;
    const problem = validatePasswordResetIdentity(employeeName, identityNumber) || validateNewPersonalPassword(newPassword, confirmPassword);
    if (problem) { setError(problem); return; }
    const body = { employeeName: employeeName.trim(), identityNumber: identityNumber.trim().toUpperCase(), newPassword, confirmPassword };
    pending.current = true; setBusy(true); setError('');
    try {
      await resetPersonalPassword({ ...body, clientMutationId: identity.current.forPayload(body) });
      if (!alive.current) return;
      setIdentityNumber(''); setNewPassword(''); setConfirmPassword(''); identity.current.clear(); onSuccess();
    } catch (failure) { if (alive.current) setError((failure as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}><DialogContent showCloseButton={!busy} className="max-h-[calc(100dvh-2rem)] overflow-y-auto" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>找回姓名登录密码</DialogTitle><DialogDescription>填写本人姓名和完整身份证号，核验成功后设置新密码。身份证信息仅用于本次核验；飞书登录请使用飞书的账号找回方式。</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className="block space-y-2 text-sm"><span>本人姓名</span><Input value={employeeName} onChange={event => setEmployeeName(event.target.value)} autoComplete="username" maxLength={100} disabled={busy} autoFocus /></label>
      <label className="block space-y-2 text-sm"><span>完整身份证号</span><Input type="password" value={identityNumber} onChange={event => setIdentityNumber(event.target.value)} autoComplete="off" maxLength={18} disabled={busy} placeholder="18 位身份证号，末位 X 也需填写" /></label>
      <label className="block space-y-2 text-sm"><span>新密码</span><Input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" maxLength={256} disabled={busy} placeholder="8 至 128 个字符" /></label>
      <label className="block space-y-2 text-sm"><span>确认新密码</span><Input type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" maxLength={256} disabled={busy} /></label>
      {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm leading-6 text-destructive">{error}</p>}
      {busy && <p role="status" className="text-xs text-muted-foreground">正在核验本人信息，请勿重复提交。</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={busy}>返回登录</Button><Button type="submit" disabled={busy} aria-busy={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{busy ? '正在核验…' : '核验并重设密码'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
