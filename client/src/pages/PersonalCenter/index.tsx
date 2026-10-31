import { useCallback, useMemo, useRef, useState } from 'react';
import { KeyRound, Loader2, RefreshCw, UserRound } from 'lucide-react';
import { useAccess } from '@/access/AccessProvider';
import { PasswordChangeDialog } from '@/access/PasswordChangeDialog';
import { getPersonalProfile, listOwnArchiveCorrections, listOwnPermissionRequests } from '@/api/personal-access';
import type { PersonnelPermissionRequest, RequestedPermission } from '@shared/personnel-permission-request.interface';
import type { PersonnelArchiveCorrection } from '@shared/personnel-archive-correction.interface';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PermissionRequestForm, type PermissionRequestPrefill } from './PermissionRequestForm';
import { PermissionRequestList } from './PermissionRequestList';
import { PersonalArchivePanel, PersonalArchiveSummary } from './PersonalArchivePanel';
import { PermissionOverview } from './PermissionOverview';
import { ArchiveCorrectionForm, ArchiveCorrectionList } from './ArchiveCorrections';
import { personalArchiveIdentity, usePersonalArchive } from './use-personal-archive';
import { usePersonalCollection, usePersonalProfileResource } from './use-personal-resource';
import '../SystemConfiguration/configuration.css';

export default function PersonalCenterPage() {
  const access = useAccess();
  // Identity changes clear all sensitive drafts; authorization refreshes retain this person's work.
  return <PersonalCenter key={`${access.accountId || ''}:${access.impersonation?.actorAccountId || ''}`} />;
}

