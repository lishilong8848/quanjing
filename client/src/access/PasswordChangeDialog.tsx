import { useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { changePersonalPassword } from '@/api/personal-access';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createPersonalMutationIdentity, validateNewPersonalPassword } from './personal-password.logic';

export function PasswordChangeDialog({ open, required = false, onClose, onSuccess, onLogout }: {
  open: boolean; required?: boolean; onClose: () => void; onSuccess: () => void; onLogout: () => Promise<unknown>;
}) {
  const [currentPassword, setCurrentPassword] = useState(''), [newPassword, setNewPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const pending = useRef(false), identity = useRef(createPersonalMutationIdentity());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; identity.current.clear(); }; }, []);
  useEffect(() => { if (!open) { setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setError(''); setUncertain(false); identity.current.clear(); } }, [open]);
  async function submit() {
    if (pending.current) return;
    const problem = !currentPassword ? '请输入当前密码' : validateNewPersonalPassword(newPassword, confirmPassword);
    if (problem) { setError(problem); return; }
    const body = { currentPassword, newPassword, confirmPassword };
    pending.current = true; setBusy(true); setError(''); setUncertain(false);
    try {
      await changePersonalPassword({ ...body, clientMutationId: identity.current.forPayload(body) });
      if (!alive.current) return;
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); identity.current.clear(); onSuccess();
    } catch (failure) {
      if (alive.current) { setError((failure as Error).message); setUncertain(!!(failure as { uncertain?: boolean }).uncertain); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function leave() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await onLogout(); } catch (failure) { if (alive.current) setError((failure as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={next => { if (!next && !required && !busy) onClose(); }}>
    <DialogContent showCloseButton={!required && !busy} className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      onEscapeKeyDown={event => { if (required || busy) event.preventDefault(); }} onPointerDownOutside={event => { if (required || busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle className="flex items-center gap-2"><KeyRound className="size-5 text-primary" />{required ? '首次登录，请设置新密码' : '修改登录密码'}</DialogTitle>
        <DialogDescription>{required ? '请先更换初始密码，再使用系统功能。' : '修改后需要使用新密码重新登录。'}新密码需为 8 至 128 个字符，不可使用身份证号或初始密码。</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className="block space-y-2 text-sm"><span>当前密码</span><Input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={busy} maxLength={256} autoFocus /></label>
        <label className="block space-y-2 text-sm"><span>新密码</span><Input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={busy} maxLength={256} /></label>
        <label className="block space-y-2 text-sm"><span>确认新密码</span><Input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} disabled={busy} maxLength={256} /></label>
        {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm leading-6 text-destructive">{error}</p>}
        {busy && <p role="status" className="text-xs text-muted-foreground">正在核验并更新密码，请勿重复提交。</p>}
        <DialogFooter>{required || uncertain ? <Button type="button" variant="outline" disabled={busy} onClick={() => void leave()}>{uncertain ? '返回登录，尝试新密码' : '退出登录'}</Button> : <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>}
          <Button type="submit" disabled={busy} aria-busy={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{busy ? '正在保存…' : '保存新密码'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
