import { HttpService } from '@nestjs/axios';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  MaintenanceResponse,
  MaintenanceType,
} from '../../../shared/monthly-operations-maintenance.interface';
import { readEnv } from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../common/feishu/bitable-direct-read';
import { resourceRange } from './monthly-operations-resources.model';
import { mapMaintenance } from './monthly-operations-maintenance.model';
const common = [
  '维护总项',
  '维护项目',
  '专业类别',
  '类别',
  '楼栋',
  '维护周期',
  '计划开始维护时间',
  '计划结束维护时间',
  '实际开始时间',
  '实际结束时间',
  '备注',
  '更新时间',
];
export const MAINTENANCE_SOURCES = {
  planned: {
    tableId: 'tblzk7WrXxNWQy6V',
    tableName: '计划性维护推进',
    fieldNames: [...common, '维护编号', '维护实施状态', '维护实施状态（新）'],
  },
  unplanned: {
    tableId: 'tbl4Yh8Uye8bjLls',
    tableName: '非计划性维护推进',
    fieldNames: [...common, '维护状态'],
  },
};
@Injectable()
export class MonthlyOperationsMaintenanceService {
  constructor(@Inject(HttpService) private readonly http: HttpService) {}
  async get(
    kind: unknown,
    start: unknown,
    end: unknown,
    refresh = false,
  ): Promise<MaintenanceResponse> {
    if (kind !== 'planned' && kind !== 'unplanned')
      throw new BadRequestException('维护类型无效');
    const key = kind as MaintenanceType,
      source = MAINTENANCE_SOURCES[key],
      range = resourceRange(start, end);
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
    const project = (items: Parameters<typeof mapMaintenance>[1]) => {
      const result = mapMaintenance(key, items);
      return {
        ...result,
        records: result.records.filter(
          (r) => r.date && r.date >= range.start && r.date <= range.end,
        ),
      };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const records = await Promise.race([
        fetchBitableRecords(this.http, {
          ...source,
          appToken: 'HU38bc1vnamMK9sCeOgclUvXnFc',
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
        kind: key,
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
            kind: key,
            range,
            status: 'stale',
            message: '更新失败，显示上次成功数据',
            syncedAt: new Date(snapshot.fetchedAt).toISOString(),
            ...project(snapshot.records),
          }
        : {
            kind: key,
            range,
            status: 'error',
            message: '维护数据读取失败，请重试',
            syncedAt: null,
            records: [],
            invalid: 0,
          };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
