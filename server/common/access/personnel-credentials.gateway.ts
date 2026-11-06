import { HttpService } from '@nestjs/axios';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getFeishuAuthPayload } from '../config/external-services.config';
import { readEmployeeOnboardingConfig } from '../../modules/bitable-sync/employee-onboarding.config';
import { DEFAULT_ACTIVE_PERSONNEL_VIEW_ID } from '../../modules/bitable-sync/active-personnel-directory';
import { readPersonnelAuthorizationState } from './personnel-employment-state';
import { parsePersonnelPasswordHash } from './personnel-password';
import { resolvePersonnelLoginMethod } from './personnel-login-method';

export interface PersonnelCredentialRecord {
  appId: string;
  appToken: string;
  tableId: string;
  recordId: string;
  accountId: string;
  name: string;
  identityNumber: string;
  password: string;
  token: string;
  loginMethod?: 'feishu' | 'password';
  viewId?: string;
  sourceFields?: readonly string[];
}
const API = 'https://open.feishu.cn/open-apis';
const fields = ['姓名', '身份证号', '密码', '离职/异动情况'];
const loginFields = ['账号性质', '人员类型', '岗位', '员工姓名', '员工', '人员', '飞书 open_id', 'open_id', 'Open ID'];

/** Fresh source reads only; no personnel credential or identity-number disk cache. */
@Injectable()
export class PersonnelCredentialsGateway {
  constructor(private readonly http: HttpService) {}

