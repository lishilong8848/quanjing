import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Settings, Users, Bell, History, RefreshCw, Loader2, Grid2X2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useAccess } from '@/access/AccessProvider';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AccessConfigurationResponse, ManagedAccount } from '@shared/access-configuration.interface';
import { PagePermissionPanel } from './PagePermissionPanel';
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

export default function SystemConfigurationPage() {
  const configuration = useConfiguration();
  const { accountId, refreshSession, displayName } = useAccess();
  const [tab, setTab] = useState('accounts'), [editor, setEditor] = useState<{ account?: ManagedAccount; external?: boolean }>();
  const [cardsVisited, setCardsVisited] = useState(false), [previewGeneration, setPreviewGeneration] = useState(0);
  const refresh = () => { setPreviewGeneration(value => value + 1); void configuration.refresh(); };
  const changeTab = useCallback((next: string) => { if (next === 'cards') setCardsVisited(true); setTab(next); }, []);
  const editAccount = useCallback((account?: ManagedAccount) => setEditor({ account }), []);
  const editExternal = useCallback((account?: ManagedAccount) => setEditor({ account, external: true }), []);
  const groupedAccounts = useMemo(() => {
    const accounts = configuration.data?.accounts || [], known = new Set(configuration.people.map(person => person.openId));
    const external = accounts.filter(account => account.kind === 'feishu' && (account.external || (configuration.peopleReady && !configuration.peopleError && account.openId && !known.has(account.openId))));
    const ids = new Set(external.map(account => account.id));
    return { internal: accounts.filter(account => !ids.has(account.id) && account.loginMethod !== 'personnel-password'), external, employees: accounts.filter(account => account.loginMethod === 'personnel-password') };
  }, [configuration.data?.accounts, configuration.people, configuration.peopleReady, configuration.peopleError]);
  const showAccounts = useCallback(() => changeTab('accounts'), [changeTab]);
  const showSource = useCallback(() => changeTab('source'), [changeTab]);
  const cardsSaved = useCallback((result: AccessConfigurationResponse) => { configuration.commit(result); toast.success('卡片人员已保存'); }, [configuration.commit]);
  const [auditQuery, setAuditQuery] = useState('');
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
  const audit = useMemo(() => configuration.data?.audit.filter(item => !auditQuery || `${item.actorName} ${item.target} ${item.action}`.includes(auditQuery)).slice(0,100) || [], [configuration.data?.audit, auditQuery]);
  useEffect(() => { const handler = () => { setPreviewGeneration(value => value + 1); void configuration.refresh(); }; window.addEventListener('configuration-refresh-request', handler); return () => window.removeEventListener('configuration-refresh-request', handler); }, [configuration.refresh]);
  const saved = useCallback((result: AccessConfigurationResponse, editedId?: string) => {
    configuration.commit(result); setEditor(undefined); toast.success('配置已保存');
    if (!accountId || accountId === editedId) void refreshSession();
  }, [configuration.commit, accountId, refreshSession]);
  return <main className="configuration-page mx-auto w-full max-w-7xl space-y-6 px-4 py-6 md:px-6 md:py-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><div className="flex size-11 items-center justify-center rounded-lg border bg-card text-primary"><Settings className="size-6" /></div><h1 className="text-2xl font-semibold tracking-tight">配置</h1></div><div className="flex items-center gap-3"><span className="max-w-48 truncate text-sm text-muted-foreground" title={displayName}>{displayName || '管理员共享入口'}</span><Button variant="outline" disabled={configuration.loading} onClick={refresh}>{configuration.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button></div></header>
    {configuration.error && <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{configuration.error}</p>}
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"><div className="space-y-1 text-sm"><p className="font-medium">人员权限同步 · 每日 02:00</p><p className="text-muted-foreground" role="status">{syncing ? '正在同步，现有授权保持' : configuration.data?.personnelSync?.lastSuccessAt ? `上次成功：${new Date(configuration.data.personnelSync.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}` : '尚未同步'}</p>{(syncError || configuration.data?.personnelSync?.status === 'error') && <p role="alert" className="text-destructive">{syncError || configuration.data?.personnelSync?.error}</p>}{configuration.data?.personnelSync?.status === 'success' && configuration.data.personnelSync.warning && <p role="status" className="text-muted-foreground">{configuration.data.personnelSync.warning}</p>}</div><Button variant="outline" disabled={syncing || !configuration.data} onClick={() => void syncPersonnel()}>{syncing && <Loader2 className="size-4 animate-spin" />}{syncing ? '同步中…' : '立即同步'}</Button></section>
    {configuration.loading && !configuration.data ? <div className="rounded-lg border bg-card p-10 text-center text-muted-foreground" role="status">正在加载配置…</div> : configuration.data && <Tabs value={tab} onValueChange={changeTab} className="gap-5">
      <TabsList className="h-auto min-h-11 w-full flex-wrap justify-start sm:w-fit"><TabsTrigger value="accounts" className="px-4"><Users />账号权限</TabsTrigger><TabsTrigger value="external" className="px-4"><Users />外部飞书人员</TabsTrigger><TabsTrigger value="external-employees" className="px-4"><Users />姓名账号</TabsTrigger><TabsTrigger value="pages" className="px-4"><Settings />页面权限</TabsTrigger><TabsTrigger value="matrix" className="px-4"><Grid2X2 />权限矩阵</TabsTrigger><TabsTrigger value="personnel" className="px-4"><Users />人员与岗位</TabsTrigger><TabsTrigger value="source" className="px-4"><ShieldCheck />岗位来源</TabsTrigger><TabsTrigger value="handover-preview" className="px-4"><History />交接预览</TabsTrigger><TabsTrigger value="handover" className="px-4"><History />岗位交接</TabsTrigger><TabsTrigger value="cards" className="px-4"><Bell />卡片人员</TabsTrigger><TabsTrigger value="audit" className="px-4"><History />变更记录</TabsTrigger></TabsList>
      {configuration.peopleLoading ? <p className="text-xs text-muted-foreground" role="status">人员资料正在更新，现有配置可继续编辑。</p> : configuration.peopleError && <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert"><span>人员资料加载失败，现有配置保留。{configuration.peopleError}</span><Button variant="link" size="sm" className="h-auto p-0" onClick={() => void configuration.refreshPeople()}>重试</Button></div>}
      <TabsContent value="accounts" forceMount className="data-[state=inactive]:hidden"><AccountPanel accounts={groupedAccounts.internal} onEdit={editAccount} /></TabsContent>
      <TabsContent value="external" forceMount className="data-[state=inactive]:hidden">{(!configuration.peopleReady || configuration.peopleError) && <p className="mb-3 text-xs text-muted-foreground">人员目录尚未确认，未分组的已有账号暂保留在账号权限中。</p>}<AccountPanel accounts={groupedAccounts.external} external onEdit={editExternal} /></TabsContent>
      <TabsContent value="external-employees" forceMount className="data-[state=inactive]:hidden"><AccountPanel accounts={groupedAccounts.employees} personnelPassword onEdit={editAccount} /></TabsContent>
      <TabsContent value="cards" forceMount className="data-[state=inactive]:hidden">{cardsVisited && <CardPanel key={`${accountId || 'legacy'}:${previewGeneration}`} data={configuration.data} people={configuration.people} onSaved={cardsSaved} onAccounts={showAccounts} onSource={showSource} />}</TabsContent>
      <TabsContent value="pages" forceMount className="data-[state=inactive]:hidden"><PagePermissionPanel data={configuration.data} onSaved={result => { configuration.commit(result); void refreshSession(); }} /></TabsContent>
      <TabsContent value="matrix"><PermissionMatrixPanel data={configuration.data} /></TabsContent>
      <TabsContent value="personnel"><PersonnelOverviewPanel overview={configuration.personnelOverview} loading={configuration.peopleLoading} error={configuration.peopleError} onRefresh={()=>void configuration.refreshPeople()} onPreview={id=>{setHandoverFrom(id);changeTab('handover-preview');}} /></TabsContent>
      <TabsContent value="source"><PersonnelSourcePanel key={accountId || 'legacy'} data={configuration.data} accountId={accountId || 'legacy'} onSaved={configuration.commit} /></TabsContent>
      <TabsContent value="handover-preview"><PersonnelPreviewPanel overview={configuration.personnelOverview} initialFrom={handoverFrom} revision={configuration.data.revision} onRefresh={()=>void configuration.refreshPeople()} /></TabsContent>
      <TabsContent value="handover"><PersonnelHandoverPanel key={accountId || 'legacy'} overview={configuration.personnelOverview} accountId={accountId || 'legacy'} onRefresh={()=>void configuration.refreshPeople()} /></TabsContent>
      <TabsContent value="audit"><section className="space-y-4"><input aria-label="搜索变更记录" placeholder="搜索操作人或对象" value={auditQuery} onChange={event => setAuditQuery(event.target.value)} className="config-select w-full sm:max-w-sm" /><div className="divide-y rounded-lg border bg-card">{audit.map(item => <article className="space-y-2 p-4" key={item.id}><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{item.actorName} · {item.action}</p><time className="text-xs text-muted-foreground">{new Date(item.at).toLocaleString('zh-CN', { hour12: false })}</time></div><p className="break-words text-sm">{item.target}</p><p className="break-words text-xs leading-5 text-muted-foreground">{item.before} → {item.after}</p></article>)}{!audit.length && <p className="p-8 text-center text-sm text-muted-foreground">{auditQuery ? '没有匹配记录' : '暂无变更记录'}</p>}</div></section></TabsContent>
    </Tabs>}
    {editor && configuration.data && <AccountEditor key={editor.account?.id || 'new'} account={editor.account} external={editor.external} data={configuration.data} people={configuration.people} onClose={() => setEditor(undefined)} onSaved={saved} />}
  </main>;
}
