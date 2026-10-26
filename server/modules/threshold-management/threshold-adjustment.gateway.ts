import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  fetchBitableRecords,
  getTenantAccessToken,
  extractDisplayText,
  extractDisplayValues,
  invalidateBitableRecordCache,
} from '../../common/feishu/bitable-direct-read';
import type {
  ThresholdAdjustmentContext,
  ThresholdPerson,
} from '../../../shared/threshold-adjustment.interface';
import type { ThresholdAdjustmentEntry } from './threshold-adjustment.store';
import { getFeishuAuthPayload } from '../../common/config/external-services.config';
import { thresholdText } from '../../../shared/threshold-bitable';

export const THRESHOLD_APPROVAL_BASE = 'PUBLIC_EXAMPLE_FEISHU_MAIN_APP_TOKEN';
export const THRESHOLD_APPROVAL_TABLE = 'tbl63e8826f2494b';
export const THRESHOLD_ORGANIZATION_TABLE = 'tble6c080658c1b2';
export const THRESHOLD_APPROVAL_FIELDS: Record<string, number> = {
  程序申请编号: 1,
  阈值记录标识: 1,
  参数名称: 1,
  原阈值: 1,
  申请阈值: 1,
  单位: 1,
  申请人: 11,
  楼长审批人: 11,
  专业审批人: 11,
  机房经理知会人: 11,
  阈值审批阶段: 1,
  阈值审批回执: 1,
  阈值消息回执: 1,
  阈值审批错误: 1,
  阈值审批快照: 1,
  阈值申请幂等键: 1,
  阈值调整确认回执: 1,
};
@Injectable()
export class ThresholdAdjustmentGateway {
  private context?: { value: ThresholdAdjustmentContext; at: number };
  private refreshing?: Promise<ThresholdAdjustmentContext>;
  private schemaChecked = false;
  constructor(private readonly http: HttpService) {}
  peekContext() {
    return this.context && Date.now() - this.context.at < 300000
      ? structuredClone(this.context.value)
      : undefined;
  }
  async readContext(): Promise<ThresholdAdjustmentContext> {
    if (this.peekContext()) return this.peekContext()!;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const records = await fetchBitableRecords(this.http, {
        appToken: THRESHOLD_APPROVAL_BASE,
        tableId: THRESHOLD_ORGANIZATION_TABLE,
        tableName: '阈值调整组织架构',
        fieldNames: ['职位', '示例人员001', '楼栋/专业', '专业', '楼栋'],
        strict: true,
        allowStale: false,
        cacheTtlMs: 300000,
      });
      const roles: ThresholdAdjustmentContext['roles'] = [];
      for (const record of records) {
        const f = record.fields || {},
          position = extractDisplayText(f['职位'], '');
        const buildings = extractDisplayValues(f['楼栋/专业']);
        const professions = extractDisplayValues(f['专业']);
        const users = f['示例人员001'];
        if (!Array.isArray(users)) continue;
        for (const user of users)
          if (
            /^ou_[A-Za-z0-9_-]+$/.test(user.id || '') &&
            typeof user.name === 'string'
          )
            roles.push({
              openId: user.id,
              name: user.name,
              position,
              professions,
              buildings,
            });
      }
      const engineers = roles
        .filter((p) => /工程师$/.test(p.position))
        .flatMap((p) =>
          p.professions.map((profession) => ({
            openId: p.openId,
            name: p.name,
            profession,
            buildings: p.buildings,
          })),
        );
      const value = { roles, engineers };
      this.context = { value, at: Date.now() };
      return structuredClone(value);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  async ensureSchema() {
    if (this.schemaChecked) return;
    const fields = await this.metadata<{ field_name: string; type: number }>(
      `${THRESHOLD_APPROVAL_TABLE}/fields`,
    );
    for (const [name, type] of Object.entries(THRESHOLD_APPROVAL_FIELDS)) {
      const existing = fields.find((f) => f.field_name === name);
      if (existing && existing.type !== type)
        throw new ConflictException(`审批表字段“${name}”类型不匹配`);
      if (!existing)
        await this.request('post', `${THRESHOLD_APPROVAL_TABLE}/fields`, {
          field_name: name,
          type,
        });
    }
    this.schemaChecked = true;
  }
  async recover(): Promise<ThresholdAdjustmentEntry[]> {
    await this.ensureSchema();
    const records = await fetchBitableRecords(this.http, {
      appToken: THRESHOLD_APPROVAL_BASE,
      tableId: THRESHOLD_APPROVAL_TABLE,
      tableName: '阈值审批恢复',
      fieldNames: ['程序申请编号', '阈值审批快照'],
      filter: {
        conjunction: 'and',
        conditions: [
          { field_name: '程序申请编号', operator: 'isNotEmpty', value: [] },
        ],
      },
      strict: true,
      allowStale: false,
      forceRefresh: true,
    });
    return records.map((record) => {
      const signed = JSON.parse(thresholdText(record.fields?.['阈值审批快照']));
      const signature = this.sign(signed.entry),
        actual = Buffer.from(String(signed.signature || ''), 'hex'),
        expected = Buffer.from(signature, 'hex');
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new ConflictException('阈值审批快照签名无效，已停止恢复');
      const entry = signed.entry as ThresholdAdjustmentEntry;
      if (
        entry.adjustment?.id !==
        extractDisplayText(record.fields?.['程序申请编号'], '')
      )
        throw new ConflictException('阈值审批记录绑定不一致');
      return {
        ...entry,
        cloudRecordId: record.record_id || record.id,
        lease: undefined,
      };
    });
  }
  async sync(entry: ThresholdAdjustmentEntry): Promise<string> {
    await this.ensureSchema();
    const a = entry.adjustment;
    let recordId = entry.cloudRecordId;
    if (!recordId) {
      const records = await fetchBitableRecords(this.http, {
        appToken: THRESHOLD_APPROVAL_BASE,
        tableId: THRESHOLD_APPROVAL_TABLE,
        tableName: '阈值申请幂等查询',
        fieldNames: ['程序申请编号'],
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: '程序申请编号', operator: 'is', value: [a.id] },
          ],
        },
        strict: true,
        allowStale: false,
        forceRefresh: true,
      });
      if (records.length > 1)
        throw new ConflictException('多维表存在重复阈值审批申请');
      recordId = records[0]?.record_id || records[0]?.id;
    }
    const names = {
      routing: '审批准备中',
      pending: '楼长及专业示例人员001审批',
      approved: '审批通过',
      awaiting_completion: '待工程师确认',
      confirmed: '工程师已确认',
      applying: '阈值同步中',
      completed: '已生效',
      rejected: '已驳回',
      conflict: '阈值已变化',
    };
    const fields: Record<string, unknown> = {
      文本: `${a.before.building} · ${a.before.device} · ${a.before.parameter}`,
      程序申请编号: a.id,
      阈值记录标识: a.before.id,
      参数名称: a.before.parameter,
      原阈值: a.before.value,
      申请阈值: a.value,
      单位: a.before.unit,
      需调整的设备名称: a.before.device,
      楼栋: [a.before.building],
      专业: a.before.profession,
      调整描述: a.reason,
      调整人: users([a.engineer]),
      申请人: users([a.applicant]),
      计划进行时间: Date.parse(a.plannedAt),
      楼长审批人: users(
        a.stages.filter((s) => s.role === 'building').map((s) => s.approver),
      ),
      专业审批人: users(
        a.stages
          .filter((s) => s.role === 'professional')
          .map((s) => s.approver),
      ),
      机房经理知会人: users(a.managers),
      阈值审批阶段: names[a.state],
      阈值审批回执: JSON.stringify(a.stages),
      阈值消息回执: JSON.stringify(entry.messages),
      阈值审批错误: a.error || '',
      阈值申请幂等键: a.clientMutationId,
      阈值调整确认回执: JSON.stringify(a.execution || null),
      阈值审批快照: JSON.stringify({
        entry: { ...entry, lease: undefined, cloudRevision: a.revision },
        signature: this.sign({
          ...entry,
          lease: undefined,
          cloudRevision: a.revision,
        }),
      }),
    };
    for (const s of a.stages)
      if (s.decision)
        fields[s.role === 'building' ? '楼长审批' : '专业审批'] =
          s.decision.action === 'approve' ? '通过' : '驳回';
    if (a.state === 'rejected')
      fields['反馈'] =
        a.stages.find((s) => s.decision?.action === 'reject')?.decision
          ?.reason || '';
    if (a.state === 'completed') fields['调整进度'] = '已调整';
    const data = await this.request(
      recordId ? 'put' : 'post',
      `${THRESHOLD_APPROVAL_TABLE}/records${recordId ? '/' + encodeURIComponent(recordId) : ''}`,
      { fields },
    );
    recordId = recordId || (data.record as { record_id?: string })?.record_id;
    if (!recordId) throw new BadGatewayException('审批写入缺少记录回执');
    const read = await this.request(
      'get',
      `${THRESHOLD_APPROVAL_TABLE}/records/${encodeURIComponent(recordId)}`,
    );
    const actual = (read.record as { fields: Record<string, unknown> })?.fields;
    for (const [key, expected] of Object.entries(fields)) {
      const equal = Array.isArray(expected)
        ? JSON.stringify(normalizeArray(actual?.[key])) ===
          JSON.stringify(normalizeArray(expected))
        : typeof expected === 'number'
          ? Number(actual?.[key]) === expected
          : thresholdText(actual?.[key]) === expected;
      if (!equal) throw new BadGatewayException(`审批字段“${key}”回读未确认`);
    }
    invalidateBitableRecordCache({
      appToken: THRESHOLD_APPROVAL_BASE,
      tableId: THRESHOLD_APPROVAL_TABLE,
    });
    return recordId;
  }
  private sign(entry: unknown) {
    const auth = getFeishuAuthPayload();
    return createHmac('sha256', auth.app_secret)
      .update('threshold-approval-v1\0')
      .update(JSON.stringify(entry))
      .digest('hex');
  }
  private async metadata<T>(path: string) {
    const items: T[] = [];
    let page = '';
    const visited = new Set<string>();
    do {
      const data = await this.request('get', path, undefined, {
        page_size: 100,
        ...(page ? { page_token: page } : {}),
      });
      items.push(...((data.items as T[]) || []));
      page = data.has_more ? String(data.page_token || '') : '';
      if (data.has_more && (!page || visited.has(page)))
        throw new ServiceUnavailableException('审批表字段分页异常');
      if (page) visited.add(page);
    } while (page);
    return items;
  }
  private async request(
    method: 'get' | 'post' | 'put',
    path: string,
    data?: unknown,
    params?: unknown,
  ): Promise<Record<string, unknown>> {
    const token = await getTenantAccessToken(this.http);
    try {
      const result = await this.http.axiosRef.request({
        method,
        url: `https://open.feishu.cn/open-apis/bitable/v1/apps/${THRESHOLD_APPROVAL_BASE}/tables/${path}`,
        data,
        params,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
      if (result.data.code !== 0)
        throw new BadGatewayException(
          `阈值审批多维表请求失败（${result.data.code}）`,
        );
      return result.data.data || {};
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException('阈值审批多维表连接失败，请重试');
    }
  }
}
function users(people: ThresholdPerson[]) {
  return [...new Map(people.map((p) => [p.openId, { id: p.openId }])).values()];
}
function normalizeArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((v) => (typeof v === 'string' ? v : String(v?.id || '')))
    .sort();
}