  async findActive(name: string): Promise<PersonnelCredentialRecord | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.findFresh(name, controller.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 20_000);
      })]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }

  private async findFresh(name: string, signal: AbortSignal): Promise<PersonnelCredentialRecord | null> {
    try {
      const config = readEmployeeOnboardingConfig(), auth = getFeishuAuthPayload();
      const authResponse = await this.http.axiosRef.post(`${API}/auth/v3/tenant_access_token/internal`, auth, { timeout: 8000, signal });
      const token = authResponse.data?.tenant_access_token;
      if (authResponse.data?.code !== 0 || typeof token !== 'string' || !token) throw unavailable();
      const headers = { Authorization: `Bearer ${token}` };
      let appToken = config.appToken;
      if (!appToken) {
        const wiki = await this.http.axiosRef.get(`${API}/wiki/v2/spaces/get_node`, { headers, params: { token: config.wikiToken }, timeout: 8000, signal });
        if (wiki.data?.code !== 0 || wiki.data?.data?.node?.obj_type !== 'bitable') throw unavailable();
        appToken = wiki.data.data.node.obj_token;
      }
      if (typeof appToken !== 'string' || !/^[A-Za-z0-9]{10,128}$/.test(appToken)) throw unavailable();
      const base = `${API}/bitable/v1/apps/${appToken}/tables/${config.tableId}`;
      const [metadata, views] = await Promise.all([this.list(`${base}/fields`, headers, signal), this.list(`${base}/views`, headers, signal)]);
      for (const field of fields) {
        const match = metadata.filter(item => item.field_name === field);
        if (match.length !== 1 || match[0].type !== (field === '离职/异动情况' ? 7 : 1)) throw unavailable();
      }
      const natureField = metadata.filter(item => item.field_name === '账号性质');
      if (natureField.length !== 1 || ![1, 3].includes(natureField[0].type as number)) throw unavailable();
      const sourceFields = [...fields, ...loginFields.filter(name => metadata.some(item => item.field_name === name))];
      const viewId = process.env.FEISHU_ORG_VIEW_ID?.trim() || process.env.FEISHU_ORGANIZATION_VIEW_ID?.trim() || DEFAULT_ACTIVE_PERSONNEL_VIEW_ID;
      if (!/^vew[A-Za-z0-9]+$/.test(viewId) || views.filter(item => item.view_id === viewId).length !== 1) throw unavailable();
      const response = await this.http.axiosRef.post(`${base}/records/search`, {
        view_id: viewId, field_names: sourceFields,
        filter: { conjunction: 'and', conditions: [{ field_name: '姓名', operator: 'is', value: [name] }] },
      }, { headers, params: { page_size: 100 }, timeout: 8000, signal });
      const data = response.data?.data;
      if (response.data?.code !== 0 || !data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') throw unavailable();
      // Never choose one of duplicate or incompletely enumerated source identities.
      if (data.has_more || data.items.length !== 1) return null;
      const item = data.items[0], recordId = item?.record_id || item?.id;
      if (typeof recordId !== 'string' || !/^rec[A-Za-z0-9]+$/.test(recordId)) throw unavailable();
      const parsed = parseFields(item.fields);
      if (!parsed || parsed.name !== name) return null;
      const accountId = 'local-external-' + createHash('sha256').update(JSON.stringify([auth.app_id, appToken, config.tableId, recordId])).digest('hex');
      return { appId: auth.app_id, appToken, tableId: config.tableId, recordId, accountId, token, viewId, sourceFields, ...parsed };
    } catch { throw unavailable(); }
  }

  async fresh(record: PersonnelCredentialRecord): Promise<PersonnelCredentialRecord> {
    try {
      const recordUrl = this.recordUrl(record);
      if (!/^vew[A-Za-z0-9]+$/.test(record.viewId || '') || !Array.isArray(record.sourceFields) ||
        ![...fields, '账号性质'].every(name => record.sourceFields!.includes(name)) ||
        record.sourceFields.some(name => ![...fields, ...loginFields].includes(name))) throw unavailable();
      // A full-record GET also expands unrelated personnel fields. Re-read only
      // credential/policy fields, then bind the result to the original record.
      const response = await this.http.axiosRef.post(recordUrl.slice(0, recordUrl.lastIndexOf('/')) + '/search', {
        view_id: record.viewId, field_names: [...record.sourceFields],
        filter: { conjunction: 'and', conditions: [{ field_name: '姓名', operator: 'is', value: [record.name] }] },
      }, { headers: { Authorization: `Bearer ${record.token}`, 'Cache-Control': 'no-cache' }, params: { page_size: 2 }, timeout: 8000 });
      const data = response.data?.data;
      if (response.data?.code !== 0 || !data || data.has_more !== false || !Array.isArray(data.items) || data.items.length !== 1) throw unavailable();
      const item = data.items[0];
      if ((item?.record_id || item?.id) !== record.recordId) throw unavailable();
      const parsed = parseFields(item.fields);
      if (!parsed || parsed.name !== record.name || parsed.identityNumber !== record.identityNumber) throw unavailable();
      return { ...record, ...parsed };
    } catch { throw unavailable(); }
  }

  async writePassword(record: PersonnelCredentialRecord, newHash: string): Promise<void> {
    if (!parsePersonnelPasswordHash(newHash)) throw unavailable();
    try {
      const response = await this.http.axiosRef.put(this.recordUrl(record), { fields: { 密码: newHash } }, {
        headers: { Authorization: `Bearer ${record.token}` }, timeout: 8000,
      });
      if (response.data?.code !== 0) throw unavailable();
    } catch { throw unavailable(); } // Deliberately discard axios request/data/response and upstream messages.
  }

  private recordUrl(record: PersonnelCredentialRecord) {
    if (!/^[A-Za-z0-9]{10,128}$/.test(record.appToken) || !/^tbl[A-Za-z0-9]+$/.test(record.tableId) || !/^rec[A-Za-z0-9]+$/.test(record.recordId)) throw unavailable();
    return `${API}/bitable/v1/apps/${record.appToken}/tables/${record.tableId}/records/${record.recordId}`;
  }
  private async list(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [], visited = new Set<string>();
    let pageToken: string | undefined;
    do {
      const response = await this.http.axiosRef.get(url, { headers, params: { page_size: 100, page_token: pageToken }, timeout: 8000, signal });
      const data = response.data?.data;
      if (response.data?.code !== 0 || !data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean' ||
        data.items.some((item: unknown) => !item || typeof item !== 'object' || Array.isArray(item))) throw unavailable();
      result.push(...data.items);
      if (result.length > 1000) throw unavailable();
      if (!data.has_more) break;
      if (typeof data.page_token !== 'string' || !data.page_token || visited.has(data.page_token)) throw unavailable();
      pageToken = data.page_token;
      visited.add(pageToken);
    } while (pageToken);
    return result;
  }
}
function text(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(item => item && typeof item.text === 'string')) return value.map(item => item.text).join('');
  return null;
}
function parseFields(value: unknown): { name: string; identityNumber: string; password: string; loginMethod: 'feishu' | 'password' } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  // This default is safe only after the gateway verified that the source field is a checkbox.
  if (readPersonnelAuthorizationState({ ...source, '离职/异动情况': source['离职/异动情况'] === undefined ? false : source['离职/异动情况'] }) !== 'active') return null;
  const name = text(source.姓名), password = text(source.密码), identity = text(source.身份证号);
  if (!name || password === null || identity === null) return null;
  let loginMethod = resolvePersonnelLoginMethod(source);
  // Existing active personnel such as legacy external staff may have an empty
  // nature cell. This preserves their already-provisioned name account; it does
  // not turn a missing/invalid schema or ambiguous nonempty value into permission.
  if (loginMethod === 'unknown' && text(source.账号性质)?.trim() === '') loginMethod = 'password';
  if (loginMethod === 'unknown') return null;
  return { name: name.trim(), password, identityNumber: identity.trim().toUpperCase(), loginMethod };
}
function unavailable() { return new ServiceUnavailableException('人员密码资料核验暂不可用，请保留当前内容重试'); }
