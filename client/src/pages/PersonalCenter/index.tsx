import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, RefreshCw, UserRound } from 'lucide-react';
import { useAccess } from '@/access/AccessProvider';
import { PasswordChangeDialog } from '@/access/PasswordChangeDialog';
import { getPersonalProfile, listOwnPermissionRequests, type PersonalProfile } from '@/api/personal-access';
import type { PersonnelPermissionRequest } from '@shared/personnel-permission-request.interface';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PermissionEditor } from '../SystemConfiguration/PermissionEditor';
import { PermissionRequestForm } from './PermissionRequestForm';
import { PermissionRequestList } from './PermissionRequestList';
import { PersonalArchivePanel, PersonalArchiveSummary } from './PersonalArchivePanel';
import { personalArchiveIdentity, usePersonalArchive } from './use-personal-archive';
import '../SystemConfiguration/configuration.css';

export default function PersonalCenterPage() {
  const access = useAccess();
  // Identity changes remount all forms, clearing sensitive drafts belonging to the previous user.
  return <PersonalCenter key={`${access.accountId || ''}:${access.impersonation?.actorAccountId || ''}`} />;
}

function PersonalCenter() {
  const access = useAccess();
  const [profile, setProfile] = useState<PersonalProfile>(), [requests, setRequests] = useState<PersonnelPermissionRequest[]>([]);
  const [loading, setLoading] = useState(false), [profileError, setProfileError] = useState(''), [requestsError, setRequestsError] = useState('');
  const [changingPassword, setChangingPassword] = useState(false), [tab, setTab] = useState('archive');
  const archive = usePersonalArchive(personalArchiveIdentity(access));
  const pending = useRef(false), alive = useRef(true);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true; setLoading(true);
    const results = await Promise.allSettled([getPersonalProfile(), listOwnPermissionRequests()]);
    if (alive.current) {
      if (results[0].status === 'fulfilled') { setProfile(results[0].value); setProfileError(''); } else setProfileError((results[0].reason as Error).message);
      if (results[1].status === 'fulfilled') { setRequests(results[1].value); setRequestsError(''); } else setRequestsError((results[1].reason as Error).message);
      setLoading(false);
    }
    pending.current = false;
  }, []);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);
  const readOnly = !!access.impersonation;
  const refreshAll = () => { void refresh(); void archive.refresh(); };
  const profileUnavailable = <section className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">{loading ? '正在加载权限资料…' : '权限资料暂不可用，请点击刷新重试。'}</section>;
  return <main className="configuration-page mx-auto w-full max-w-6xl space-y-6 px-4 py-6 md:px-6 md:py-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="flex items-center gap-3 text-2xl font-semibold"><UserRound className="size-7 text-primary" />个人主页</h1><Button variant="outline" disabled={loading || archive.loading} onClick={refreshAll}>{loading || archive.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button></header>
    {readOnly && <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm">当前为管理员代登录，仅可查看此人的资料和权限，不能修改密码或提交权限申请。</p>}
    <PersonalArchiveSummary archive={archive} displayName={profile?.displayName || access.displayName || '当前账号'} />
    {profileError && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">权限资料读取失败，已有内容保留。{profileError}</p>}
    <Tabs value={tab} onValueChange={setTab} className="gap-5">
      <TabsList className="h-auto min-h-11 w-full flex-wrap justify-start sm:w-fit"><TabsTrigger value="archive">个人档案</TabsTrigger><TabsTrigger value="permissions">我的权限</TabsTrigger><TabsTrigger value="password">修改密码</TabsTrigger><TabsTrigger value="request">申请权限</TabsTrigger><TabsTrigger value="history">申请记录</TabsTrigger></TabsList>
      <TabsContent value="archive"><PersonalArchivePanel archive={archive} /></TabsContent>
      <TabsContent value="permissions">{profile ? <section className="rounded-lg border bg-card p-4 md:p-6">{profile.effectiveAuthorization ? <PermissionEditor principal={access} value={profile.effectiveAuthorization} catalog={profile.catalog} readOnly label="我的有效权限" /> : <p className="text-sm text-muted-foreground">此账号暂未提供可查询的个人权限配置，请联系管理员确认。</p>}</section> : profileUnavailable}</TabsContent>
      <TabsContent value="password">{profile ? <section className="space-y-4 rounded-lg border bg-card p-4 md:p-6"><h2 className="text-lg font-semibold">登录密码</h2><p className="text-sm leading-6 text-muted-foreground">{readOnly ? '代登录时不能修改本人密码。' : profile.canChangePassword ? '修改姓名登录密码，保存后需要重新登录。密码长度为 8 至 128 个字符。' : '当前账号不使用姓名密码登录，无需在此修改密码。飞书账号密码请在飞书中管理。'}</p><Button disabled={readOnly || !profile.canChangePassword} onClick={() => setChangingPassword(true)}><KeyRound className="size-4" />修改密码</Button></section> : profileUnavailable}</TabsContent>
      <TabsContent value="request" forceMount className="data-[state=inactive]:hidden">{profile ? <section className="rounded-lg border bg-card p-4 md:p-6">{readOnly ? <p className="text-sm text-muted-foreground">代登录时不能提交权限申请。</p> : <PermissionRequestForm catalog={profile.catalog} onSubmitted={request => setRequests(current => [request, ...current.filter(item => item.id !== request.id)])} />}</section> : profileUnavailable}</TabsContent>
      <TabsContent value="history">{requestsError && <p role="alert" className="mb-4 text-sm text-destructive">申请记录读取失败，已有记录保留。{requestsError}</p>}{profile ? <PermissionRequestList requests={requests} catalog={profile.catalog} /> : profileUnavailable}</TabsContent>
    </Tabs>
    {changingPassword && !readOnly && <PasswordChangeDialog open onClose={() => setChangingPassword(false)} onSuccess={access.passwordChanged} onLogout={async () => { if (await access.logout()) access.requestLogin('请使用新密码登录。'); }} />}
  </main>;
}
