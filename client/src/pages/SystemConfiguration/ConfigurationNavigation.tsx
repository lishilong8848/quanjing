import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';

export const CONFIGURATION_GROUPS = [
  { id: 'access', label: '账号与权限', tabs: [['accounts', '账号权限'], ['external', '外部飞书人员'], ['external-employees', '姓名账号'], ['roles', '角色模板'], ['permission-requests', '权限申请'], ['matrix', '权限矩阵']] },
  { id: 'people', label: '人员与岗位', tabs: [['personnel', '人员与岗位'], ['source', '岗位来源'], ['archive-corrections', '资料纠错']] },
  { id: 'handover', label: '岗位交接', tabs: [['handover-preview', '交接预览'], ['handover', '办理交接']] },
  { id: 'notifications', label: '通知与审计', tabs: [['cards', '卡片人员'], ['audit', '变更记录']] },
] as const;
export function ConfigurationNavigation({ tab, onChange, permissionPending, correctionPending }: { tab: string; onChange: (tab: string) => void; permissionPending?: number; correctionPending?: number }) {
  const group = CONFIGURATION_GROUPS.find(group => group.tabs.some(item => item[0] === tab)) || CONFIGURATION_GROUPS[0];
  const pending = (value: string) => value === 'permission-requests' ? permissionPending : value === 'archive-corrections' ? correctionPending : undefined;
  return <nav className="space-y-3 rounded-lg border bg-card p-3" aria-label="系统配置导航"><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{CONFIGURATION_GROUPS.map(item => <Button key={item.id} variant={item.id === group.id ? 'default' : 'ghost'} className="h-auto min-h-11 whitespace-normal px-2 py-2" aria-pressed={item.id === group.id} onClick={() => { if (item.id !== group.id) onChange(item.tabs[0][0]); }}>{item.label}{((item.id === 'access' ? permissionPending : item.id === 'people' ? correctionPending : 0) || 0) > 0 && <Badge variant="outline" className="border-current text-current">{item.id === 'access' ? permissionPending : correctionPending}</Badge>}</Button>)}</div>
    <label className="block space-y-1 text-sm sm:hidden"><span>{group.label}功能</span><select className="config-select min-h-11 w-full" value={tab} onChange={event => onChange(event.target.value)}>{group.tabs.map(([value, label]) => <option key={value} value={value}>{label}{pending(value) !== undefined ? `（待处理 ${pending(value)}）` : ''}</option>)}</select></label>
    <TabsList className="hidden h-auto min-h-11 w-full flex-wrap justify-start gap-1 bg-transparent p-0 sm:flex">{group.tabs.map(([value, label]) => <TabsTrigger key={value} value={value} className="min-h-11 whitespace-normal px-3">{label}{pending(value) !== undefined && <Badge variant="outline">{pending(value)}</Badge>}</TabsTrigger>)}</TabsList>
  </nav>;
}
