import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Settings, RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAccess } from '@/access/AccessProvider';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { getAdminArchiveCorrectionSummary, getAdminPermissionRequestSummary } from '@/api/personal-access';
import type { AccessConfigurationResponse, ManagedAccount } from '@shared/access-configuration.interface';
import type { PersonnelPermissionRequest, PersonnelRequestCapacity } from '@shared/personnel-permission-request.interface';
import { RolesPanel } from './RolesPanel';
import { useAuthorizationRoles } from './role-model';
import { PermissionMatrixPanel } from './PermissionMatrixPanel';
import { AccountPanel } from './AccountPanel';
import { AccountEditor } from './AccountEditor';
import { CardPanel } from './CardPanel';
import { useConfiguration } from './model';
import './configuration.css';
import { synchronizePersonnel } from './api';
import { PersonnelOverviewPanel } from './PersonnelOverviewPanel';
import { PersonnelPreviewPanel } from './PersonnelPreviewPanel';
import { PersonnelHandoverPanel } from './PersonnelHandoverPanel';
import { PersonnelSourcePanel } from './PersonnelSourcePanel';
import { PermissionRequestsPanel } from './PermissionRequestsPanel';
import { ArchiveCorrectionsPanel } from './ArchiveCorrectionsPanel';
import { ConfigurationNavigation } from './ConfigurationNavigation';
import { AuditPanel } from './AuditPanel';

