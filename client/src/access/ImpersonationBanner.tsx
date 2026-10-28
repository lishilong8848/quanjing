import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAccess } from './AccessProvider';

export function ImpersonationBanner() {
  const { impersonation, stopImpersonation, isChangingIdentity } = useAccess();
  const ref = useRef<HTMLElement>(null);
  const mutation = useRef<string | undefined>(undefined);
  const pending = useRef(false);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    if (!impersonation || !ref.current) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--access-impersonation-height');
    const update = () => root.style.setProperty('--access-impersonation-height', `${ref.current?.getBoundingClientRect().height || 0}px`);
    update();
    const observer = new ResizeObserver(update); observer.observe(ref.current);
    return () => { observer.disconnect(); if (previous) root.style.setProperty('--access-impersonation-height', previous); else root.style.removeProperty('--access-impersonation-height'); };
  }, [impersonation]);
  if (!impersonation) return null;
  const ending = async () => {
    if (pending.current || isChangingIdentity) return;
    pending.current = true; setError('');
    mutation.current ||= crypto.randomUUID();
    try { await stopImpersonation(mutation.current); }
    catch (failure) { setError((failure as Error).message); }
    finally { pending.current = false; }
  };
  return <aside ref={ref} aria-label="管理员代登录状态" className="sticky top-0 z-40 border-b border-amber-300 bg-amber-50 px-3 py-2 text-amber-950 shadow-sm">
    <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
      <p className="flex min-w-0 items-center gap-2 break-all"><UserRound className="size-4 shrink-0" aria-hidden="true" /><span>代登录：<strong>{impersonation.targetName}</strong><span className="ml-2 text-xs">管理员：{impersonation.actorName}</span></span></p>
      <Button type="button" variant="outline" className="min-h-11 shrink-0 border-amber-300 bg-white" disabled={isChangingIdentity} onClick={() => void ending()}>{isChangingIdentity ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <ArrowLeft className="size-4" aria-hidden="true" />}{isChangingIdentity ? '正在返回…' : '返回管理员'}</Button>
      {error && <p role="alert" className="w-full break-words text-sm text-destructive">{error}</p>}
    </div>
  </aside>;
}
