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
import { invalidateBitableRecordCache } from '../../common/feishu/bitable-direct-read';
import type { LeaveRequestShiftGroup } from '../../../shared/leave-request-impact';
import type { LeaveShiftSubstituteAssignment } from './leave-workflow.types';

const OPENAPI_BASE_URL = 'https://open.feishu.cn/open-apis';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_SEARCH_PAGES = 100;
const DETAIL_SEARCH_BATCH_SIZE = 20;
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
    const existing = await this.readExistingDetails(recordId, groups);
    for (const group of groups) {
      const detailId = stableDetailId(recordId, group.shiftKey);
      if (existing.has(detailId)) continue;
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
    const existingDetails = await this.readExistingDetails(recordId, assignments);
    if ([...existingDetails.values()].some((record) =>
      record.fields['状态'] === 'active' && Number(record.fields['替班安排版本']) > revision,
    )) throw new BadGatewayException('请假替班班次明细版本已更新，请刷新后重试');
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
      const existing = existingDetails.get(detailId);
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
    for (const record of await this.searchRecords('请假记录ID', recordIds.map(requireRecordId))) {
      const row = parseDetailRecord(record);
      if (!row.detailId || rows.has(row.detailId)) throw new BadGatewayException('请假替班班次明细“明细唯一ID”不唯一');
      rows.set(row.detailId, row);
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
    if (!record || record.record_id !== recordId) throw new BadGatewayException('回读请假替班班次明细记录不匹配');
    const actual = parseDetailRecord(record);
    if (!sameTextSet(actual.scheduleRecordIds, expected.scheduleRecordIds)) {
      throw new BadGatewayException('请假替班班次明细排班记录集合回读不一致');
    }
    if (!detailRowsEqual(actual, expected)) {
      throw new BadGatewayException('请假替班班次明细语义回读不一致');
    }
  }

  private async readExistingDetails(
    recordId: string,
    shifts: readonly { shiftKey: string }[],
  ): Promise<Map<string, FeishuRecord>> {
    const expected = new Map(shifts.map(({ shiftKey }) => [stableDetailId(recordId, shiftKey), shiftKey]));
    if (expected.size !== shifts.length) throw new BadRequestException('待同步的请假班次重复');
    const existing = new Map<string, FeishuRecord>();
    for (const record of await this.searchRecords('明细唯一ID', [...expected.keys()])) {
      const detailId = detailText(record.fields['明细唯一ID']);
      if (existing.has(detailId)) throw new BadGatewayException('请假替班班次明细“明细唯一ID”不唯一');
      if (detailText(record.fields['请假记录ID']) !== recordId ||
          detailText(record.fields['班次键']) !== expected.get(detailId)) {
        throw new BadGatewayException('请假替班班次明细关联的申请或班次不匹配');
      }
      existing.set(detailId, record);
    }
    return existing;
  }

  private async searchRecords(
    fieldName: string,
    values: string[],
  ): Promise<FeishuRecord[]> {
    const uniqueValues = [...new Set(values)];
    const records: FeishuRecord[] = [];
    const seenRecordIds = new Set<string>();
    for (let start = 0; start < uniqueValues.length; start += DETAIL_SEARCH_BATCH_SIZE) {
      const batch = uniqueValues.slice(start, start + DETAIL_SEARCH_BATCH_SIZE);
      for (const record of await this.searchRecordBatch(fieldName, batch)) {
        if (seenRecordIds.has(record.record_id)) throw new BadGatewayException('请假替班班次明细返回了重复记录');
        seenRecordIds.add(record.record_id);
        records.push(record);
      }
    }
    return records;
  }

  private async searchRecordBatch(
    fieldName: string,
    values: string[],
  ): Promise<FeishuRecord[]> {
    const expected = new Set(values);
    const records: FeishuRecord[] = [];
    const url = `${await this.recordsUrl()}/search`;
    let pageToken = '';
    let total: number | undefined;
    const seenTokens = new Set<string>();
    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const response = await this.httpService.axiosRef.post(
        url,
        {
          filter: {
            conjunction: values.length === 1 ? 'and' : 'or',
            conditions: values.map((value) => ({ field_name: fieldName, operator: 'is', value: [value] })),
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
      const explicitEmpty = page === 0 && data && !Object.hasOwn(data, 'items') &&
        data.total === 0 && data.has_more === false && (data.page_token === undefined || data.page_token === '');
      const items = explicitEmpty ? [] : data?.items;
      if (response.data?.code !== 0 || !Array.isArray(items) ||
          (data.has_more !== undefined && typeof data.has_more !== 'boolean') ||
          (data.has_more === undefined && data.total === undefined) ||
          (data.page_token !== undefined && typeof data.page_token !== 'string') ||
          (data.total !== undefined && (!Number.isSafeInteger(data.total) || data.total < 0 ||
            (total !== undefined && total !== data.total)))) {
        throw new BadGatewayException('请假替班班次明细分页回执无效');
      }
      total ??= data.total;
      for (const record of items) {
        if (!record || typeof record.record_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(record.record_id) ||
            !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields) ||
            !expected.has(detailText(record.fields[fieldName]))) {
          throw new BadGatewayException('请假替班班次明细回执超出查询范围或记录无效');
        }
        records.push(record);
      }
      if (!data.has_more) {
        if ((data.has_more !== false && data.page_token?.trim()) || (total !== undefined && total !== records.length)) {
          throw new BadGatewayException('请假替班班次明细分页回执不完整');
        }
        return records;
      }
      const next = data.page_token?.trim();
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
    const { appToken, tableId, url } = await this.recordsTarget();
    const response = await this.httpService.axiosRef.post(
      url,
      { fields },
      {
        ...(await this.requestConfig()),
        params: { client_token: clientToken },
      },
    );
    assertFeishuSuccess(response.data, '创建请假替班班次明细失败');
    invalidateBitableRecordCache({ appToken, tableId, deletePersisted: true });
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
    const { appToken, tableId, url } = await this.recordsTarget();
    const response = await this.httpService.axiosRef.put(
      `${url}/${encodeURIComponent(recordId)}`,
      { fields },
      await this.requestConfig(),
    );
    assertFeishuSuccess(response.data, '更新请假替班班次明细失败');
    invalidateBitableRecordCache({ appToken, tableId, deletePersisted: true });
    return (
      (response.data?.data?.record as FeishuRecord | undefined) || {
        record_id: recordId,
        fields,
      }
    );
  }

  private async recordsUrl(): Promise<string> {
    return (await this.recordsTarget()).url;
  }

  private async recordsTarget() {
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
    const url = `${OPENAPI_BASE_URL}/bitable/v1/apps/${encodeURIComponent(
      appToken,
    )}/tables/${encodeURIComponent(tableId)}/records`;
    return { appToken, tableId, url };
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
  const text = (name: string) => detailText(fields[name]);
  const status = fields['状态'] === 'active' ? 'active' : 'pending';
  const assignment =
    status === 'active' && text('替班人员记录ID')
      ? {
          shiftKey: text('班次键'),
          scheduleRecordIds: readStringArray(fields['排班记录IDs']),
          scheduleDate: formatShanghaiDate(fields['班次日期']),
          startAt: formatShanghaiMinute(fields['开始时间']),
          endAt: formatShanghaiMinute(fields['结束时间']),
          shift: text('班次'),
          buildings: splitText(text('楼栋')),
          teams: splitText(text('班组')),
          substitutePersonRecordId: text('替班人员记录ID'),
          substituteName: text('替班人员姓名'),
          substituteOpenId: text('替班人员OpenID'),
          updatedByOpenId: text('调整人OpenID'),
          updatedByName: text('调整人姓名'),
          updatedAt: new Date(Number(fields['调整时间'] || 0)).toISOString(),
        }
      : null;
  return {
    detailId: text('明细唯一ID'),
    leaveRecordId: text('请假记录ID'),
    shiftKey: text('班次键'),
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
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return uniqueText(value);
  try {
    const parsed = JSON.parse(detailText(value) || '[]');
    return Array.isArray(parsed) ? uniqueText(parsed) : [];
  } catch {
    return [];
  }
}

function detailText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join(',').trim();
  if (Array.isArray(value) && value.every((part) => typeof part?.text === 'string')) {
    return value.map((part) => part.text).join('').trim();
  }
  return '';
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