function PersonalCenter() {
  const access = useAccess();
  const loadProfile = useCallback(() => getPersonalProfile(), [access.authorizationVersion, access.principalFingerprint]);
  const profile = usePersonalProfileResource(loadProfile);
  const requests = usePersonalCollection(listOwnPermissionRequests);
  const corrections = usePersonalCollection(listOwnArchiveCorrections);
  const archive = usePersonalArchive(personalArchiveIdentity(access));
  const [changingPassword, setChangingPassword] = useState(false), [tab, setTab] = useState('archive');
  const [permissionView, setPermissionView] = useState('overview'), [archiveView, setArchiveView] = useState('profile');
  const [prefill, setPrefill] = useState<PermissionRequestPrefill>(), [notice, setNotice] = useState('');
  const prefillSequence = useRef(0), permissionAnchor = useRef<HTMLDivElement>(null);
  const readOnly = !!access.impersonation;
  const profileCurrent = profile.value?.authorizationVersion !== undefined && profile.value.authorizationVersion === access.authorizationVersion;
  const actor = useMemo(() => ({ ...access, ...(!access.effectiveAuthorization && profileCurrent && profile.value?.effectiveAuthorization ? { effectiveAuthorization: profile.value.effectiveAuthorization } : {}) }), [access, profileCurrent, profile.value]);
  const currentProfile = profile.value ? { ...profile.value, effectiveAuthorization: actor.effectiveAuthorization || null, ...(!profileCurrent ? { authorizationSummary: undefined, suggestedScopes: undefined } : {}) } : undefined;
  const anyLoading = profile.loading || requests.loading || corrections.loading || archive.loading;
  const refreshAll = () => { void profile.refresh(); void requests.refresh(); void corrections.refresh(); void archive.refresh(); };
  const requestPermission = (permission: RequestedPermission) => {
    setPrefill({ key: ++prefillSequence.current, permission }); setPermissionView('request');
    requestAnimationFrame(() => permissionAnchor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const updateRequest = (row: PersonnelPermissionRequest) => {
    requests.upsert(row);
    if (row.status === 'approved') { setNotice('此申请已授权，正在更新权限显示。'); void profile.refresh(); void access.refreshSession(); }
    else setNotice(row.status === 'cancelled' ? '权限申请已撤回，现有权限不变。' : '申请记录已同步，可在申请记录查看进度。');
  };
  const updateCorrection = (row: PersonnelArchiveCorrection) => { corrections.upsert(row); setNotice(row.status === 'cancelled' ? '资料核对申请已撤回。' : '资料核对申请已同步，请在核对记录查看反馈。'); };
  const profileUnavailable = <section className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">{profile.loading ? '正在加载权限资料…' : '权限资料暂不可用，请重试。'}{!profile.loading && <Button variant="link" onClick={() => void profile.refresh()}>重试权限资料</Button>}</section>;
  const pendingCount = requests.items.filter(row => row.status === 'pending').length + corrections.items.filter(row => row.status === 'pending').length;
  return <main className="configuration-page mx-auto w-full max-w-6xl space-y-4 px-3 py-4 sm:space-y-6 sm:px-4 md:px-6 md:py-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="flex items-center gap-2 text-xl font-semibold sm:text-2xl"><UserRound className="size-6 text-primary" />个人主页</h1><Button variant="outline" disabled={anyLoading} onClick={refreshAll}>{anyLoading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button></header>
    {readOnly && <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm">当前为管理员代登录，仅可查看此人的资料和权限，不能修改密码或提交申请。</p>}
    <PersonalArchiveSummary archive={archive} displayName={profile.value?.displayName || access.displayName || '当前账号'} />
    {notice && <div role="status" className="flex items-start justify-between gap-3 rounded-lg border bg-primary/5 p-3 text-sm text-primary"><p>{notice}</p><button className="shrink-0 underline" aria-label="关闭操作提示" onClick={() => setNotice('')}>知道了</button></div>}
    {profile.error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">权限资料读取失败，已有内容保留。{profile.error}</p>}
    <Tabs value={tab} onValueChange={setTab} className="gap-4">
      <TabsList className="grid h-auto min-h-11 w-full grid-cols-3 sm:w-fit"><TabsTrigger value="archive" className="min-w-0">个人档案</TabsTrigger><TabsTrigger value="permissions" className="min-w-0">权限与申请</TabsTrigger><TabsTrigger value="security" className="min-w-0">账户安全</TabsTrigger></TabsList>
      <TabsContent value="archive" forceMount className="space-y-4 data-[state=inactive]:hidden">
        <div className="flex flex-wrap gap-2" role="group" aria-label="个人档案栏目"><Button size="sm" variant={archiveView === 'profile' ? 'secondary' : 'ghost'} aria-pressed={archiveView === 'profile'} onClick={() => setArchiveView('profile')}>完整档案</Button><Button size="sm" variant={archiveView === 'corrections' ? 'secondary' : 'ghost'} aria-pressed={archiveView === 'corrections'} onClick={() => setArchiveView('corrections')}>资料核对与反馈</Button></div>
        <div hidden={archiveView !== 'profile'}><PersonalArchivePanel archive={archive} onCorrect={!readOnly ? () => setArchiveView('corrections') : undefined} /></div>
        <div hidden={archiveView !== 'corrections'} className="space-y-5">{!readOnly && <ArchiveCorrectionForm onSubmitted={updateCorrection} />}<ReadStatus loading={corrections.loading} error={corrections.error} label="核对记录" onRetry={() => void corrections.refresh()} /><ArchiveCorrectionList rows={corrections.items} onUpdated={updateCorrection} readOnly={readOnly} /></div>
      </TabsContent>
      <TabsContent value="permissions" forceMount className="space-y-4 data-[state=inactive]:hidden">
        <div ref={permissionAnchor} className="scroll-mt-24 space-y-2"><div className="flex flex-wrap gap-2" role="group" aria-label="权限与申请栏目">{[['overview', '我的权限'], ['request', '全部可申请权限'], ['history', `申请记录${requests.items.some(row => row.status === 'pending') ? ` · ${requests.items.filter(row => row.status === 'pending').length} 待审核` : ''}`]].map(([value, label]) => <Button key={value} size="sm" variant={permissionView === value ? 'secondary' : 'ghost'} aria-pressed={permissionView === value} onClick={() => setPermissionView(value)}>{label}</Button>)}</div>{pendingCount > 0 && <p className="text-xs text-muted-foreground">目前有 {pendingCount} 条权限或资料申请待处理。处理结果会显示在本页记录中。</p>}</div>
        <div hidden={permissionView !== 'overview'}>{currentProfile ? <PermissionOverview profile={currentProfile} principal={actor} readOnly={readOnly} onRequest={requestPermission} /> : profileUnavailable}</div>
        <div hidden={permissionView !== 'request'}>{currentProfile ? <section className="rounded-lg border bg-card p-4 md:p-6">{readOnly ? <p className="text-sm text-muted-foreground">代登录时不能提交权限申请。</p> : <PermissionRequestForm catalog={currentProfile.catalog} principal={actor} suggestedScopes={currentProfile.suggestedScopes} prefill={prefill} onSubmitted={updateRequest} />}</section> : profileUnavailable}</div>
        <div hidden={permissionView !== 'history'} className="space-y-4"><ReadStatus loading={requests.loading} error={requests.error} label="申请记录" onRetry={() => void requests.refresh()} />{profile.value ? <PermissionRequestList requests={requests.items} catalog={profile.value.catalog} onUpdated={updateRequest} readOnly={readOnly} /> : profileUnavailable}</div>
      </TabsContent>
      <TabsContent value="security">{profile.value ? <section className="space-y-4 rounded-lg border bg-card p-4 md:p-6"><h2 className="text-lg font-semibold">登录密码</h2><p className="text-sm leading-6 text-muted-foreground">{readOnly ? '代登录时不能修改本人密码。' : profile.value.canChangePassword ? '修改姓名登录密码，保存后需要重新登录。密码长度为 8 至 128 个字符，请勿与身份证号码相同。' : '当前账号不使用姓名密码登录，无需在此修改密码。飞书账号密码请在飞书中管理。'}</p>{profile.value.requiresPasswordChange && <p className="text-sm text-amber-700">当前使用初始凭据，须修改密码后继续使用。</p>}<Button disabled={readOnly || !profile.value.canChangePassword} onClick={() => setChangingPassword(true)}><KeyRound className="size-4" />修改密码</Button></section> : profileUnavailable}</TabsContent>
    </Tabs>
    {changingPassword && !readOnly && <PasswordChangeDialog open onClose={() => setChangingPassword(false)} onSuccess={access.passwordChanged} onLogout={async () => { if (await access.logout()) access.requestLogin('请使用新密码登录。'); }} />}
  </main>;
}

function ReadStatus({ loading, error, label, onRetry }: { loading: boolean; error: string; label: string; onRetry: () => void }) {
  return <>{loading && <p role="status" className="text-sm text-muted-foreground">正在更新{label}，已有内容仍可查看…</p>}{error && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><p>{label}更新失败，已有内容保留。{error}</p><Button variant="outline" size="sm" onClick={onRetry}>重试{label}</Button></div>}</>;
}