export default function SystemConfigurationPage() {
  const configuration = useConfiguration();
  const roles = useAuthorizationRoles(configuration.data?.revision);
  const { accountId, authorizationVersion, refreshSession, displayName } = useAccess();
  const [tab, setTab] = useState('accounts');
  const [editor, setEditor] = useState<{ account?: ManagedAccount; external?: boolean; requestContext?: PersonnelPermissionRequest }>();
  const [visited, setVisited] = useState(() => new Set(['accounts']));
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const [permissionPending, setPermissionPending] = useState<number>(), [correctionPending, setCorrectionPending] = useState<number>();
  const [permissionCapacity, setPermissionCapacity] = useState<PersonnelRequestCapacity>(), [correctionCapacity, setCorrectionCapacity] = useState<PersonnelRequestCapacity>();
  const countEpoch = useRef({ permission: 0, correction: 0 });
  const setPermissionCount = useCallback((count: number) => { countEpoch.current.permission++; setPermissionPending(count); }, []);
  const setCorrectionCount = useCallback((count: number) => { countEpoch.current.correction++; setCorrectionPending(count); }, []);
  const refresh = useCallback(() => { setPreviewGeneration(value => value + 1); void configuration.refresh(); void roles.refresh(); }, [configuration.refresh, roles.refresh]);
  const changeTab = useCallback((next: string) => { setVisited(current => new Set([...current, next])); setTab(next); }, []);
  const groupedAccounts = useMemo(() => {
    const accounts = configuration.data?.accounts || [], known = new Set(configuration.people.map(person => person.openId));
    const external = accounts.filter(account => account.kind === 'feishu' && (account.external || (!account.siteMember && !account.personnelIdentity && configuration.peopleReady && !configuration.peopleError && account.openId && !known.has(account.openId))));
    const ids = new Set(external.map(account => account.id));
    return { internal: accounts.filter(account => !ids.has(account.id) && account.loginMethod !== 'personnel-password'), external, employees: accounts.filter(account => account.loginMethod === 'personnel-password') };
  }, [configuration.data?.accounts, configuration.people, configuration.peopleReady, configuration.peopleError]);
  const editAccount = useCallback((account?: ManagedAccount) => setEditor({ account, external: !!account && groupedAccounts.external.some(item => item.id === account.id) }), [groupedAccounts.external]);
  const editExternal = useCallback((account?: ManagedAccount) => setEditor({ account, external: true }), []);
  const showAccounts = useCallback(() => changeTab('accounts'), [changeTab]);
  const showSource = useCallback(() => changeTab('source'), [changeTab]);
  const cardsSaved = useCallback((result: AccessConfigurationResponse) => { configuration.commit(result); toast.success('卡片人员已保存'); }, [configuration.commit]);
  const [handoverFrom, setHandoverFrom] = useState<string>();
  const [syncing, setSyncing] = useState(false), [syncError, setSyncError] = useState('');
  const syncPending = useRef(false);
  async function syncPersonnel() {
    if (syncPending.current) return;
    syncPending.current = true; setSyncing(true); setSyncError('');
    try { configuration.commit(await synchronizePersonnel()); void configuration.refreshPeople(); }
    catch (failure) { setSyncError((failure as Error).message); }
    finally { syncPending.current = false; setSyncing(false); }
  }
  useEffect(() => {
    if (!configuration.data) return;
    const permissionEpoch = ++countEpoch.current.permission, correctionEpoch = ++countEpoch.current.correction;
    let alive = true;
    void getAdminPermissionRequestSummary().then(value => { if (alive && permissionEpoch === countEpoch.current.permission) { setPermissionPending(value.pending); setPermissionCapacity(value.capacity); } }, () => {});
    void getAdminArchiveCorrectionSummary().then(value => { if (alive && correctionEpoch === countEpoch.current.correction) { setCorrectionPending(value.pending); setCorrectionCapacity(value.capacity); } }, () => {});
    return () => { alive = false; };
  }, [accountId, configuration.data?.revision, previewGeneration]);
  useEffect(() => { const handler = () => { setPreviewGeneration(value => value + 1); void configuration.refresh(); }; window.addEventListener('configuration-refresh-request', handler); return () => window.removeEventListener('configuration-refresh-request', handler); }, [configuration.refresh]);
  const saved = useCallback((result: AccessConfigurationResponse, editedId?: string) => {
    configuration.commit(result); setEditor(undefined); toast.success('配置已保存');
    const current = result.accounts.find(account => account.id === accountId);
    if (!accountId || accountId === editedId || current && current.version !== authorizationVersion) void refreshSession();
  }, [configuration.commit, accountId, authorizationVersion, refreshSession]);
  return <main className="configuration-page mx-auto w-full max-w-7xl space-y-5 px-4 py-6 md:px-6 md:py-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><div className="flex size-11 items-center justify-center rounded-lg border bg-card text-primary"><Settings className="size-6" /></div><h1 className="text-2xl font-semibold tracking-tight">配置</h1></div><div className="flex items-center gap-3"><span className="max-w-48 truncate text-sm text-muted-foreground" title={displayName}>{displayName || '管理员共享入口'}</span><Button variant="outline" disabled={configuration.loading} onClick={refresh}>{configuration.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button></div></header>
    {configuration.error && <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{configuration.error}</p>}
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"><div className="space-y-1 text-sm"><p className="font-medium">人员权限同步 · 每日 02:00</p><p className="text-muted-foreground" role="status">{syncing ? '正在同步，现有授权保持' : configuration.data?.personnelSync?.lastSuccessAt ? `上次成功：${new Date(configuration.data.personnelSync.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}` : '尚未同步'}</p>{(syncError || configuration.data?.personnelSync?.status === 'error') && <p role="alert" className="text-destructive">{syncError || configuration.data?.personnelSync?.error}</p>}{configuration.data?.personnelSync?.status === 'success' && configuration.data.personnelSync.warning && <p role="status" className="text-muted-foreground">{configuration.data.personnelSync.warning}</p>}</div><Button variant="outline" disabled={syncing || !configuration.data} onClick={() => void syncPersonnel()}>{syncing && <Loader2 className="size-4 animate-spin" />}{syncing ? '同步中…' : '立即同步'}</Button></section>
    {configuration.loading && !configuration.data ? <div className="rounded-lg border bg-card p-10 text-center text-muted-foreground" role="status">正在加载配置…</div> : configuration.data && <Tabs value={tab} onValueChange={changeTab} className="gap-4">
      <ConfigurationNavigation tab={tab} onChange={changeTab} permissionPending={permissionPending} correctionPending={correctionPending} />
      {[{ name: '权限申请', capacity: permissionCapacity, tab: 'permission-requests' }, { name: '资料纠错', capacity: correctionCapacity, tab: 'archive-corrections' }].filter(item => item.capacity && item.capacity.level !== 'normal').map(item => <div key={item.tab} role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><p>{item.name}记录{item.capacity!.level === 'full' ? '容量已满' : '接近容量上限'}：{item.capacity!.requests} / {item.capacity!.maxRequests} 条。请及时核对并导出记录，系统不会自动清理。</p><Button variant="outline" size="sm" onClick={() => changeTab(item.tab)}>查看记录</Button></div>)}
      {configuration.peopleLoading ? <p className="text-xs text-muted-foreground" role="status">人员资料正在更新，现有配置可继续编辑。</p> : configuration.peopleError && <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert"><span>人员资料加载失败，现有配置保留。{configuration.peopleError}</span><Button variant="link" size="sm" className="h-auto p-0" onClick={() => void configuration.refreshPeople()}>重试</Button></div>}
      <TabsContent value="permission-requests" forceMount className="data-[state=inactive]:hidden">{visited.has('permission-requests') && <PermissionRequestsPanel key={accountId || 'legacy'} revision={configuration.data.revision} onPendingCount={setPermissionCount} onEditAccount={(id, requestContext) => { const account = configuration.data?.accounts.find(item => item.id === id); if (!account) return false; setEditor({ account, requestContext, external: groupedAccounts.external.some(item => item.id === id) }); return true; }} />}</TabsContent>
      <TabsContent value="accounts" forceMount className="data-[state=inactive]:hidden"><AccountPanel accounts={groupedAccounts.internal} allAccounts={configuration.data.accounts} appId={configuration.data.appId} templates={roles.data?.roles} onEdit={editAccount} /></TabsContent>
      <TabsContent value="external" forceMount className="data-[state=inactive]:hidden">{visited.has('external') && <>{(!configuration.peopleReady || configuration.peopleError) && <p className="mb-3 text-xs text-muted-foreground">人员目录尚未确认，未分组的已有账号暂保留在账号权限中。</p>}<AccountPanel accounts={groupedAccounts.external} allAccounts={configuration.data.accounts} appId={configuration.data.appId} templates={roles.data?.roles} external onEdit={editExternal} /></>}</TabsContent>
      <TabsContent value="external-employees" forceMount className="data-[state=inactive]:hidden">{visited.has('external-employees') && <AccountPanel accounts={groupedAccounts.employees} allAccounts={configuration.data.accounts} appId={configuration.data.appId} templates={roles.data?.roles} personnelPassword onEdit={editAccount} />}</TabsContent>
      <TabsContent value="cards" forceMount className="data-[state=inactive]:hidden">{visited.has('cards') && <CardPanel key={accountId || 'legacy'} refreshGeneration={previewGeneration} data={configuration.data} people={configuration.people} onSaved={cardsSaved} onAccounts={showAccounts} onSource={showSource} />}</TabsContent>
      <TabsContent value="roles" forceMount className="data-[state=inactive]:hidden">{visited.has('roles') && <RolesPanel roles={roles.data} accounts={configuration.data.accounts} revision={configuration.data.revision} loading={roles.loading} error={roles.error} onRefresh={refresh} onSaved={result => { configuration.commit(result); void roles.refresh(); void refreshSession(); toast.success('角色已保存'); }} />}</TabsContent>
      <TabsContent value="matrix"><PermissionMatrixPanel data={configuration.data} templates={roles.data?.roles} onEditAccount={editAccount} /></TabsContent>
      <TabsContent value="personnel" forceMount className="data-[state=inactive]:hidden">{visited.has('personnel') && <PersonnelOverviewPanel overview={configuration.personnelOverview} templates={roles.data?.roles} loading={configuration.peopleLoading} error={configuration.peopleError} onRefresh={() => void configuration.refreshPeople()} onPreview={id => { setHandoverFrom(id); changeTab('handover-preview'); }} />}</TabsContent>
      <TabsContent value="source" forceMount className="data-[state=inactive]:hidden">{visited.has('source') && <PersonnelSourcePanel key={accountId || 'legacy'} data={configuration.data} accountId={accountId || 'legacy'} onSaved={configuration.commit} />}</TabsContent>
      <TabsContent value="archive-corrections" forceMount className="data-[state=inactive]:hidden">{visited.has('archive-corrections') && <ArchiveCorrectionsPanel key={accountId || 'legacy'} onPendingCount={setCorrectionCount} />}</TabsContent>
      <TabsContent value="handover-preview" forceMount className="data-[state=inactive]:hidden">{visited.has('handover-preview') && <PersonnelPreviewPanel overview={configuration.personnelOverview} initialFrom={handoverFrom} revision={configuration.data.revision} onBack={() => changeTab('personnel')} onRefresh={() => void configuration.refreshPeople()} />}</TabsContent>
      <TabsContent value="handover" forceMount className="data-[state=inactive]:hidden">{visited.has('handover') && <PersonnelHandoverPanel key={accountId || 'legacy'} overview={configuration.personnelOverview} accountId={accountId || 'legacy'} onRefresh={() => void configuration.refreshPeople()} />}</TabsContent>
      <TabsContent value="audit" forceMount className="data-[state=inactive]:hidden">{visited.has('audit') && <AuditPanel rows={configuration.data.audit} />}</TabsContent>
    </Tabs>}
    {editor && configuration.data && <AccountEditor key={editor.account?.id || 'new'} account={editor.account} requestContext={editor.requestContext} external={editor.external} data={configuration.data} people={configuration.people} roles={roles.data} rolesLoading={roles.loading} rolesError={roles.error} onRefreshRoles={refresh} onClose={() => setEditor(undefined)} onSaved={saved} />}
  </main>;
}
