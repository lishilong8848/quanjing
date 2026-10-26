import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  getFeishuAuthPayload,
  readEnv,
} from '../../common/config/external-services.config';
import type { LeaveRequestShiftGroup } from '../../../shared/leave-request-impact';
import type { LeaveShiftSubstituteAssignment } from './leave-workflow.types';

const OPENAPI_BASE_URL = 'https://open.feishu.cn/open-apis';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_SEARCH_PAGES = 100;
const SHIFT_DETAIL_TABLE_NAME = '请假替班班次明细';

export interface LeaveShiftDetailRow {
  detailId: string;
  leaveRecordId: string;
  shiftKey: string;
  scheduleRecordIds: string[];
  assignment: LeaveShiftSubstituteAssignment | null;
  revision: number;
  status: 'pending' | 'active';
}

interface FeishuRecord {
  record_id: string;
  fields: Record<string, any>;
}

@Injectable()
export class LeaveWorkflowDetailGateway {
  private tenantToken = '';
  private discoveredTableId = '';

  constructor(private readonly httpService: HttpService) {}

  async ensurePendingRows(
    recordId: string,
    groups: LeaveRequestShiftGroup[],
  ): Promise<void> {
    requireRecordId(recordId);
    for (const group of groups) {
      const detailId = stableDetailId(recordId, group.shiftKey);
      const existing = await this.searchOne('明细唯一ID', detailId);
      if (existing) continue;
      const fields = pendingFields(recordId, detailId, group);
      const created = await this.createRecord(
        fields,
        stableClientToken(`pending:${detailId}`),
      );
      await this.assertReadback(created.record_id, {
        ...parseDetailRecord(created),
        detailId,
        leaveRecordId: recordId,
        shiftKey: group.shiftKey,
        scheduleRecordIds: [...group.scheduleRecordIds].sort(),
        assignment: null,
        revision: 0,
        status: 'pending',
      });
    }
  }

