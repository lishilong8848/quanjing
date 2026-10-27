import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccessConfigurationResponse, ConfigurationPerson } from '@shared/access-configuration.interface';
import { loadConfiguration, loadConfigurationPeople } from './api';
import type { PersonnelOverview } from '@shared/personnel-preview.interface';

export const ROLE_LABELS = { guest: '游客', site_member: '基地成员', professional_admin: '专业主管', professional_engineer: '专业工程师', admin: '管理员', editor: '子管理员', building_admin: '楼栋主管', inventory_admin: '库房管理员',
  purchase_admin: '采购与合同管理员', purchase_applicant: '采购申请人', construction_admin: '施工管理员', duty_editor: '值班编辑', supply_chain_admin: '采供存管理员' } as const;
export const CARD_LABELS = { purchase_manager: '采购经理审批', purchase_approvers: '旧采购审批人员', purchase_executor: '综合采购执行人', building_executor: '楼栋自采执行人',
  warehouse_responsible: '库房责任人员', warehouse_notify: '库房管理知会人', contract_notify: '合同通知人员' } as const;
export function accountStatus(account: { deleted: boolean; enabled: boolean; personnelActive?: boolean; permissionsRevoked?:boolean; guestLoginAllowed?:boolean }): string { return account.deleted ? '已删除' : account.permissionsRevoked ? account.guestLoginAllowed ? '仅游客登录' : '权限已收回' : account.personnelActive === false ? '人员表停用' : account.enabled ? '启用' : '停用'; }
export function useConfiguration() {
  const [data, setData] = useState<AccessConfigurationResponse>();
  const [people, setPeople] = useState<ConfigurationPerson[]>([]);
  const [error, setError] = useState('');
  const [peopleError, setPeopleError] = useState('');
  const [loading, setLoading] = useState(true);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [peopleReady, setPeopleReady] = useState(false);
  const [personnelOverview, setPersonnelOverview] = useState<PersonnelOverview>();
  const sequence = useRef(0);
  const peopleSequence = useRef(0);
  const metadata = useRef<AccessConfigurationResponse['accounts']>([]);
  const enrich = useCallback((value: AccessConfigurationResponse) => ({ ...value, accounts: value.accounts.map(account => {
    const person = metadata.current.find(item => item.id === account.id);
    return person && account.version === person.version ? { ...account, name: person.name, openId: person.openId } : account;
  }) }), []);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError('');
    try { const result = await loadConfiguration(); if (request === sequence.current) setData(enrich(result)); }
    catch (failure) { if (request === sequence.current) setError((failure as Error).message); }
    finally { if (request === sequence.current) setLoading(false); }
  }, [enrich]);
  const refreshPeople = useCallback(async () => {
    const request = ++peopleSequence.current;
    setPeopleLoading(true); setPeopleError('');
    try {
      const result = await loadConfigurationPeople();
      if (request !== peopleSequence.current) return;
      metadata.current = result.accounts;
      setPeople(result.people);
      setPeopleReady(true);
      setPersonnelOverview(result.personnelOverview);
      setData(current => current && current.appId === result.appId ? { ...current, accounts: current.accounts.map(account => {
        const enriched = result.accounts.find(person => person.id === account.id);
        return enriched && account.version === enriched.version ? { ...account, name: enriched.name, openId: enriched.openId } : account;
      }) } : current);
    } catch (failure) { if (request === peopleSequence.current) setPeopleError((failure as Error).message); }
    finally { if (request === peopleSequence.current) setPeopleLoading(false); }
  }, []);
  useEffect(() => { void refresh(); void refreshPeople(); return () => { sequence.current += 1; peopleSequence.current += 1; }; }, [refresh, refreshPeople]);
  const commit = useCallback((value: AccessConfigurationResponse) => {
    sequence.current += 1;
    setLoading(false);
    setData(current => !current || value.revision >= current.revision ? enrich(value) : current);
  }, [enrich]);
  return { data, people, personnelOverview, error, peopleError, loading, peopleLoading, peopleReady, refresh, refreshPeople, commit };
}
