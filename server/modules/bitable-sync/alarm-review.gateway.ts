import { HttpService } from '@nestjs/axios';
import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AlarmReviewOutcome } from '../../../shared/today-operations-alarm-review.interface';
import { ALARM_REVIEW_OUTCOMES } from '../../../shared/today-operations-alarm-review.interface';
import { getEffectiveFeishuAppCredentials, parseFeishuBitableLink, readEnv } from '../../common/config/external-services.config';
import { getTenantAccessToken, invalidateBitableRecordCache, resolveBitableAppToken } from '../../common/feishu/bitable-direct-read';
import { DEFAULT_ALARM_SOURCE_URL, resolveTodayOperationsAlarmAuth } from './today-operations-alarm.service';
import { ALARM_REVIEW_FIELD, ALARM_REVIEW_PERSON_FIELD, ALARM_REVIEW_REPLY_FIELD, buildReviewFields, reviewMatches, reviewVersion } from './alarm-review.rules';

@Injectable()
export class AlarmReviewGateway {
  private cachedTarget: { appToken: string; tableId: string; url: string; token: string; expiresAt: number } | null = null;
  constructor(private readonly http: HttpService) {}
  // 同应用复用在职快照 Open ID；跨应用时转换为租户 User ID，避免误写人员。
  async resolveResponsibleUserId(openId: string): Promise<string> {
    if (!/^ou_[A-Za-z0-9]+$/.test(openId)) throw new ServiceUnavailableException('责任人飞书身份不可用');
    const sourceAuth = resolveTodayOperationsAlarmAuth();
    if (!sourceAuth || sourceAuth.appId === getEffectiveFeishuAppCredentials().appId) return openId;
    try {
      const token = await getTenantAccessToken(this.http);
      const { data } = await this.http.axiosRef.get(`https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(openId)}`, {
        headers: { Authorization: `Bearer ${token}` }, params: { user_id_type: 'open_id' }, timeout: 8000,
      });
      const userId = data?.data?.user?.user_id;
      if (data?.code !== 0) throw new ServiceUnavailableException(`责任人身份核对失败（飞书代码 ${Number(data?.code) || '未知'}），请检查通讯录访问权限`);
      if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new ServiceUnavailableException('跨应用责任人关联需要主应用具有获取用户 User ID 的权限');
      return userId;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      const code = Number((error as { response?: { data?: { code?: unknown } } })?.response?.data?.code);
      throw new ServiceUnavailableException(`责任人飞书身份核对失败${Number.isFinite(code) ? `（飞书代码 ${code}）` : ''}，请检查通讯录权限；未以姓名替代人员关联`);
    }
  }
  async preflight(): Promise<void> { await this.target(); }
  async syncRecord(recordId: string, outcome: AlarmReviewOutcome, userId: string, expectedVersion: string, customReply?: string): Promise<Record<string, unknown>> {
    const target = await this.target();
    const url = `${target.url}/records/${encodeURIComponent(recordId)}`;
    const config = { headers: { Authorization: `Bearer ${target.token}` }, timeout: 8000, params: { user_id_type: userId.startsWith('ou_') ? 'open_id' : 'user_id' } };
    const read = async (): Promise<Record<string, unknown>> => {
      const response = await this.http.axiosRef.get(url, config);
      if (response.data?.code !== 0 || response.data?.data?.record?.record_id !== recordId || !response.data?.data?.record?.fields) {
        throw new ServiceUnavailableException('告警读取失败，请核对记录是否仍存在');
      }
      return response.data.data.record.fields;
    };
    const before = await read();
    if (reviewMatches(before, outcome, userId, customReply)) return before;
    if (reviewVersion(before) !== expectedVersion) throw new ConflictException('该告警人工复核已变更，请重新读取清单后再复核');
    const response = await this.http.axiosRef.put(url, { fields: buildReviewFields(outcome, userId, customReply) }, config);
    if (response.data?.code !== 0) throw new ServiceUnavailableException('复核写入未确认，请核对后重试');
    const after = await read();
    if (!reviewMatches(after, outcome, userId, customReply)) throw new ServiceUnavailableException('复核回读不一致，请核对后重试');
    invalidateBitableRecordCache({ appToken: target.appToken, tableId: target.tableId });
    return after;
  }
  private async target(): Promise<{ appToken: string; tableId: string; url: string; token: string }> {
    if (this.cachedTarget && this.cachedTarget.expiresAt > Date.now()) return this.cachedTarget;
    const source = parseFeishuBitableLink(readEnv('TODAY_OPERATIONS_ALARM_BITABLE_URL') || DEFAULT_ALARM_SOURCE_URL);
    if (!source.tableId) throw new ServiceUnavailableException('告警表配置不完整');
    const auth = resolveTodayOperationsAlarmAuth();
    const appToken = await resolveBitableAppToken(this.http, { appToken: source.appToken, wikiToken: source.wikiToken, tableName: '今日全景告警信息', auth });
    const token = await getTenantAccessToken(this.http, auth);
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(source.tableId)}`;
    const fields: Array<{ field_name: string; type: number; property?: { multiple?: boolean; options?: Array<{ name: string }> } }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await this.http.axiosRef.get(`${url}/fields`, { headers: { Authorization: `Bearer ${token}` }, params: { page_size: 100, page_token: pageToken }, timeout: 8000 });
      if (response.data?.code !== 0 || !Array.isArray(response.data?.data?.items)) throw new ServiceUnavailableException('复核字段读取失败');
      fields.push(...response.data.data.items);
      if (!response.data.data.has_more) {
        const result = fields.find((field) => field.field_name === ALARM_REVIEW_FIELD);
        const person = fields.find((field) => field.field_name === ALARM_REVIEW_PERSON_FIELD);
        const reply = fields.find((field) => field.field_name === ALARM_REVIEW_REPLY_FIELD);
        if (result?.type !== 3 || person?.type !== 11 || person.property?.multiple !== false || reply?.type !== 1 ||
          ALARM_REVIEW_OUTCOMES.some((outcome) => !result.property?.options?.some((option) => option.name === outcome))) {
          throw new ServiceUnavailableException('人工复核字段未就绪，请联系管理员；未写入原告警处理字段');
        }
        this.cachedTarget = { appToken, tableId: source.tableId, url, token, expiresAt: Date.now() + 60000 };
        return this.cachedTarget;
      }
      const next = response.data.data.page_token;
      if (typeof next !== 'string' || !next || next === pageToken) break;
      pageToken = next;
    }
    throw new ServiceUnavailableException('复核字段分页不完整');
  }
}
