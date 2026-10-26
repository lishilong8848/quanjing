import { HttpService } from '@nestjs/axios';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  AssessmentKind,
  AssessmentResponse,
} from '../../../shared/monthly-operations-assessment.interface';
import { readEnv } from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../common/feishu/bitable-direct-read';
import { addDays, resourceRange } from './monthly-operations-resources.model';
import { mapAssessment } from './monthly-operations-assessment.model';
import { mapOpenRisks } from './monthly-operations-open-risks.model';
export const ASSESSMENT_SOURCES = {
  risk: {
    tableId: 'tbl863dea72c2e81',
    tableName: '智航风险排查',
    fieldNames: [
      '风险排查编码',
      '楼栋',
      '应完成条目',
      '排查完成数量',
      '审核完成数量',
      '排查率',
      '完成率',
      '审核截止时间',
      '审核截止时间-文本',
    ],
  },
  drill: {
    tableId: 'tbl3c13aafddd198',
    tableName: '智航演练',
    fieldNames: [
      '编码',
      '计划ID',
      '计划编号',
      '专业',
      '实施区域',
      '演练场景',
      '演练类别',
      '演练类型',
      '计划演练时间',
      '计划结束时间',
      '实际演练时间',
      '审批状态',
      '执行状态',
      '演练状态',
      '是否逾期',
      '演练评分',
      '最后更新',
    ],
  },
  event: {
    tableId: 'tbl3a6abd79ebe36',
    tableName: '智航事件',
    fieldNames: [
      '事件ID',
      '事件编号',
      '事件标题',
      '最高等级',
      '当前等级',
      '真实事件',
      '告警状态',
      '处理状态',
      '事件状态',
      '事件类型',
      '位置',
      '发生时间',
      '通知时间',
      '响应时间',
      '确认时间',
      '创建时间',
      '恢复时间',
      '解决时间',
      '事件描述',
      '记录更新时间',
    ],
  },
  inspection: {
    tableId: 'tblf51376b595c94',
    tableName: '智航巡检',
  },
} as const;
const OPEN_RISK_SOURCE = {
  tableId: 'tbl07ee68bd218ee',
  viewId: 'vew7yV6HbG',
  tableName: '智航OPEN风险项',
  fieldNames: [
    '楼栋名称',
    '风险项编号',
    '风险等级',
    '一级分类',
    '二级分类',
    '三级分类',
    '检查项_描述',
  ],
} as const;
const RISK_INSPECTION_SOURCE = {
  tableId: 'tbl64acce602916f',
  tableName: '智航风险排查明细',
  fieldNames: [
    '风险编号',
    '楼栋',
    '排查状态',
    '当前风险状态',
    '风险现场情况',
    '记录创建时间',
  ],
} as const;
@Injectable()
export class MonthlyOperationsAssessmentService {
  constructor(@Inject(HttpService) private readonly http: HttpService) {}
  async get(
    kind: unknown,
    start: unknown,
    end: unknown,
    refresh = false,
  ): Promise<AssessmentResponse> {
    if (typeof kind !== 'string' || !Object.hasOwn(ASSESSMENT_SOURCES, kind))
      throw new BadRequestException('无效考核类型');
    const key = kind as AssessmentKind,
      range = resourceRange(start, end);
    const filter =
      key === 'event'
        ? {
            conjunction: 'and' as const,
            conditions: [
              {
                field_name: '发生时间',
                operator: 'isGreater',
                value: [
                  'ExactDate',
                  String(
                    Date.parse(addDays(range.start, -1) + 'T00:00:00+08:00'),
                  ),
                ],
              },
              {
                field_name: '发生时间',
                operator: 'isLess',
                value: [
                  'ExactDate',
                  String(Date.parse(addDays(range.end, 1) + 'T00:00:00+08:00')),
                ],
              },
            ],
          }
        : key === 'inspection' &&
            range.start.slice(0, 4) === range.end.slice(0, 4)
          ? {
              conjunction: 'and' as const,
              conditions: [
                {
                  field_name: '计划区间',
                  operator: 'contains',
                  value: [
                    (range.start.slice(0, 7) === range.end.slice(0, 7)
                      ? range.start.slice(0, 7)
                      : range.start.slice(0, 4)
                    ).replaceAll('-', '/'),
                  ],
                },
              ],
            }
          : undefined;
    const source = {
      ...ASSESSMENT_SOURCES[key],
      ...(filter ? { filter } : {}),
    };
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
    const riskDeadline = Date.now() + 35000;
    const riskDetails =
      key === 'risk'
        ? Promise.allSettled([
            fetchBitableRecords(this.http, {
              ...OPEN_RISK_SOURCE,
              appToken: 'IrIibPkUOa6udGsMhu2cbOqhnWg',
              auth,
              strict: true,
              allowStale: !refresh,
              cacheTtlMs: 300000,
              forceRefresh: refresh,
            }),
            fetchBitableRecords(this.http, {
              ...RISK_INSPECTION_SOURCE,
              appToken: 'IrIibPkUOa6udGsMhu2cbOqhnWg',
              auth,
              strict: true,
              allowStale: !refresh,
              cacheTtlMs: 300000,
              forceRefresh: refresh,
            }),
          ])
        : null;
    const project = (records: Parameters<typeof mapAssessment>[1]) => {
      const mapped = mapAssessment(key, records);
      return {
        ...mapped,
        records: mapped.records.filter(
          (r) => r.date && r.date >= range.start && r.date <= range.end,
        ),
      };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let riskTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const records = await Promise.race([
        fetchBitableRecords(this.http, {
          ...source,
          appToken: 'IrIibPkUOa6udGsMhu2cbOqhnWg',
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
      const riskRows = riskDetails
        ? await Promise.race([
            riskDetails,
            new Promise<null>((resolve) => {
              riskTimer = setTimeout(
                () => resolve(null),
                Math.max(0, riskDeadline - Date.now()),
              );
            }),
          ])
        : null;
      const open = riskRows?.[0];
      const inspections = riskRows?.[1];
      const riskResult = !riskDetails
        ? {}
        : open?.status === 'fulfilled'
          ? {
              openRisks: mapOpenRisks(
                open.value,
                inspections?.status === 'fulfilled' ? inspections.value : [],
                range.start,
                range.asOf,
              ).map((item) =>
                inspections?.status === 'fulfilled'
                  ? item
                  : { ...item, inspectionStatus: '排查记录暂不可用' },
              ),
              openRiskStatus: {
                status:
                  inspections?.status === 'fulfilled'
                    ? ('ready' as const)
                    : ('stale' as const),
                syncedAt: new Date().toISOString(),
                ...(inspections?.status === 'fulfilled'
                  ? {}
                  : { message: '本期排查记录读取失败，请刷新重试' }),
              },
            }
          : {
              openRisks: [],
              openRiskStatus: {
                status: 'error' as const,
                syncedAt: null,
                message: 'OPEN 风险清单读取失败，请重试',
              },
            };
      return {
        kind: key,
        range,
        status: updating ? 'stale' : result.records.length ? 'ready' : 'empty',
        ...(updating ? { message: '后台更新中' } : {}),
        syncedAt: new Date(snapshot?.fetchedAt ?? Date.now()).toISOString(),
        ...result,
        ...riskResult,
      };
    } catch {
      const snapshot = await readLatestPersistedBitableRecordSnapshot(source);
      return snapshot
        ? {
            kind: key,
            range,
            status: 'stale',
            syncedAt: new Date(snapshot.fetchedAt).toISOString(),
            message: '更新失败，显示上次成功数据',
            ...project(snapshot.records),
          }
        : {
            kind: key,
            range,
            status: 'error',
            syncedAt: null,
            message: '读取失败，请重试',
            records: [],
            invalid: 0,
          };
    } finally {
      if (timer) clearTimeout(timer);
      if (riskTimer) clearTimeout(riskTimer);
    }
  }
}
