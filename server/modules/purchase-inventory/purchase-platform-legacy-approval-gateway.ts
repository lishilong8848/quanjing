import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { currentHotfixActivation } from '../../common/hotfix-runtime-activation';
import type { HttpService } from '@nestjs/axios';
import { getFeishuAuthPayload, parseFeishuBitableLink, readEnv } from '../../common/config/external-services.config';
import { invalidateBitableRecordCache, type BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';
import { mapExecutionRecord, type PurchaseWorkflowGateway } from './purchase-workflow.gateway';

type Gateway = Pick<PurchaseWorkflowGateway, 'getTenantAccessTokenAsApp'>;
type Source = { appId: string; appToken: string; tableId: string };
export interface PlatformLegacyApprovalSnapshot { record: PurchaseWorkflowRecord; markerPresent: boolean }
const marker = '采购审批动作标识';
const batch = '采购审批批次号';
const fields = ['1️⃣物品采购方式', '采购流程', marker] as const;
const validId = (s: string) => /^[A-Za-z0-9_-]{1,160}$/.test(s);
function productionSource(): Source {
  const link = parseFeishuBitableLink(readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL'));
  return { appId: readEnv('FEISHU_APP_ID'), appToken: readEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN') || link.appToken, tableId: readEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID') };
}
function checkedSource(source: Source): Source {
  if (!source || !validId(source.appId) || !validId(source.appToken) || !validId(source.tableId)) throw new BadGatewayException('采购审批数据源未配置');
  return { ...source };
}
function recordId(value: string): string {
  if (!/^rec[A-Za-z0-9_-]{1,100}$/.test(value)) throw new BadRequestException('采购审批记录标识无效');
  return value;
}
function responseData(value: any): any {
  if (!value || value.code !== 0 || !value.data || typeof value.data !== 'object') throw new BadGatewayException('采购审批数据读取失败');
  return value.data;
}
function approvalTextCell(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')) {
    return value.map(part => part.text).join('');
  }
  throw new BadGatewayException('采购审批标记格式无法核验');
}
function validatePatch(value: Record<string, unknown>): Record<string, string> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) throw new BadRequestException('采购审批写入字段无效');
  const method = value[fields[0]], status = value[fields[1]], action = value[marker];
  const approved = ['综合采购', '需求自采', '需求自采（楼内）'].includes(method as string) && status === '审批通过（待下单）';
  const rejected = method === '驳回' && status === '驳回申请';
  if ((!approved && !rejected) || typeof action !== 'string' || !/^pa_[A-Za-z0-9_-]{43}$/.test(action)) throw new BadRequestException('采购审批写入字段无效');
  return { [fields[0]]: method as string, [fields[1]]: status as string, [marker]: action };
}

/** Isolation-only: caller must own the persisted claim and dispatch fence. Metadata
 * establishes field existence/type, never a promise that Feishu permits writing. */