  async upsertCurrentAssignments(
    recordId: string,
    revision: number,
    assignments: LeaveShiftSubstituteAssignment[],
  ): Promise<void> {
    requireRecordId(recordId);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new BadRequestException('替班安排版本无效');
    }
    for (const assignment of assignments) {
      const detailId = stableDetailId(recordId, assignment.shiftKey);
      const expected: LeaveShiftDetailRow = {
        detailId,
        leaveRecordId: recordId,
        shiftKey: assignment.shiftKey,
        scheduleRecordIds: [...new Set(assignment.scheduleRecordIds)].sort(),
        assignment: clone(assignment),
        revision,
        status: 'active',
      };
      const existing = await this.searchOne('明细唯一ID', detailId);
      if (existing && detailRowsEqual(parseDetailRecord(existing), expected)) {
        continue;
      }
      const fields = activeFields(recordId, detailId, assignment, revision);
      const stored = existing
        ? await this.updateRecord(existing.record_id, fields)
        : await this.createRecord(
            fields,
            stableClientToken(`active:${detailId}:${revision}`),
          );
      await this.assertReadback(stored.record_id, expected);
    }
  }

  async readByLeaveRecordIds(
    recordIds: string[],
  ): Promise<LeaveShiftDetailRow[]> {
    const rows = new Map<string, LeaveShiftDetailRow>();
    for (const recordId of [...new Set(recordIds.map(requireRecordId))]) {
      for (const record of await this.searchRecords('请假记录ID', recordId)) {
        const row = parseDetailRecord(record);
        if (row.leaveRecordId === recordId) rows.set(row.detailId, row);
      }
    }
    return [...rows.values()].sort(
      (left, right) =>
        left.leaveRecordId.localeCompare(right.leaveRecordId) ||
        left.shiftKey.localeCompare(right.shiftKey),
    );
  }

  private async assertReadback(
    recordId: string,
    expected: LeaveShiftDetailRow,
  ): Promise<void> {
    const response = await this.httpService.axiosRef.get(
      `${await this.recordsUrl()}/${encodeURIComponent(recordId)}`,
      await this.requestConfig(),
    );
    assertFeishuSuccess(response.data, '回读请假替班班次明细失败');
    const record = response.data?.data?.record as FeishuRecord | undefined;
    if (!record) throw new BadGatewayException('回读请假替班班次明细缺少记录');
    const actual = parseDetailRecord(record);
    if (!sameTextSet(actual.scheduleRecordIds, expected.scheduleRecordIds)) {
      throw new BadGatewayException('请假替班班次明细排班记录集合回读不一致');
    }
    if (!detailRowsEqual(actual, expected)) {
      throw new BadGatewayException('请假替班班次明细语义回读不一致');
    }
  }

  private async searchOne(
    fieldName: string,
    value: string,
  ): Promise<FeishuRecord | null> {
    const records = await this.searchRecords(fieldName, value);
    if (records.length > 1) {
      throw new BadGatewayException(`请假替班班次明细“${fieldName}”不唯一`);
    }
    return records[0] || null;
  }

  private async searchRecords(
    fieldName: string,
    value: string,
  ): Promise<FeishuRecord[]> {
    const records: FeishuRecord[] = [];
    let pageToken = '';
    const seenTokens = new Set<string>();
    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const response = await this.httpService.axiosRef.post(
        `${await this.recordsUrl()}/search`,
        {
          filter: {
            conjunction: 'and',
            conditions: [
              { field_name: fieldName, operator: 'is', value: [value] },
            ],
          },
        },
        {
          ...(await this.requestConfig()),
          params: {
            page_size: 200,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
      );
      assertFeishuSuccess(response.data, '查询请假替班班次明细失败');
      const data = response.data?.data;
      if (Array.isArray(data?.items)) records.push(...data.items);
      if (!data?.has_more) return records;
      const next = String(data?.page_token || '').trim();
      if (!next || seenTokens.has(next)) {
        throw new BadGatewayException('请假替班班次明细分页标识无效');
      }
      seenTokens.add(next);
      pageToken = next;
    }
    throw new BadGatewayException('请假替班班次明细分页超过安全限制');
  }

  private async createRecord(
    fields: Record<string, unknown>,
    clientToken: string,
  ): Promise<FeishuRecord> {
    const response = await this.httpService.axiosRef.post(
      await this.recordsUrl(),
      { fields },
      {
        ...(await this.requestConfig()),
        params: { client_token: clientToken },
      },
    );
    assertFeishuSuccess(response.data, '创建请假替班班次明细失败');
    const record = response.data?.data?.record as FeishuRecord | undefined;
    if (!record?.record_id) {
      throw new BadGatewayException('创建请假替班班次明细响应缺少记录');
    }
    return record;
  }

  private async updateRecord(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<FeishuRecord> {
    const response = await this.httpService.axiosRef.put(
      `${await this.recordsUrl()}/${encodeURIComponent(recordId)}`,
      { fields },
      await this.requestConfig(),
    );
    assertFeishuSuccess(response.data, '更新请假替班班次明细失败');
    return (
      (response.data?.data?.record as FeishuRecord | undefined) || {
        record_id: recordId,
        fields,
      }
    );
  }

  private async recordsUrl(): Promise<string> {
    const appToken = readEnv('FEISHU_LEAVE_REQUEST_APP_TOKEN', [
      'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
      'FEISHU_MAIN_APP_TOKEN',
      'FEISHU_BITABLE_APP_TOKEN',
    ]);
    if (!appToken) {
      throw new BadRequestException('请假替班班次明细表未配置');
    }
    const tableId =
      readEnv('FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID') ||
      (await this.discoverTableId(appToken));
    return `${OPENAPI_BASE_URL}/bitable/v1/apps/${encodeURIComponent(
      appToken,
    )}/tables/${encodeURIComponent(tableId)}/records`;
  }

  private async discoverTableId(appToken: string): Promise<string> {
    if (this.discoveredTableId) return this.discoveredTableId;
    const matches: string[] = [];
    let pageToken = '';
    const seenTokens = new Set<string>();
    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const response = await this.httpService.axiosRef.get(
        `${OPENAPI_BASE_URL}/bitable/v1/apps/${encodeURIComponent(
          appToken,
        )}/tables`,
        {
          ...(await this.requestConfig()),
          params: {
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
      );
      assertFeishuSuccess(response.data, '查询请假替班班次明细表失败');
      const data = response.data?.data;
      for (const item of Array.isArray(data?.items) ? data.items : []) {
        if (String(item?.name || '').trim() !== SHIFT_DETAIL_TABLE_NAME) {
          continue;
        }
        const candidate = String(item?.table_id || '').trim();
        if (candidate) matches.push(candidate);
      }
      if (!data?.has_more) break;
      const next = String(data?.page_token || '').trim();
      if (!next || seenTokens.has(next)) {
        throw new BadGatewayException('请假替班班次明细表分页标识无效');
      }
      seenTokens.add(next);
      pageToken = next;
    }
    const uniqueMatches = [...new Set(matches)];
    if (uniqueMatches.length !== 1) {
      throw new BadRequestException(
        uniqueMatches.length === 0
          ? '请假替班班次明细表未配置'
          : '请假替班班次明细表名称不唯一',
      );
    }
    this.discoveredTableId = uniqueMatches[0];
    return this.discoveredTableId;
  }

  private async requestConfig() {
    return {
      headers: { Authorization: `Bearer ${await this.getTenantToken()}` },
      timeout: REQUEST_TIMEOUT_MS,
    };
  }

  private async getTenantToken(): Promise<string> {
    if (this.tenantToken) return this.tenantToken;
    const response = await this.httpService.axiosRef.post(
      `${OPENAPI_BASE_URL}/auth/v3/tenant_access_token/internal`,
      getFeishuAuthPayload(),
      { timeout: 10_000 },
    );
    assertFeishuSuccess(response.data, '获取飞书应用访问令牌失败');
    const token = String(
      response.data?.tenant_access_token ||
        response.data?.data?.tenant_access_token ||
        '',
    ).trim();
    if (!token) throw new BadGatewayException('飞书应用访问令牌为空');
    this.tenantToken = token;
    return token;
  }
}

function pendingFields(
  leaveRecordId: string,
  detailId: string,
  group: LeaveRequestShiftGroup,
): Record<string, unknown> {
  return {
    明细唯一ID: detailId,
    请假记录ID: leaveRecordId,
    请假主记录: [leaveRecordId],
    班次键: group.shiftKey,
    排班记录IDs: JSON.stringify([...group.scheduleRecordIds].sort()),
    排班记录: [...group.scheduleRecordIds].sort(),
    班次日期: dateTimestamp(group.scheduleDate),
    开始时间: dateTimeTimestamp(group.startAt),
    结束时间: dateTimeTimestamp(group.endAt),
    班次: group.shift,
    楼栋: group.buildings.join('、'),
    班组: group.teams.join('、'),
    替班安排版本: 0,
    状态: 'pending',
  };
}

function activeFields(
  leaveRecordId: string,
  detailId: string,
  assignment: LeaveShiftSubstituteAssignment,
  revision: number,
): Record<string, unknown> {
  return {
    ...pendingFields(leaveRecordId, detailId, {
      shiftKey: assignment.shiftKey,
      scheduleDate: assignment.scheduleDate,
      startAt: assignment.startAt,
      endAt: assignment.endAt,
      kind: 'white',
      shift: assignment.shift,
      buildings: assignment.buildings,
      teams: assignment.teams,
      scheduleRecordIds: assignment.scheduleRecordIds,
      leaveHours: 0,
    }),
    替班人员记录ID: assignment.substitutePersonRecordId,
    替班人员姓名: assignment.substituteName,
    替班人员OpenID: assignment.substituteOpenId,
    替班用户: [{ id: assignment.substituteOpenId }],
    调整人OpenID: assignment.updatedByOpenId,
    调整人姓名: assignment.updatedByName,
    调整时间: Date.parse(assignment.updatedAt),
    替班安排版本: revision,
    状态: 'active',
  };
}

function parseDetailRecord(record: FeishuRecord): LeaveShiftDetailRow {
  const fields = record.fields || {};
  const status = fields['状态'] === 'active' ? 'active' : 'pending';
  const assignment =
    status === 'active' && String(fields['替班人员记录ID'] || '').trim()
      ? {
          shiftKey: String(fields['班次键'] || '').trim(),
          scheduleRecordIds: readStringArray(fields['排班记录IDs']),
          scheduleDate: formatShanghaiDate(fields['班次日期']),
          startAt: formatShanghaiMinute(fields['开始时间']),
          endAt: formatShanghaiMinute(fields['结束时间']),
          shift: String(fields['班次'] || '').trim(),
          buildings: splitText(fields['楼栋']),
          teams: splitText(fields['班组']),
          substitutePersonRecordId: String(
            fields['替班人员记录ID'] || '',
          ).trim(),
          substituteName: String(fields['替班人员姓名'] || '').trim(),
          substituteOpenId: String(fields['替班人员OpenID'] || '').trim(),
          updatedByOpenId: String(fields['调整人OpenID'] || '').trim(),
          updatedByName: String(fields['调整人姓名'] || '').trim(),
          updatedAt: new Date(Number(fields['调整时间'] || 0)).toISOString(),
        }
      : null;
  return {
    detailId: String(fields['明细唯一ID'] || '').trim(),
    leaveRecordId: String(fields['请假记录ID'] || '').trim(),
    shiftKey: String(fields['班次键'] || '').trim(),
    scheduleRecordIds: readStringArray(fields['排班记录IDs']),
    assignment,
    revision: Number(fields['替班安排版本'] || 0),
    status,
  };
}

function detailRowsEqual(
  left: LeaveShiftDetailRow,
  right: LeaveShiftDetailRow,
): boolean {
  return (
    left.detailId === right.detailId &&
    left.leaveRecordId === right.leaveRecordId &&
    left.shiftKey === right.shiftKey &&
    sameTextSet(left.scheduleRecordIds, right.scheduleRecordIds) &&
    left.revision === right.revision &&
    left.status === right.status &&
    assignmentSemanticKey(left.assignment) === assignmentSemanticKey(right.assignment)
  );
}

function assignmentSemanticKey(assignment: LeaveShiftSubstituteAssignment | null): string {
  if (!assignment) return 'null';
  return JSON.stringify({
    shiftKey: assignment.shiftKey, scheduleDate: assignment.scheduleDate, startAt: assignment.startAt, endAt: assignment.endAt,
    shift: assignment.shift, scheduleRecordIds: [...assignment.scheduleRecordIds].sort(), buildings: [...assignment.buildings].sort(), teams: [...assignment.teams].sort(),
    substitutePersonRecordId: assignment.substitutePersonRecordId, substituteOpenId: assignment.substituteOpenId, substituteName: assignment.substituteName,
    updatedByOpenId: assignment.updatedByOpenId, updatedByName: assignment.updatedByName, updatedAt: assignment.updatedAt,
  });
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueText(value);
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? uniqueText(parsed) : [];
  } catch {
    return [];
  }
}

function splitText(value: unknown): string[] {
  return uniqueText(String(value || '').split(/[、,，]/u));
}

function uniqueText(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function sameTextSet(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function dateTimestamp(value: string): number {
  return dateTimeTimestamp(`${value}T00:00`);
}

function dateTimeTimestamp(value: string): number {
  const timestamp = Date.parse(`${value}:00+08:00`);
  if (!Number.isFinite(timestamp))
    throw new BadRequestException('班次时间无效');
  return timestamp;
}

function formatShanghaiDate(value: unknown): string {
  return formatShanghaiMinute(value).slice(0, 10);
}

function formatShanghaiMinute(value: unknown): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || '';
  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}`;
}

function stableDetailId(recordId: string, shiftKey: string): string {
  return `leave-shift-${createHash('sha256')
    .update(`${recordId}\0${shiftKey}`)
    .digest('hex')}`;
}

function stableClientToken(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
  const chars = hex.split('');
  chars[12] = '4';
  chars[16] = ['8', '9', 'a', 'b'][parseInt(chars[16], 16) % 4];
  const normalized = chars.join('');
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

function requireRecordId(value: unknown): string {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(result)) {
    throw new BadRequestException('请假记录标识无效');
  }
  return result;
}

function assertFeishuSuccess(payload: any, message: string): void {
  const code = Number(payload?.code || 0);
  if (code !== 0) {
    throw new BadGatewayException(`${message}：飞书错误码 ${code}`);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
