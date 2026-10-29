import type { HttpService } from '@nestjs/axios';
import { ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, scrypt } from 'node:crypto';
import { extractDisplayText, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { normalizeAccessDisplayName } from './access-display-name';
import { parsePersonnelPasswordHash } from './personnel-password';
import { readPersonnelAuthorizationState } from './personnel-employment-state';
import { DEFAULT_ACTIVE_PERSONNEL_VIEW_ID } from '../../modules/bitable-sync/active-personnel-directory';
import { isValidIdentityNumber } from '../../modules/bitable-sync/employee-onboarding.rules';

export interface ExternalEmployeeCredential { id: string; name: string; passwordHash?: string; active: boolean; }

export async function buildExternalEmployeeCredentials(records: BitableRecordItem[], appId: string, appToken: string, tableId: string, onWarning?: (message: string) => void, initialCredentialRecordIds?: ReadonlySet<string>): Promise<ExternalEmployeeCredential[]> {
  const secret = process.env.LOCAL_ACCESS_SESSION_SECRET || process.env.LOCAL_ADMIN_SESSION_SECRET || '';
  const secretBytes = Buffer.from(secret.trim(), 'base64');
  if (secretBytes.length !== 32 || secretBytes.toString('base64') !== secret.trim()) throw unavailable();
  const result: ExternalEmployeeCredential[] = [], ids = new Set<string>();
  const derivations: { index: number; password: string; salt: Buffer }[] = [];
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
    // Invalid nonempty values must never fall back to an initial password.
    let password = readCredentialText(record.fields?.密码);
    if (password === '' && (!initialCredentialRecordIds || initialCredentialRecordIds.has(recordId)) &&
      readPersonnelAuthorizationState(record.fields || {}) === 'active') {
      const identityNumber = readCredentialText(record.fields?.身份证号)?.trim().toUpperCase();
      if (identityNumber && isValidIdentityNumber(identityNumber)) password = identityNumber.slice(-6);
    }
    password ??= '';
    const encoded = /^[A-Za-z0-9_]+\$/u.test(password.trimStart());
    // Credential eligibility is independent of business authorization revocation.
    const active = (encoded
      ? parsePersonnelPasswordHash(password) !== null : password.length > 0 && password.length <= 256);
    let passwordHash: string | undefined;
    if (active && encoded) passwordHash = password;
    else if (active) {
      // Stable per-record salts let unchanged credentials retain their session version.
      const salt = createHmac('sha256', secretBytes).update(`external-employee-salt\0${id}`).digest().subarray(0, 16);
      derivations.push({ index: result.length, password, salt });
    }
    result.push({ id, name, active, ...(passwordHash ? { passwordHash } : {}) });
  }
  // Bound the shared thread-pool work while retaining record order and stable salts.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, derivations.length) }, async () => {
    while (cursor < derivations.length) {
      const { index, password, salt } = derivations[cursor++];
      const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, (error, derived) => error ? reject(error) : resolve(derived)));
      result[index].passwordHash = `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
    }
  }));
  const names = new Map<string, number>();
  for (const employee of result) names.set(employee.name, (names.get(employee.name) || 0) + 1);
  if (missingName) onWarning?.('部分姓名账号姓名未维护，该记录暂不启用，其他合法账号继续同步。');
  if ([...names.values()].some(count => count > 1)) onWarning?.('部分姓名账号存在重名，该姓名登录暂不启用，请核对人员记录。');
  return result.map(employee => ({ ...employee, active: employee.active && names.get(employee.name) === 1 }));
}

export async function readExternalEmployeeCredentials(http: HttpService, appId: string, appToken: string, tableId: string, token: string,
  fields: { field_name: string; type: number }[], views: { view_id: string; view_name: string }[], onWarning?: (message: string) => void): Promise<ExternalEmployeeCredential[]> {
  const activeViewId = process.env.FEISHU_ORG_VIEW_ID?.trim() || process.env.FEISHU_ORGANIZATION_VIEW_ID?.trim() || DEFAULT_ACTIVE_PERSONNEL_VIEW_ID;
  const activeViews = views.filter(view => view.view_id === activeViewId);
  const matches = views.filter(view => view.view_name === '外部账号人员');
  const hasField = (name: string, type: number) => {
    const matching = fields.filter(field => field.field_name === name);
    return matching.length === 1 && matching[0].type === type;
  };
  if (activeViews.length !== 1 || !/^vew[A-Za-z0-9]+$/.test(activeViewId) || matches.length !== 1 ||
    !/^vew[A-Za-z0-9]+$/.test(matches[0].view_id) ||
    !['姓名', '密码'].every(name => hasField(name, 1)) || !hasField('离职/异动情况', 7)) throw unavailable();
  const fieldNames = ['姓名', '密码', '离职/异动情况'];
  if (hasField('身份证号', 1)) fieldNames.push('身份证号');
  const records = new Map<string, BitableRecordItem>(), activeIds = new Set<string>();
  try {
    for (const viewId of new Set([activeViewId, ...matches.map(view => view.view_id)])) {
      const visited = new Set<string>(), viewRecords = new Set<string>();
      let pageToken: string | undefined;
      do {
        const response = await http.axiosRef.post(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`, {
          view_id: viewId, field_names: fieldNames,
        }, { headers: { Authorization: `Bearer ${token}` }, params: { page_size: 100, page_token: pageToken }, timeout: 8000 });
        const data = response.data?.data;
        if (response.data?.code !== 0 || !data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') throw unavailable();
        for (const item of data.items as BitableRecordItem[]) {
          const recordId = item?.record_id || item?.id;
          if (typeof recordId !== 'string' || !/^rec[A-Za-z0-9]+$/.test(recordId) || viewRecords.has(recordId) || !item.fields || typeof item.fields !== 'object' || Array.isArray(item.fields)) throw unavailable();
          viewRecords.add(recordId);
          // Only trusted fields are consumed. Feishu omits unchecked checkbox cells.
          const record: BitableRecordItem = { record_id: recordId, fields: Object.fromEntries(fieldNames.map(name => [name,
            name === '离职/异动情况' && item.fields![name] === undefined ? false : item.fields![name],
          ])) };
          if (viewId === activeViewId && readCredentialText(record.fields!.密码) === '') {
            const state = readPersonnelAuthorizationState(record.fields!);
            if (state === 'unknown' || (state === 'active' && !hasField('身份证号', 1))) throw unavailable();
          }
          const prior = records.get(recordId);
          if (prior && credentialFingerprint(prior) !== credentialFingerprint(record)) throw unavailable();
          records.set(recordId, record);
          if (viewId === activeViewId) activeIds.add(recordId);
          if (records.size > 5000) throw unavailable();
        }
        pageToken = data.has_more ? data.page_token : undefined;
        if ((data.has_more && (!pageToken || typeof pageToken !== 'string')) || (pageToken && visited.has(pageToken))) throw unavailable();
        if (pageToken) visited.add(pageToken);
      } while (pageToken);
    }
    return await buildExternalEmployeeCredentials([...records.values()], appId, appToken, tableId, onWarning, activeIds);
  } catch {
    // Axios errors can carry the response containing credentials; never propagate them.
    throw unavailable();
  }
}

function readCredentialText(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => part && typeof part.text === 'string')) return value.map(part => part.text).join('');
  return null;
}

function credentialFingerprint(record: BitableRecordItem): string {
  const fields = record.fields || {};
  const text = (value: unknown) => readCredentialText(value) ?? { invalid: value };
  // Detect changes between view reads before deriving or publishing any credentials.
  return createHash('sha256').update(JSON.stringify([
    normalizeAccessDisplayName(extractDisplayText(fields.姓名, '')), text(fields.密码),
    text(fields.身份证号), fields['离职/异动情况'],
  ])).digest('hex');
}

function unavailable() { return new ServiceUnavailableException('外部员工资料读取失败，请检查在职人员、外部账号人员视图及姓名、密码、离职字段'); }
