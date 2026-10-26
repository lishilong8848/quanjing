import { HttpService } from '@nestjs/axios';
import { Inject, Injectable } from '@nestjs/common';
import type { MonthlyAlarmsResponse } from '../../../shared/monthly-operations-alarms.interface';
import { readEnv } from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  type BitableRecordSearchFilter,
} from '../../common/feishu/bitable-direct-read';
import { resourceRange, addDays } from './monthly-operations-resources.model';
import { mapMonthlyAlarms } from './monthly-operations-alarms.model';
import { getAlarmTagSemanticReviewer } from './today-operations-alarm-tag-ai';
export const MONTHLY_ALARM_SOURCE = {
  appToken: 'JeMdbI3JjawMj1s1YGSc3MoBn7c',
  tableId: 'tbld976fa6fc1832',
  tableName: '月览告警分析',
  fieldNames: [
    '等级',
    '楼栋',
    '告警内容',
    '具体位置',
    '监控对象',
    '产生时间',
    '处理状态',
    '受理状态（公式）',
    '受理描述',
    '恢复时间',
    '恢复状态',
    '恢复状态（公式）',
    '确认时间',
    '确认描述',
    '预期外/预期内',
    '分类',
    '更新时间',
  ],
};
@Injectable()
export class MonthlyOperationsAlarmsService {
  constructor(@Inject(HttpService) private readonly http: HttpService) {}
  async get(
    start: unknown,
    end: unknown,
    refresh = false,
  ): Promise<MonthlyAlarmsResponse> {
    const range = resourceRange(start, end);
    const filter: BitableRecordSearchFilter = {
      conjunction: 'and',
      conditions: [
        { field_name: '等级', operator: 'isNotEmpty', value: [] },
        {
          field_name: '产生时间',
          operator: 'isGreater',
          value: [
            'ExactDate',
            String(Date.parse(addDays(range.start, -1) + 'T00:00:00+08:00')),
          ],
        },
        {
          field_name: '产生时间',
          operator: 'isLess',
          value: [
            'ExactDate',
            String(Date.parse(addDays(range.asOf, 1) + 'T00:00:00+08:00')),
          ],
        },
      ],
    };
    const source = { ...MONTHLY_ALARM_SOURCE, filter };
    const prefix = [
      'TODAY_OPERATIONS_KPI_FEISHU',
      'FEISHU_RISK_INSPECTION',
      'ALI_MONTHLY_REPORT_FEISHU',
    ].find((p) => readEnv(p + '_APP_ID') && readEnv(p + '_APP_SECRET'));
    const auth = prefix
      ? {
          appId: readEnv(prefix + '_APP_ID'),
          appSecret: readEnv(prefix + '_APP_SECRET'),
        }
      : undefined;
    const project = (items: Parameters<typeof mapMonthlyAlarms>[0]) => {
      const result = mapMonthlyAlarms(
        items,
        Math.min(
          Date.now(),
          Date.parse(addDays(range.asOf, 1) + 'T00:00:00+08:00') - 1,
        ),
      );
      const records = result.records.filter(
        (r) => r.date && r.date >= range.start && r.date <= range.asOf,
      );
      const review = getAlarmTagSemanticReviewer(this.http).snapshot(
        records.map((row) => ({
          id: row.id,
          description: row.title,
          location: row.location,
          monitorObject: row.object,
          acceptanceDescription: row.acceptanceDescription,
          confirmationDescription: row.confirmationDescription,
        })),
      );
      for (const row of records) {
        row.tagIssues.push(...(review.issuesById.get(row.id) || []));
        if (row.tagIssues.length && !row.tags.includes('打标异常'))
          row.tags.push('打标异常');
      }
      return { ...result, records, tagReview: review.status };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const records = await Promise.race([
        fetchBitableRecords(this.http, {
          ...source,
          auth,
          strict: true,
          allowStale: !refresh,
          cacheTtlMs: 300000,
          forceRefresh: refresh,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('读取超时')), 35000);
        }),
      ]);
      const snapshot = await readLatestPersistedBitableRecordSnapshot(source),
        updating =
          !refresh && snapshot && Date.now() - snapshot.fetchedAt >= 300000,
        result = project(records);
      return {
        range,
        status: updating ? 'stale' : result.records.length ? 'ready' : 'empty',
        ...(updating ? { message: '后台更新中' } : {}),
        syncedAt: new Date(snapshot?.fetchedAt ?? Date.now()).toISOString(),
        ...result,
      };
    } catch {
      const snapshot = await readLatestPersistedBitableRecordSnapshot(source);
      return snapshot
        ? {
            range,
            status: 'stale',
            message: '更新失败，显示上次成功数据',
            syncedAt: new Date(snapshot.fetchedAt).toISOString(),
            ...project(snapshot.records),
          }
        : {
            range,
            status: 'error',
            message: '告警读取失败，请重试',
            syncedAt: null,
            records: [],
            invalid: 0,
            tagReview: getAlarmTagSemanticReviewer(this.http).snapshot([]).status,
          };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
