import type { HttpService } from '@nestjs/axios';
import { ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, scrypt } from 'node:crypto';
import { extractDisplayText, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { normalizeAccessDisplayName } from './access-display-name';
import { parsePersonnelPasswordHash } from './personnel-password';

export interface ExternalEmployeeCredential { id: string; name: string; passwordHash?: string; active: boolean; }

export async function buildExternalEmployeeCredentials(records: BitableRecordItem[], appId: string, appToken: string, tableId: string, onWarning?: (message: string) => void): Promise<ExternalEmployeeCredential[]> {
  const secret = process.env.LOCAL_ACCESS_SESSION_SECRET || process.env.LOCAL_ADMIN_SESSION_SECRET || '';
  const secretBytes = Buffer.from(secret.trim(), 'base64');
  if (secretBytes.length !== 32 || secretBytes.toString('base64') !== secret.trim()) throw unavailable();
  const result: ExternalEmployeeCredential[] = [], ids = new Set<string>();
  let missingName = false;
  for (const record of records) {
    const recordId = record.record_id || record.id;
    const name = normalizeAccessDisplayName(extractDisplayText(record.fields?.姓名, ''));
    if (typeof recordId !== 'string' || !/^rec[A-Za-z0-9]+$/.test(recordId)) throw unavailable();
    const identity = createHash('sha256').update(JSON.stringify([appId, appToken, tableId, recordId])).digest('hex');
    const id = `local-external-${identity}`;
    if (ids.has(id)) throw unavailable();
    ids.add(id);
    if (!name) { missingName = true; continue; }
    const field = record.fields?.密码;
    const password = typeof field === 'string' ? field : Array.isArray(field) && field.every(part => part && typeof part.text === 'string') ? field.map(part => part.text).join('') : '';
    const encoded = /^[A-Za-z0-9_]+\$/u.test(password.trimStart());
    // Credential eligibility is independent of business authorization revocation.
    const active = (encoded
      ? parsePersonnelPasswordHash(password) !== null : password.length > 0 && password.length <= 256);
    let passwordHash: string | undefined;
    if (active && encoded) passwordHash = password;
    else if (active) {
      // Stable per-record salts let unchanged credentials retain their session version.
      const salt = createHmac('sha256', secretBytes).update(`external-employee-salt\0${id}`).digest().subarray(0, 16);
      const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, (error, derived) => error ? reject(error) : resolve(derived)));
      passwordHash = `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
    }
    result.push({ id, name, active, ...(passwordHash ? { passwordHash } : {}) });
  }
  const names = new Map<string, number>();
  for (const employee of result) names.set(employee.name, (names.get(employee.name) || 0) + 1);
  if (missingName) onWarning?.('部分姓名账号姓名未维护，该记录暂不启用，其他合法账号继续同步。');
  if ([...names.values()].some(count => count > 1)) onWarning?.('部分姓名账号存在重名，该姓名登录暂不启用，请核对人员记录。');
  return result.map(employee => ({ ...employee, active: employee.active && names.get(employee.name) === 1 }));
}

export async function readExternalEmployeeCredentials(http: HttpService, appId: string, appToken: string, tableId: string, token: string,
  fields: { field_name: string; type: number }[], views: { view_id: string; view_name: string }[], onWarning?: (message: string) => void): Promise<ExternalEmployeeCredential[]> {
  const matches = views.filter(view => view.view_name === '外部账号人员');
  if (matches.length !== 1 || !/^vew[A-Za-z0-9]+$/.test(matches[0].view_id) ||
    !['姓名', '密码'].every(name => fields.some(field => field.field_name === name && field.type === 1)) ||
    !fields.some(field => field.field_name === '离职/异动情况' && field.type === 7)) throw unavailable();
  const records: BitableRecordItem[] = [], visited = new Set<string>();
  let pageToken: string | undefined;
  try {
    do {
      const response = await http.axiosRef.post(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`, {
        view_id: matches[0].view_id, field_names: ['姓名', '密码', '离职/异动情况'],
      }, { headers: { Authorization: `Bearer ${token}` }, params: { page_size: 100, page_token: pageToken }, timeout: 8000 });
      const data = response.data?.data;
      if (response.data?.code !== 0 || !data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') throw unavailable();
      records.push(...data.items);
      if (records.length > 5000) throw unavailable();
      pageToken = data.has_more ? data.page_token : undefined;
      if ((data.has_more && (!pageToken || typeof pageToken !== 'string')) || (pageToken && visited.has(pageToken))) throw unavailable();
      if (pageToken) visited.add(pageToken);
    } while (pageToken);
    return await buildExternalEmployeeCredentials(records, appId, appToken, tableId, onWarning);
  } catch {
    // Axios errors can carry the response containing credentials; never propagate them.
    throw unavailable();
  }
}
function unavailable() { return new ServiceUnavailableException('外部员工资料读取失败，请检查外部账号人员视图及姓名、密码、离职字段'); }