export function createPlatformLegacyApprovalGateway(_gateway: Gateway, http: Pick<HttpService, 'axiosRef'>, readSource: () => Source = productionSource, readCredentials: () => {app_id:string; app_secret:string} = getFeishuAuthPayload) {
  const source = () => checkedSource(readSource());
  const fingerprint = (s: Source) => createHash('sha256').update(JSON.stringify([s.appId, s.appToken, s.tableId])).digest('hex');
  const requireSource = (expected: string) => { const s = source(); if (!/^[a-f0-9]{64}$/.test(expected || '') || fingerprint(s) !== expected) throw new BadGatewayException('采购审批数据源已变化'); return s; };
  const assertUnchanged = (expected: Source) => { if (fingerprint(source()) !== fingerprint(expected)) throw new BadGatewayException('采购审批数据源已变化'); };
  const base = (s: Source) => `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(s.appToken)}/tables/${encodeURIComponent(s.tableId)}`;
  const assertCredentials = (s: Source, expected: {app_id:string; app_secret:string}) => {
    assertUnchanged(s); const current = readCredentials();
    if (current.app_id !== expected.app_id || current.app_secret !== expected.app_secret) throw new BadGatewayException('采购审批应用身份不可用');
  };
  const acquireToken = async (s: Source): Promise<{token:string; credentials:{app_id:string; app_secret:string}}> => {
    const c = readCredentials();
    if (!c || c.app_id !== s.appId || !c.app_secret) throw new BadGatewayException('采购审批应用身份不可用');
    const response = await http.axiosRef.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: c.app_id, app_secret: c.app_secret }, { timeout:10000, maxRedirects:0 })
      .catch(() => { throw new BadGatewayException('采购审批应用身份不可用'); });
    assertUnchanged(s);
    assertCredentials(s, c);
    if (response.data?.code !== 0 || typeof response.data.tenant_access_token !== 'string' || !response.data.tenant_access_token) throw new BadGatewayException('采购审批应用身份不可用');
    return {token:response.data.tenant_access_token, credentials:c};
  };
  return {
    sourceFingerprint(): string { return fingerprint(source()); },
    sourceIdentity(): { appId: string; sourceFingerprint: string } {
      const s = source();
      return { appId: s.appId, sourceFingerprint: fingerprint(s) };
    },
    async verifyMarker(expectedFingerprint: string): Promise<void> {
      const s = requireSource(expectedFingerprint), {token, credentials} = await acquireToken(s);
      if (!token) throw new BadGatewayException('采购审批应用身份不可用');
      assertCredentials(s, credentials);
      const all: any[] = [], seen = new Set<string>(); let page = '';
      for (let n = 0; n < 20; n++) {
        assertCredentials(s, credentials);
        const response = await http.axiosRef.get(`${base(s)}/fields`, { headers: { Authorization: `Bearer ${token}` }, params: { page_size: 200, ...(page ? { page_token: page } : {}) }, timeout: 10000, maxRedirects: 0 }).catch(() => { throw new BadGatewayException('采购审批字段读取失败'); });
        assertUnchanged(s); const data = responseData(response.data);
        if (!Array.isArray(data.items)) throw new BadGatewayException('采购审批字段元数据无效');
        all.push(...data.items);
        if (data.has_more === false) break;
        if (data.has_more !== true || typeof data.page_token !== 'string' || !data.page_token || seen.has(data.page_token) || n === 19) throw new BadGatewayException('采购审批字段元数据不完整');
        page = data.page_token; seen.add(page);
      }
      for (const name of [...fields, batch]) {
        const matches = all.filter(item => item && item.field_name === name);
        const allowed = name === marker || name === batch ? [1] : [1, 3];
        if (matches.length !== 1 || !validId(matches[0].field_id || '') || !allowed.includes(matches[0].type) || matches[0].is_primary === true) throw new BadGatewayException('采购审批字段缺失或类型不支持');
      }
    },
    async readSnapshot(id: string, expectedFingerprint: string): Promise<PlatformLegacyApprovalSnapshot> {
      const expected = recordId(id), s = requireSource(expectedFingerprint), {token, credentials} = await acquireToken(s);
      if (!token) throw new BadGatewayException('采购审批应用身份不可用');
      assertCredentials(s, credentials);
      const response = await http.axiosRef.post(`${base(s)}/records/batch_get`, { record_ids: [expected] }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000, maxRedirects: 0 }).catch(() => { throw new BadGatewayException('采购审批记录读取失败'); });
      assertUnchanged(s); const data = responseData(response.data);
      if (!Array.isArray(data.records) || data.records.length !== 1 || (data.absent_record_ids && (!Array.isArray(data.absent_record_ids) || data.absent_record_ids.length)) || (data.forbidden_record_ids && (!Array.isArray(data.forbidden_record_ids) || data.forbidden_record_ids.length))) throw new BadGatewayException('采购审批记录不完整');
      const raw = data.records[0];
      if (!raw || raw.record_id !== expected || !raw.fields || typeof raw.fields !== 'object' || Array.isArray(raw.fields)) throw new BadGatewayException('采购审批记录不一致');
      if (fields.slice(0, 2).some(name => !Object.prototype.hasOwnProperty.call(raw.fields, name))) throw new BadGatewayException('采购审批业务字段缺失');
      if (![batch, marker].every(name => Object.prototype.hasOwnProperty.call(raw.fields, name))) {
        // Feishu omits empty cells. Only a direct full-access grant to this
        // exact application, together with verified field metadata, lets us
        // distinguish an empty cell from a field hidden by advanced permissions.
        await this.verifyMarker(expectedFingerprint);
        assertCredentials(s, credentials);
        const permissions = await http.axiosRef.get(`https://open.feishu.cn/open-apis/drive/v1/permissions/${encodeURIComponent(s.appToken)}/members`, {
          headers: { Authorization: `Bearer ${token}` }, params: { type: 'bitable' }, timeout: 10000, maxRedirects: 0,
        }).catch(() => { throw new BadGatewayException('采购审批字段读取权限无法核对'); });
        assertCredentials(s, credentials);
        const members = responseData(permissions.data).items;
        if (!Array.isArray(members) || !members.some(member => member?.member_type === 'appid' && member.member_id === s.appId && member.perm === 'full_access')) throw new BadGatewayException('采购审批字段读取权限不足');
        for (const name of [batch, marker]) if (!Object.prototype.hasOwnProperty.call(raw.fields, name)) raw.fields[name] = null;
      }
      if (!Object.prototype.hasOwnProperty.call(raw.fields, batch)) throw new BadGatewayException('采购审批批次字段缺失或无效');
      raw.fields[batch] = approvalTextCell(raw.fields[batch]);
      if (Object.prototype.hasOwnProperty.call(raw.fields, marker)) raw.fields[marker] = approvalTextCell(raw.fields[marker]);
      const present = Object.prototype.hasOwnProperty.call(raw.fields, marker);
      const value = raw.fields[marker];
      if (present && value !== null && typeof value !== 'string') throw new BadGatewayException('采购审批标记格式无法核验');
      const record = mapExecutionRecord(raw as BitableRecordItem);
      if (record.recordId !== expected || (present && record.approvalActionId !== (value || ''))) throw new BadGatewayException('采购审批标记读取不一致');
      if (!present) delete record.approvalActionId;
      return { record, markerPresent: present };
    },
    async writeDecision(id: string, values: Record<string, unknown>, expectedFingerprint: string): Promise<void> {
      const s = requireSource(expectedFingerprint), checked = validatePatch(values), target = recordId(id);
      const {token, credentials} = await acquireToken(s);
      if (!token) throw new BadGatewayException('采购审批应用身份不可用');
      assertCredentials(s, credentials);
      // Use the frozen source directly: no await or dynamic config lookup between
      // the final comparison and issuing the request. The caller owns the fence.
      if (!currentHotfixActivation().isAcceptingNewWork()) throw new BadGatewayException('系统更新中，采购审批暂缓写入');
      const response = await http.axiosRef.put(`${base(s)}/records/${encodeURIComponent(target)}`, { fields: checked }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000, maxRedirects: 0 }).catch(() => { throw new BadGatewayException('采购审批写入结果待核对'); });
      responseData(response.data);
      assertUnchanged(s);
      invalidateBitableRecordCache({ appToken: s.appToken, tableId: s.tableId });
    },
  };
}
