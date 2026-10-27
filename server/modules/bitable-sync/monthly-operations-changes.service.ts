import { HttpService } from '@nestjs/axios';
import { Inject, Injectable } from '@nestjs/common';
import type { MonthlyChangesResponse } from '../../../shared/monthly-operations-changes.interface';
import type { ZhihangProgressResponse } from '../../../shared/monthly-operations-progress.interface';
import { readEnv } from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { resourceRange } from './monthly-operations-resources.model';
import { mapMonthlyChanges } from './monthly-operations-changes.model';
import { mapZhihangProgress } from './monthly-operations-progress.model';
export const ZHIHANG_PROGRESS_SOURCE = {
  tableId: 'tbl2cJuTBqRdIm8Z',
  tableName: '智航变更进展',
  fieldNames: [
    '编码',
    '工单号',
    '标题',
    '楼栋',
    '变更类型',
    '变更类别',
    '变更等级',
    '当前节点',
    '状态',
    '当前状态',
    '计划开始',
    '计划结束',
    '计划延期开始',
    '计划延期结束',
    '实际开始',
    '实际结束',
    '最后更新时间',
    '计划开始时间',
    '计划结束时间',
    '计划延时开始时间',
    '计划延时结束时间',
    '实际开始时间',
    '实际结束时间',
  ],
} as const;
export const MONTHLY_CHANGE_SOURCE = {
  tableId: 'tblBvg6wCYSX3hcg',
  tableName: '月览变更',
  fieldNames: [
    '自增编号',
    '变更简述',
    '变更进度',
    '作业类型',
    '计划开始日期（阿里）',
    '计划结束日期（阿里）',
    '计划延迟开始日期',
    '计划延迟结束日期',
    '变更楼栋',
    '专业',
    '变更等级（阿里）',
    '变更重要风险点（简述）',
    '变更情况（变更完成或取消后填写）',
    '变更类型',
    '变更性质判断',
    '实际开始时间',
    '实际结束时间',
    '延期理由',
  ],
} as const;
@Injectable()
export class MonthlyOperationsChangesService {
  constructor(@Inject(HttpService) private readonly http: HttpService) {}
  async getChanges(
    start: unknown,
    end: unknown,
    refresh = false,
  ): Promise<MonthlyChangesResponse> {
    return this.getSource(
      start,
      end,
      refresh,
      MONTHLY_CHANGE_SOURCE,
      mapMonthlyChanges,
    );
  }
  async getProgress(
    start: unknown,
    end: unknown,
    refresh = false,
  ): Promise<ZhihangProgressResponse> {
    return this.getSource(
      start,
      end,
      refresh,
      ZHIHANG_PROGRESS_SOURCE,
      mapZhihangProgress,
    );
  }
  private async getSource<T>(
    start: unknown,
    end: unknown,
    refresh: boolean,
    source: {
      tableId: string;
      tableName: string;
      fieldNames: readonly string[];
    },
    map: (records: BitableRecordItem[]) => { records: T[]; invalid: number },
  ): Promise<Omit<MonthlyChangesResponse, 'records'> & { records: T[] }> {
    const range = resourceRange(start, end);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const authPrefix = [
      'TODAY_OPERATIONS_KPI_FEISHU',
      'FEISHU_RISK_INSPECTION',
      'ALI_MONTHLY_REPORT_FEISHU',
    ].find(
      (prefix) =>
        readEnv(`${prefix}_APP_ID`) && readEnv(`${prefix}_APP_SECRET`),
    );
    const auth = authPrefix
      ? {
          appId: readEnv(`${authPrefix}_APP_ID`),
          appSecret: readEnv(`${authPrefix}_APP_SECRET`),
        }
      : undefined;
    try {
      const read = async () => {
        const appToken = await resolveBitableAppToken(this.http, {
          wikiToken: 'JhiVwgfoIimAqEk8YwEc09sknGd',
          tableName: source.tableName,
          auth,
        });
        return fetchBitableRecords(this.http, {
          ...source,
          appToken,
          auth,
          strict: true,
          allowStale: !refresh,
          cacheTtlMs: 300000,
          forceRefresh: refresh,
        });
      };
      const records = await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('变更读取超时')), 35000);
        }),
      ]);
      const snapshot = await readLatestPersistedBitableRecordSnapshot(source);
      const updating =
        !refresh && snapshot && Date.now() - snapshot.fetchedAt >= 300000;
      return {
        range,
        status: updating ? 'stale' : records.length ? 'ready' : 'empty',
        ...(updating ? { message: '后台更新中' } : {}),
        syncedAt: new Date(snapshot?.fetchedAt ?? Date.now()).toISOString(),
        ...map(records),
      };
    } catch {
      const snapshot = await readLatestPersistedBitableRecordSnapshot(source);
      return snapshot
        ? {
            range,
            status: 'stale',
            syncedAt: new Date(snapshot.fetchedAt).toISOString(),
            message: '更新失败，显示上次成功数据',
            ...map(snapshot.records),
          }
        : {
            range,
            status: 'error',
            syncedAt: null,
            message: '变更读取失败，请重试',
            records: [],
            invalid: 0,
          };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
