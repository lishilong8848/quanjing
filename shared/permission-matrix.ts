import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal, type AccessRole, type BuildingAdminBuilding } from './access-control.interface';
import type { ManagedAccount, CardRoleRule, CardRoleCode } from './access-configuration.interface';
import { PAGE_ACCESS_CATALOG, canReadPage, effectiveAccountPagePaths, type RolePageRules } from './page-access';
import { BUSINESS_PERMISSION_CATALOG, decideBusinessPermission, isProfessionalBusinessPrincipal, personalPermissionPagePaths, type BusinessAction, type BusinessModule } from './business-permissions';
import { PROFESSIONAL_SPECIALTIES, type ProfessionalSpecialty } from './professional-access';

export type MatrixState = 'all' | 'partial' | 'none' | 'conditional' | 'unknown' | 'disabled';
export interface MatrixTarget { building: BuildingAdminBuilding; specialty: ProfessionalSpecialty; }
export interface MatrixAction {
  module: BusinessModule;
  action: BusinessAction;
  state: MatrixState;
  allowed: MatrixTarget[];
  denied: MatrixTarget[];
  sources: string[];
  note?: string;
}
export interface MatrixCardDuty { name: string; building: BuildingAdminBuilding | null; version: number; }
export interface MatrixCell {
  path: string; label: string; group: string; module?: BusinessModule;
  read: MatrixState; operations: MatrixState; actions: MatrixAction[];
  approval: MatrixState; notification: MatrixState;
  cardDuties: MatrixCardDuty[]; notes: string[];
}
export interface MatrixSubject {
  id: string; name: string; principal: AccessPrincipal; enabled: boolean;
  account?: ManagedAccount; roleOnly?: boolean;
}
export interface MatrixOptions {
  pageRules?: RolePageRules; cardRules?: readonly CardRoleRule[]; appId?: string;
  building?: BuildingAdminBuilding; specialty?: ProfessionalSpecialty;
}
export function matrixAccountSubject(account: ManagedAccount): MatrixSubject {
  if (account.permissionsRevoked) return { id:account.id,name:account.name,account:{...account,pagePaths:undefined},
    enabled:account.guestLoginAllowed === true && !account.deleted,
    principal:{role:'guest',purchaseBuilding:null,accountId:account.id,authorizationVersion:account.version} };
  return { id: account.id, name: account.name, account, enabled: account.enabled && !account.deleted && account.personnelActive !== false,
    principal: { role: account.role, purchaseBuilding: account.building, buildings: account.buildings,
      specialties: account.specialties, personalRules: account.personalRules, accountId: account.id, authorizationVersion: account.version } };
}
export function matrixRoleSubject(role: AccessRole, name: string): MatrixSubject {
  return { id: role, name, roleOnly: true, enabled: true, principal: { role, purchaseBuilding: null } };
}
const sourceLabels = { role: '角色默认', allow: '个人增补', deny: '个人限制', none: '无授权' };
const cardLabels: Record<CardRoleCode,string> = { purchase_manager: '采购经理审批', purchase_approvers: '采购审批', purchase_executor: '综合采购执行', building_executor: '楼栋自采执行', warehouse_responsible: '库房审批', warehouse_notify: '库房知会', contract_notify: '合同通知' };
const cardCodes: Partial<Record<BusinessModule,{ approval: CardRoleCode[]; notification: CardRoleCode[]; execution: CardRoleCode[] }>> = {
  purchase: { approval: ['purchase_manager','purchase_approvers'], notification: [], execution: ['purchase_executor','building_executor'] },
  inventory: { approval: ['warehouse_responsible'], notification: ['warehouse_notify'], execution: [] },
  stocktake: { approval: ['warehouse_responsible'], notification: ['warehouse_notify'], execution: [] },
  contracts: { approval: [], notification: ['contract_notify'], execution: [] },
};
const scopedCardCodes = new Set<CardRoleCode>(['building_executor','warehouse_responsible','warehouse_notify']);
function cardinality(allowed: number, total: number): MatrixState { return allowed === 0 ? 'none' : allowed === total ? 'all' : 'partial'; }
function cardState(subject: MatrixSubject, codes: readonly CardRoleCode[], options: MatrixOptions): { state: MatrixState; duties: MatrixCardDuty[] } {
  if (!codes.length || !subject.account?.openId || subject.account.appId !== options.appId) return { state:'unknown', duties:[] };
  const slots = codes.flatMap(code => (scopedCardCodes.has(code) ? options.building ? [options.building] : [...BUILDING_ADMIN_BUILDINGS] : [null]).map(building => ({ code,building })));
  const assigned: MatrixCardDuty[] = []; let known = 0, matching = 0;
  for (const slot of slots) {
    const rules = options.cardRules?.filter(rule => rule.appId === options.appId && rule.code === slot.code && rule.building === slot.building) || [];
    if (rules.length !== 1) continue;
    known += 1;
    if (rules[0].members.some(member => member.openId === subject.account!.openId)) {
      matching += 1; assigned.push({ name:cardLabels[slot.code], building:slot.building, version:rules[0].version });
    }
  }
  return { state: known !== slots.length ? matching ? 'partial' : 'unknown' : cardinality(matching,slots.length), duties:assigned };
}
function actionSummary(actions: MatrixAction[]): MatrixState {
  if (!actions.length) return 'none';
  if (actions.every(item => item.state === 'disabled')) return 'disabled';
  if (actions.some(item => item.state === 'unknown')) return 'unknown';
  if (actions.some(item => item.state === 'conditional')) return 'conditional';
  if (actions.every(item => item.state === 'all')) return 'all';
  return actions.some(item => item.state === 'all' || item.state === 'partial') ? 'partial' : 'none';
}
export function buildPermissionMatrix(subject: MatrixSubject, options: MatrixOptions = {}): MatrixCell[] {
  const principal = subject.principal;
  const paths = personalPermissionPagePaths(principal,effectiveAccountPagePaths(principal.role,options.pageRules,subject.account?.permissionsRevoked ? undefined : subject.account?.pagePaths));
  const targets: MatrixTarget[] = (options.building ? [options.building] : BUILDING_ADMIN_BUILDINGS).flatMap(building => (options.specialty ? [options.specialty] : PROFESSIONAL_SPECIALTIES).map(specialty => ({ building,specialty })));
  return PAGE_ACCESS_CATALOG.map(page => {
    const definitions = BUSINESS_PERMISSION_CATALOG.filter(item => item.page === page.path);
    const definition = definitions[0], notes: string[] = [];
    if (subject.account?.pagePaths?.includes(page.path)) notes.push('个人页面读取增补');
    if (subject.account?.permissionsRevoked) notes.push(subject.account.guestLoginAllowed ? '业务权限已收回，仅保留游客登录和公开页面读取。' : '业务权限已收回，账号登录已停用。');
    const readable = canReadPage(principal.role,page.path,paths);
    let read: MatrixState = subject.enabled ? readable ? 'all' : 'none' : 'disabled';
    if (subject.enabled && readable && definition?.scoped && isProfessionalBusinessPrincipal({ ...principal,permissionContext:{ module:definition.id,action:'read' } })) {
      read = subject.roleOnly ? 'conditional' : cardinality(targets.filter(target => definitions.some(module => decideBusinessPermission(principal,{ module:module.id,action:'read',...target }).allowed)).length,targets.length);
    }
    if (!subject.enabled) notes.push('账号已停用；既有卡片是否已撤销需单独核对或交接。');
    const actions = definitions.flatMap(module => (module.actions as readonly BusinessAction[]).filter(action => action !== 'read').map<MatrixAction>(action => {
      if (!subject.enabled) return { module:module.id,action,state:'disabled',allowed:[],denied:[],sources:[] };
      const context = { module:module.id,action };
      const contextual = { ...principal,permissionContext:context };
      if (subject.roleOnly && module.scoped && ['professional_engineer','professional_admin','building_admin','inventory_admin','purchase_applicant'].includes(principal.role)) {
        return { module:module.id,action,state:'conditional',allowed:[],denied:[],sources:['角色默认'],note:'须结合人员实际任职楼栋、专业判断。' };
      }
      if (principal.role !== 'admin' && !isProfessionalBusinessPrincipal(contextual)) {
        return { module:module.id,action,state: ['guest','site_member'].includes(principal.role) ? 'none' : 'unknown',allowed:[],denied:[],sources:[],note: ['guest','site_member'].includes(principal.role) ? undefined : '旧业务还按单据阶段、申请人和职责判断，此处不推定完整操作权限。' };
      }
      const evaluations = (module.scoped ? targets : [undefined]).map(target => ({ target,decision:decideBusinessPermission(contextual,{ ...context,...target }) }));
      return { module:module.id,action,state:cardinality(evaluations.filter(item => item.decision.allowed).length,evaluations.length),
        allowed:evaluations.flatMap(item => item.target && item.decision.allowed ? [item.target] : []),
        denied:evaluations.flatMap(item => item.target && item.decision.source === 'deny' ? [item.target] : []),
        sources:[...new Set(evaluations.map(item => sourceLabels[item.decision.source]))].filter(label => label !== '无授权') };
    }));
    let operations = actionSummary(actions);
    if (!readable && actions.some(action => action.state === 'all' || action.state === 'partial' || action.state === 'conditional')) notes.push('页面读取未开放；业务操作仍按原角色、楼栋、专业和个人规则判断。');
    if (!definitions.length) {
      operations = !subject.enabled ? 'disabled' : !readable || page.group === 'platform' ? 'none' : 'unknown';
      if (page.path === '/monthly-schedule' && subject.enabled && readable && principal.role === 'site_member') {
        operations = 'conditional'; notes.push('可查看全部排班组件并提交本人申请；他人数据修改按原权限。');
      } else if (page.path === '/monthly-schedule' && subject.enabled && readable && principal.role === 'guest') operations = 'none';
      else if (operations === 'unknown') notes.push('页面操作尚未纳入统一动作目录，需核对具体业务规则。');
    }
    if (subject.roleOnly && definitions.some(module => module.scoped) && actions.some(action => action.state === 'conditional')) notes.push('该角色需要结合任职楼栋和专业，不能直接视为全基地权限。');
    const codes = definition ? cardCodes[definition.id] : undefined;
    const approval = cardState(subject,codes?.approval || [],options), notification = cardState(subject,codes?.notification || [],options);
    const execution = cardState(subject,codes?.execution || [],options);
    if (codes && (approval.state === 'unknown' || notification.state === 'unknown')) notes.push('默认流程人员尚未完整纳入矩阵；页面角色不能替代卡片职责。');
    const cardDuties = [...approval.duties,...notification.duties,...execution.duties];
    if (cardDuties.length) notes.push('此处展示新流程职责；既有单据仍需核对其人员快照和当前阶段。');
    if (execution.duties.length) notes.push('卡片执行职责独立配置，网页操作仍受业务规则约束。');
    return { path:page.path,label:page.label,group:page.group,module:definition?.id,read,operations,actions,
      approval:page.group === 'platform' ? 'none' : subject.enabled ? approval.state : 'unknown', notification:page.group === 'platform' ? 'none' : subject.enabled ? notification.state : 'unknown',cardDuties,notes };
  });
}
