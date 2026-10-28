import { buildSiteMemberDirectory } from './site-member-directory';
import { createHash } from 'node:crypto';
import { buildAuthorityPeople } from './personnel-authority.people';
import { buildAuthorityDuties, AUTHORITY_DUTY_FIELDS } from './personnel-authority.duties';
import { AUTHORITY_DUTY_TABLE_NAME, type PersonnelAuthoritySnapshot } from '../../../shared/personnel-authority.interface';
import type { SiteMemberIdentity } from './site-member-accounts';
import { DEFAULT_ACTIVE_PERSONNEL_VIEW_ID } from '../../modules/bitable-sync/active-personnel-directory';
import { readExternalEmployeeCredentials, type ExternalEmployeeCredential } from './external-employee-directory';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigurationPerson } from '../../../shared/access-configuration.interface';
import { extractDisplayText, fetchBitableRecords, getTenantAccessToken, pickField, resolveBitableAppToken, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { readEmployeeOnboardingConfig } from '../../modules/bitable-sync/employee-onboarding.config';
import { normalizeAccessDisplayName } from './access-display-name';
import { OPEN_ID_PATTERN } from './access-configuration.validation';
import { readPersonnelAuthorizationState } from './personnel-employment-state';
import { buildPersonnelEmploymentEvidence } from './personnel-employment-evidence';

export interface ConfigurationEmployee extends ConfigurationPerson { position: string; specialties: string; inactive: boolean; }
export interface PersonnelEmploymentEvidence { complete: boolean; entries: { personnelIdentity: string; openId?: string; inactive: boolean }[]; }
export interface ConfigurationDirectorySnapshot { appId: string; people: ConfigurationPerson[]; employees: ConfigurationEmployee[]; snapshotAt: number; personnelComplete: boolean; personnelProblems?: string[]; personnelWarnings?: string[]; externalEmployees?: ExternalEmployeeCredential[]; activeMembers?: SiteMemberIdentity[]; activeMembersComplete?: boolean; employmentState?: PersonnelEmploymentEvidence; personnelAuthority?: PersonnelAuthoritySnapshot; }

@Injectable()
export class AccessConfigurationDirectory {
  private readonly logger = new Logger(AccessConfigurationDirectory.name);
  private cached?: ConfigurationDirectorySnapshot;
  private pending?: Promise<ConfigurationDirectorySnapshot>;
  private pendingForced = false;
  constructor(private readonly http: HttpService) {}
  async read(force = false) {
    const appId = process.env.FEISHU_APP_ID?.trim() || '';
    if (!force && this.cached?.appId === appId && this.cached.snapshotAt > Date.now() - 5 * 60_000) return this.cached;
    if (this.pending) {
      if (!force || this.pendingForced) return this.pending;
      // A normal read may use caches. Wait for it, then coalesce a genuinely forced read.
      await this.pending.catch(() => undefined);
      return this.read(true);
    }
    this.pendingForced = force;
    const startedAt = Date.now();
    this.pending = (async () => {
      const source = readEmployeeOnboardingConfig();
      const appToken = await resolveBitableAppToken(this.http, { appToken: source.appToken, wikiToken: source.wikiToken, tableName: source.tableName, requestTimeoutMs: () => 8000 });
      const token = await getTenantAccessToken(this.http);
      const [fields, views, tables] = await Promise.all([
        this.metadata<{ field_name: string; type: number }>(appToken, `${source.tableId}/fields`, token),
        this.metadata<{ view_id: string; view_name: string }>(appToken, `${source.tableId}/views`, token),
        this.metadata<{ table_id: string; name: string }>(appToken, '', token),
      ]);
      const employmentCheckbox=fields.filter(field=>field.field_name==='离职/异动情况');
      // A requested checkbox omitted by Bitable represents unchecked; unknown schema or explicit invalid values remain unknown.
      const normalizeCheckbox=(record:BitableRecordItem):BitableRecordItem=>employmentCheckbox.length===1&&employmentCheckbox[0].type===7&&!Object.prototype.hasOwnProperty.call(record.fields||{},'离职/异动情况')
        ? {...record,fields:{...record.fields,'离职/异动情况':false}} : record;
      let externalEmployees: ExternalEmployeeCredential[] | undefined;
      const credentialWarnings: string[] = [];
      try { externalEmployees = await readExternalEmployeeCredentials(this.http, appId, appToken, source.tableId, token, fields, views, warning => credentialWarnings.push(warning)); }
      catch { credentialWarnings.push('姓名登录资料暂时无法同步，原有登录资料保留，请检查姓名账号视图。'); }
      const availableFields = new Set(fields.map(field => field.field_name));
      const fieldNames = ['姓名','员工姓名','员工','人员','飞书 open_id','open_id','Open ID','离职/异动情况','岗位','体系岗位','机楼/专业','机楼专业','权限身份','人员类型','任职职责'].filter(field => availableFields.has(field));
      if (!fieldNames.some(field => ['姓名','员工姓名','员工','人员'].includes(field))) throw new ServiceUnavailableException('人员表缺少姓名字段，请检查人员表配置');
      const records = (await fetchBitableRecords(this.http, { appToken, tableId: source.tableId, tableName: source.tableName,
        automaticFields: true, fieldNames,
        strict: true, allowStale: false, forceRefresh: force, cacheTtlMs: 5 * 60_000 })).map(normalizeCheckbox);
      const identityRecords = records.map(record => {
        const fields = record.fields || {};
        const explicitId = extractDisplayText(pickField(fields, ['飞书 open_id','open_id','Open ID']), '').trim();
        const employee = pickField(fields, ['员工姓名','员工','人员']);
        return OPEN_ID_PATTERN.test(explicitId) && (!employee || (Array.isArray(employee) && !employee.length))
          ? { ...record, fields: { ...fields, 员工姓名: [{ id: explicitId, name: extractDisplayText(fields.姓名, '').trim() }] } }
          : record;
      });
      const employees: ConfigurationEmployee[] = identityRecords.flatMap(record => {
        const fields = record.fields || {};
        const users = pickField(fields, ['员工姓名','员工','人员']);
        const explicit = extractDisplayText(pickField(fields, ['飞书 open_id','open_id','Open ID']), '').trim();
        const openId = OPEN_ID_PATTERN.test(explicit) ? explicit : Array.isArray(users) && users.length === 1 ? users[0]?.id : undefined;
        const name = normalizeAccessDisplayName(extractDisplayText(fields.姓名, '').trim() || (Array.isArray(users) ? users[0]?.name : ''));
        return typeof openId === 'string' && OPEN_ID_PATTERN.test(openId) && name ? [{ openId, name,
          position: extractDisplayText(pickField(fields, ['岗位','体系岗位']), '、').trim(),
          specialties: extractDisplayText(pickField(fields, ['机楼/专业','机楼专业']), '、').trim(), inactive: readPersonnelAuthorizationState(fields) === 'inactive' }] : [];
      });
      const people = employees.filter(person => !person.inactive)
        .map(person => ({ openId: person.openId, name: normalizeAccessDisplayName(person.name)! }));
      const activeRecords = (await fetchBitableRecords(this.http, { appToken, tableId: source.tableId, tableName: '在职人员',
        viewId: process.env.FEISHU_ORG_VIEW_ID?.trim() || process.env.FEISHU_ORGANIZATION_VIEW_ID?.trim() || DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
        automaticFields: true, fieldNames, strict: true, allowStale: false, forceRefresh: force, cacheTtlMs: 5 * 60_000 })).map(normalizeCheckbox);
      const { members: activeMembers, blockedOpenIds, warnings: personnelWarnings } = buildSiteMemberDirectory(activeRecords, appId, appToken, source.tableId);
      const organizationPeople = await this.organizationPeople(appToken, token, tables);
      const authority = buildAuthorityPeople(identityRecords, appId, appToken, source.tableId);
      const { warnings: employmentWarnings, ...employmentState } = buildPersonnelEmploymentEvidence(identityRecords, appId, appToken, source.tableId);
      personnelWarnings.push(...credentialWarnings, ...employmentWarnings);
      if (authority.problems.includes('人员姓名未维护')) personnelWarnings.push('部分人员姓名未维护，该人员暂不加入姓名选择，其他有效人员继续同步。');
      const dutyTables = tables.filter(table => table.name === AUTHORITY_DUTY_TABLE_NAME);
      const dutyProblems: string[] = [], dutyIssues: PersonnelAuthoritySnapshot['issues'] = [];
      let dutyRecords: BitableRecordItem[] = [];
      if (dutyTables.length > 1) dutyProblems.push('职责表重复');
      else if (dutyTables.length === 1) {
        try {
        const schemas = await this.metadata<{ field_name: string; type: number }>(appToken, `${dutyTables[0].table_id}/fields`, token);
        const names = new Set(schemas.map(field => field.field_name));
        const required = ['职责名称','职责类型','在任人员','楼栋范围','专业范围','启用','任职版本'];
        if (required.some(name => !names.has(name))) dutyProblems.push('职责表缺少必需字段');
        else {
          dutyRecords = await fetchBitableRecords(this.http, { appToken, tableId: dutyTables[0].table_id, tableName: AUTHORITY_DUTY_TABLE_NAME,
            automaticFields: true, fieldNames: AUTHORITY_DUTY_FIELDS.filter(name => names.has(name)), strict: true, allowStale: false, forceRefresh: force, cacheTtlMs: 5 * 60_000 });
        }
        } catch {
          const message = '职责目录读取失败，现有人员授权保留';
          dutyProblems.push(message); dutyIssues.push({ message });
        }
      }
      const authoritySource = { kind:'personnel_positions' as const, appId, appToken, tableId: source.tableId, ...(dutyTables.length === 1 ? { dutyTableId: dutyTables[0].table_id } : {}) };
      const parsed = buildAuthorityDuties(dutyRecords, authority.people, dutyProblems.length ? undefined : authoritySource), duties = parsed.duties;
      dutyProblems.push(...parsed.problems); dutyIssues.push(...parsed.issues);
      const authorityProblems = [...new Set([...authority.problems, ...dutyProblems])];
      const issues = [...authority.issues, ...dutyIssues];
      const personnelAuthority: PersonnelAuthoritySnapshot = { mode: 'shadow', source: authoritySource, snapshotAt: Date.now(),
        version: createHash('sha256').update(JSON.stringify({ source: authoritySource, people: [...authority.people].sort((a,b) => a.id.localeCompare(b.id)), duties: [...duties].sort((a,b) => a.recordId.localeCompare(b.recordId)), problems: [...authorityProblems].sort(), issues })).digest('hex'),
        people: authority.people, duties, problems: authorityProblems, issues };
      const problems = ['岗位','离职/异动情况'].filter(field => !availableFields.has(field)).map(field => `缺少${field}字段`);
      if (!availableFields.has('机楼/专业') && !availableFields.has('机楼专业')) problems.push('缺少专业字段');
      if (!records.length) problems.push('人员身份为空');
      if (new Set(employees.map(person => person.openId)).size !== employees.length) problems.push('人员身份重复');
      const merged = new Map(people.filter(person => !blockedOpenIds.has(person.openId)).map(person => [person.openId, person]));
      for(const person of activeMembers) if('openId' in person&&person.openId&&merged.has(person.openId)) merged.set(person.openId,{openId:person.openId,name:person.name});
      for (const person of organizationPeople) if (!merged.has(person.openId)) merged.set(person.openId, person);
      this.cached = { appId, people: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.openId.localeCompare(b.openId)), employees: employees.filter(person => !blockedOpenIds.has(person.openId)), externalEmployees, activeMembers, activeMembersComplete:true, employmentState, personnelWarnings, personnelAuthority, snapshotAt: Date.now(),
        personnelComplete: !problems.some(problem => problem !== '人员身份重复'), personnelProblems: problems };
      this.logger.log(`人员目录读取完成：耗时 ${Date.now() - startedAt}ms，人员 ${records.length}，职责 ${dutyRecords.length}`);
      return this.cached;
    })().catch(error => {
      this.logger.warn(`人员目录读取失败：耗时 ${Date.now() - startedAt}ms`);
      throw error;
    }).finally(() => { this.pending = undefined; this.pendingForced = false; });
    return this.pending;
  }
  private async metadata<T>(appToken: string, resource: string, token: string): Promise<T[]> {
    const items: T[] = [], visited = new Set<string>();
    let pageToken: string | undefined;
    do {
      const response = await this.http.axiosRef.get(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables${resource ? `/${resource}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` }, params: { page_size: 100, page_token: pageToken }, timeout: 8000,
      });
      if (response.data.code !== 0) throw new ServiceUnavailableException('人员目录结构读取失败，请检查飞书应用的多维表读取权限后重试');
      items.push(...(response.data.data?.items || []));
      pageToken = response.data.data?.has_more ? response.data.data.page_token : undefined;
      if ((response.data.data?.has_more && !pageToken) || (pageToken && visited.has(pageToken))) throw new ServiceUnavailableException('人员目录分页异常，请重试');
      if (pageToken) visited.add(pageToken);
    } while (pageToken);
    return items;
  }
  private async organizationPeople(appToken: string, token: string, tables: { table_id: string; name: string }[]): Promise<ConfigurationPerson[]> {
    const matches = tables.filter(table => typeof table.name === 'string' && /^(?:01-3\s*)?组织架构$/.test(table.name));
    if (!matches.length) return [];
    if (matches.length > 1) throw new ServiceUnavailableException('组织架构表不唯一，请检查人员表配置');
    const table = matches[0];
    const fields = await this.metadata<{ field_name: string; type: number }>(appToken, `${table.table_id}/fields`, token);
    const fieldNames = fields.filter(field => ['值班账号','库房管理员'].includes(field.field_name) && field.type === 11).map(field => field.field_name);
    if (!fieldNames.length) return [];
    const records = await fetchBitableRecords(this.http, { appToken, tableId: table.table_id, tableName: '组织架构', fieldNames, strict: true, allowStale: false, cacheTtlMs: 5 * 60_000 });
    const people: ConfigurationPerson[] = [];
    for (const record of records) for (const field of fieldNames) {
      const users = record.fields?.[field];
      if (!Array.isArray(users)) continue;
      for (const user of users) {
        const openId = user?.id, name = normalizeAccessDisplayName(user?.name);
        if (typeof openId === 'string' && OPEN_ID_PATTERN.test(openId) && name) people.push({ openId, name });
      }
    }
    return people;
  }
  async assertKnown(openIds: string[], knownIds: Set<string>): Promise<void> {
    const unknown = openIds.filter(id => !knownIds.has(id));
    if (!unknown.length) return;
    const people = (await this.read()).people;
    if (unknown.some(id => !people.some(person => person.openId === id))) throw new BadRequestException('所选飞书身份未在当前应用人员目录中匹配，请核对 Open ID');
  }
}
