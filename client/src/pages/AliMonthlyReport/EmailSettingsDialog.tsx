import { Loader2, Mail, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { AliMonthlyReportConfigResponse } from '@shared/api.interface';
import { useEmailSettings } from './use-email-settings';

export function EmailSettingsDialog({ open, identity, onOpenChange, onSaved }: {
  open: boolean; identity: string; onOpenChange: (open: boolean) => void; onSaved: (config: AliMonthlyReportConfigResponse) => void;
}) {
  const form = useEmailSettings(open, identity, onSaved);
  const fieldClass = 'h-12 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-base text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-500';
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-blue-700"><Mail className="h-5 w-5" />邮箱配置</DialogTitle>
        <DialogDescription className="sr-only">用于发送本平台月报。保存配置不会发送邮件，也不会改变本页收件人和邮件主题。</DialogDescription>
      </DialogHeader>
      <form noValidate className="min-w-0 space-y-5" onSubmit={event => { event.preventDefault(); void form.save().then(saved => { if (saved) onOpenChange(false); }); }}>
        {form.loading && <p role="status" className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />正在读取邮箱配置…</p>}
        <label className="block space-y-2"><span className="text-sm font-semibold text-slate-900">发件 QQ 邮箱</span>
          <input type="email" autoComplete="off" inputMode="email" className={fieldClass} value={form.senderEmail} onChange={event => form.setSenderEmail(event.target.value)} disabled={form.locked} maxLength={254} placeholder="例如 123456@qq.com" />
        </label>
        <label className="block space-y-2"><span className="text-sm font-semibold text-slate-900">邮箱授权码</span>
          <input type="password" autoComplete="new-password" spellCheck={false} className={fieldClass} value={form.authCode} onChange={event => form.setAuthCode(event.target.value)} disabled={form.locked} maxLength={80} placeholder={form.settings?.authCodeConfigured ? '已配置，留空保持不变' : '请输入 16 位邮箱授权码'} aria-describedby="monthly-email-code-help" />
          <span id="monthly-email-code-help" className="block text-sm leading-6 text-slate-500">使用 QQ 邮箱开启 SMTP 后提供的授权码，不是邮箱登录密码。首次配置或更换邮箱时需要填写。</span>
        </label>
        {form.settings && <p className="text-sm text-slate-500">当前授权码：{form.settings.authCodeConfigured ? '已配置' : '未配置'}</p>}
        {form.unavailable && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">邮箱配置暂不能修改，请联系管理员核对。当前输入已保留。</p>}
        {form.error && <p role="alert" className="break-words rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm leading-6 text-rose-800">{form.error}</p>}
        {form.latest && <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="break-all">最新发件邮箱：{form.latest.senderEmail || '未配置'}</p>
          <p>当前输入尚未提交，采用最新版本后会保留输入供你再次确认。</p>
          <Button type="button" variant="outline" className="h-auto min-h-11 whitespace-normal" onClick={form.adoptLatest} disabled={form.saving || !form.canSave}>已核对，使用最新配置版本</Button>
        </div>}
        <DialogFooter className="border-t border-slate-100 pt-4">
          <Button type="button" variant="ghost" className="min-h-11 sm:mr-auto" onClick={() => void form.load()} disabled={form.loading || form.saving}><RefreshCw className="h-4 w-4" />重新读取</Button>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" className="min-h-11 bg-blue-600 hover:bg-blue-700" disabled={form.loading || form.saving || !form.canSave || form.blocked || (form.conflict && !form.uncertain)}>
            {form.saving && <Loader2 className="h-4 w-4 animate-spin" />}{form.saving ? '保存中…' : form.uncertain ? '使用原请求重试' : '保存配置'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
